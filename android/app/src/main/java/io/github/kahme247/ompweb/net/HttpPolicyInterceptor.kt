package io.github.kahme247.ompweb.net

import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import okhttp3.Call
import okhttp3.EventListener
import okhttp3.HttpUrl
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response

/**
 * Enforces the plain-HTTP policy on the wire, not only while parsing the
 * address a user typed.
 *
 * [install] adds the check twice on purpose: as an application interceptor it
 * refuses a public `http://` URL before OkHttp opens a connection, and as a
 * network interceptor it also sees every redirect hop, which an application
 * interceptor never does. A redirect to another origin is refused because the
 * session cookie belongs to one origin; following it would move the request
 * (and its credentials) somewhere the user did not enter. Callers without
 * cookies (the app updater, whose release assets legitimately redirect to a
 * download host) can opt into [allowCrossOriginRedirects]; the scheme policy
 * is still applied to every hop.
 *
 * The host-name check alone would trust `.local` and `*.ts.net` names, which
 * DNS or mDNS can point at any public address. [PlainHttpPolicyListener]
 * therefore checks the address OkHttp actually connects to and fails the call
 * when a plain-HTTP connection would leave the private network.
 */
class HttpPolicyInterceptor(
    private val allowCrossOriginRedirects: Boolean = false,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val url = chain.request().url
        if (!allowCrossOriginRedirects && !sameOrigin(chain.call().request().url, url)) {
            throw IOException("Cross-origin redirect to ${url.host} was refused.")
        }
        if (url.scheme == "http" && !ServerAddress.allowsPlainHttp(url.host)) {
            throw IOException(PLAIN_HTTP_MESSAGE)
        }
        return chain.proceed(chain.request())
    }

    /**
     * Fails a plain-HTTP call whose peer address is not loopback, RFC 1918,
     * CGNAT (100.64.0.0/10), link-local or an IPv6 unique-local address.
     * `connectStart` runs after DNS resolution and before the socket connects,
     * so this sees the address that would actually receive the request.
     */
    private class PlainHttpPolicyListener : EventListener() {
        override fun connectStart(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy) {
            val url = call.request().url
            if (url.scheme != "http") return
            val peer = inetSocketAddress.address ?: throw IOException(PLAIN_HTTP_MESSAGE)
            if (!isPrivatePeer(peer)) {
                throw IOException(
                    "Plain HTTP is only allowed for local or private network addresses. " +
                        "${url.host} resolved to ${peer.hostAddress}, which is not one.",
                )
            }
        }
    }

    companion object {
        const val PLAIN_HTTP_MESSAGE = ServerAddress.PLAIN_HTTP_MESSAGE

        fun install(
            builder: OkHttpClient.Builder,
            allowCrossOriginRedirects: Boolean = false,
        ): OkHttpClient.Builder = builder
            // A factory, not one shared instance: OkHttp keeps it for the life
            // of the client, and a listener that ever gains a field must not be
            // shared between concurrent calls.
            .eventListenerFactory { PlainHttpPolicyListener() }
            .addInterceptor(HttpPolicyInterceptor(allowCrossOriginRedirects))
            .addNetworkInterceptor(HttpPolicyInterceptor(allowCrossOriginRedirects))

        /** Whether plain HTTP to [address] stays inside a local or private network. */
        fun isPrivatePeer(address: InetAddress): Boolean {
            if (address.isLoopbackAddress || address.isSiteLocalAddress || address.isLinkLocalAddress) {
                return true
            }
            val bytes = address.address
            if (bytes.size == 4) {
                // 100.64.0.0/10, the Tailscale/CGNAT range.
                val first = bytes[0].toInt() and 0xff
                val second = bytes[1].toInt() and 0xff
                return first == 100 && second in 64..127
            }
            if (bytes.size == 16) {
                // fc00::/7 unique-local; loopback and fe80::/10 are covered above.
                return (bytes[0].toInt() and 0xfe) == 0xfc
            }
            return false
        }

        private fun sameOrigin(first: HttpUrl, second: HttpUrl): Boolean =
            first.scheme == second.scheme &&
                first.host.equals(second.host, ignoreCase = true) &&
                first.port == second.port
    }
}
