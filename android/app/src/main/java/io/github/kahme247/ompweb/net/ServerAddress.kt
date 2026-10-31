package io.github.kahme247.ompweb.net

/**
 * A validated ompweb server address.
 *
 * [scheme] is `http` or `https`, [host] never contains brackets, and [port]
 * is always explicit. [origin] is safe to concatenate with API paths.
 */
data class ServerAddress(
    val scheme: String,
    val host: String,
    val port: Int = DEFAULT_PORT,
) {
    val origin: String
        get() {
            val renderedHost = if (host.contains(':')) "[$host]" else host
            return "$scheme://$renderedHost:$port"
        }

    fun apiUrl(path: String): String = "$origin/${path.trimStart('/')}"

    companion object {
        const val DEFAULT_PORT = 30177

        /** The one wording for a refused plain-HTTP address. */
        const val PLAIN_HTTP_MESSAGE =
            "Plain HTTP is only allowed for local or private network addresses. Use https:// for this host."

        /**
         * Parses what people actually type into the app:
         * `100.64.0.10`, `100.64.0.10:30177`, `host`, `host.tailnet.ts.net`,
         * full `http://` / `https://` URLs and bracketed IPv6 literals.
         *
         * This is the host-name pre-check: plain HTTP is accepted only for
         * loopback, RFC 1918, CGNAT (100.64.0.0/10), link-local, `.local`,
         * single-label hosts and Tailscale MagicDNS (`*.ts.net`). The binding
         * decision is made on the resolved peer address in
         * [HttpPolicyInterceptor], because a name alone cannot prove that the
         * server sits on a private network.
         */
        fun parse(raw: String): ServerAddressResult {
            val input = raw.trim()
            if (input.isEmpty()) return ServerAddressResult.Invalid("Enter a server address.")
            if (input.length > 512) return ServerAddressResult.Invalid("The address is too long.")
            if (input.any { it.isWhitespace() }) {
                return ServerAddressResult.Invalid("The address must not contain spaces.")
            }
            if (input.any { it.code < 0x20 || it.code == 0x7f }) {
                return ServerAddressResult.Invalid("The address contains characters that are not allowed.")
            }

            val schemeSeparator = input.indexOf("://")
            val explicitScheme = if (schemeSeparator > 0) {
                val candidate = input.substring(0, schemeSeparator)
                if (!SCHEME_NAME.matches(candidate)) {
                    return ServerAddressResult.Invalid("Enter a server address.")
                }
                candidate.lowercase().also { scheme ->
                    if (scheme != "http" && scheme != "https") {
                        return ServerAddressResult.Invalid("Only http:// and https:// addresses are supported.")
                    }
                }
            } else {
                null
            }
            // A copied browser URL usually ends in the root path `/`; that one
            // trailing slash is not a path and is accepted (nothing deeper is).
            val authority = (if (explicitScheme != null) {
                input.substring(schemeSeparator + 3)
            } else {
                input
            }).removeSuffix("/")

            when {
                authority.isEmpty() -> return ServerAddressResult.Invalid("Enter a server address.")
                authority.contains('/') ->
                    return ServerAddressResult.Invalid("The address must not contain a path.")
                authority.contains('?') ->
                    return ServerAddressResult.Invalid("The address must not contain a query.")
                authority.contains('#') ->
                    return ServerAddressResult.Invalid("The address must not contain a fragment.")
                authority.contains('@') ->
                    return ServerAddressResult.Invalid("Do not include a username or password in the address.")
            }

            val parts = when (val split = splitHostAndPort(authority)) {
                is HostAndPort -> split
                is HostPortError -> return ServerAddressResult.Invalid(split.message)
            }

            val host = parts.host.lowercase().removeSuffix(".")
            if (host.isEmpty()) return ServerAddressResult.Invalid("Enter a server address.")

            val port = parts.portText?.let { portText ->
                val value = portText.toIntOrNull()
                if (value == null || value !in 1..65535) {
                    return ServerAddressResult.Invalid("The port must be a number between 1 and 65535.")
                }
                value
            } ?: DEFAULT_PORT

            val hostError = validateHost(host)
            if (hostError != null) return ServerAddressResult.Invalid(hostError)

            val scheme = explicitScheme ?: defaultScheme(host)
            if (scheme == "http" && defaultScheme(host) == "https") {
                return ServerAddressResult.Invalid(PLAIN_HTTP_MESSAGE)
            }

            return ServerAddressResult.Valid(ServerAddress(scheme = scheme, host = host, port = port))
        }

        private val SCHEME_NAME = Regex("[A-Za-z][A-Za-z0-9+.-]*")

        private sealed interface HostPortSplit
        private data class HostAndPort(val host: String, val portText: String?) : HostPortSplit
        private data class HostPortError(val message: String) : HostPortSplit

        private fun splitHostAndPort(authority: String): HostPortSplit {
            if (authority.startsWith("[")) {
                val close = authority.indexOf(']')
                if (close < 0) {
                    return HostPortError("Close the IPv6 address with a bracket, for example [fd7a::1]:30177.")
                }
                val host = authority.substring(1, close)
                if (!isIpv6(host)) return HostPortError("That is not a valid IPv6 address.")
                val tail = authority.substring(close + 1)
                return when {
                    tail.isEmpty() -> HostAndPort(host, null)
                    tail.startsWith(":") -> HostAndPort(host, tail.substring(1))
                    else -> HostPortError("Use only :port after the IPv6 bracket.")
                }
            }
            return when (authority.count { it == ':' }) {
                0 -> HostAndPort(authority, null)
                1 -> HostAndPort(authority.substringBefore(':'), authority.substringAfter(':'))
                else -> HostPortError("Put an IPv6 address in brackets, for example [fd7a::1]:30177.")
            }
        }

        private fun validateHost(host: String): String? {
            if (isIpv6(host) || isIpv4(host)) return null
            if (host.length > 253) return "The host name is too long."
            val labels = host.split('.')
            if (labels.any { label ->
                    label.isEmpty() ||
                        label.length > 63 ||
                        label.first() == '-' ||
                        label.last() == '-' ||
                        label.any { !it.isLetterOrDigit() && it != '-' }
                }
            ) {
                return "The address contains characters that are not valid in a host name."
            }
            return null
        }

        private fun isIpv4(host: String): Boolean {
            val parts = host.split('.')
            if (parts.size != 4) return false
            return parts.all { part ->
                part.isNotEmpty() &&
                    part.length <= 3 &&
                    part.all(Char::isDigit) &&
                    part.toInt() in 0..255
            }
        }

        private fun isIpv6(host: String): Boolean {
            if (!host.contains(':')) return false
            return try {
                java.net.InetAddress.getByName(host)
                true
            } catch (_: Exception) {
                false
            }
        }

        private fun defaultScheme(host: String): String {
            if (isIpv4(host)) {
                val octets = host.split('.').map(String::toInt)
                val privateIpv4 = octets[0] == 127 ||
                    octets[0] == 10 ||
                    (octets[0] == 192 && octets[1] == 168) ||
                    (octets[0] == 172 && octets[1] in 16..31) ||
                    (octets[0] == 100 && octets[1] in 64..127) ||
                    (octets[0] == 169 && octets[1] == 254)
                return if (privateIpv4) "http" else "https"
            }
            if (isIpv6(host)) {
                val firstHextet = host.removePrefix("[").substringBefore(':').ifEmpty { "0" }
                val value = firstHextet.toIntOrNull(16) ?: 0xffff
                val linkLocal = value and 0xffc0 == 0xfe80
                val uniqueLocal = value and 0xfe00 == 0xfc00
                val loopback = host == "::1" || host == "0:0:0:0:0:0:0:1"
                return if (loopback || linkLocal || uniqueLocal) "http" else "https"
            }
            val lower = host.lowercase()
            return if (
                lower == "localhost" ||
                lower.endsWith(".localhost") ||
                lower.endsWith(".local") ||
                lower.endsWith(".ts.net")
            ) {
                "http"
            } else if (!lower.contains('.')) {
                "http"
            } else {
                "https"
            }
        }

        /**
         * The host-name pre-check of the plain-HTTP policy, shared with
         * [HttpPolicyInterceptor]; the network layer additionally requires
         * every resolved peer address to be private.
         */
        fun allowsPlainHttp(host: String): Boolean = defaultScheme(host) == "http"
    }
}

sealed interface ServerAddressResult {
    data class Valid(val address: ServerAddress) : ServerAddressResult
    data class Invalid(val message: String) : ServerAddressResult
}
