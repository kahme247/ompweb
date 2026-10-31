package io.github.kahme247.ompweb.domain

import java.net.URLDecoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/**
 * The OAuth login flow of `GET /api/auth/login/{provider}` as a pure state
 * machine, ported from `ModelsConfig.tsx` (`OAuthDetail`) plus the Android-specific
 * loopback detection.
 *
 * The server streams SSE frames: `auth`, `device_code`, `prompt_request`,
 * `select_request`, `progress`, `success`, `error`, `cancelled`
 * (`app/api/auth/login/[provider]/route.ts`). The user's answer goes back with
 * `POST /api/auth/login/{provider} {token, code}`; [OAuthLoginMachine] decides
 * which input the current phase accepts and when the flow is terminal.
 */

/** One option of a `select_request` frame. */
data class OAuthSelectOption(val id: String, val label: String)

/** One parsed SSE frame of the login stream. */
sealed interface OAuthFrame {
    /** The provider's authorization URL plus the token the answer must carry. */
    data class Auth(val url: String, val instructions: String?, val token: String) : OAuthFrame

    /** Device-code providers: show [userCode], open [verificationUri], poll happens server-side. */
    data class DeviceCode(
        val userCode: String,
        val verificationUri: String,
        val intervalSeconds: Int?,
        val expiresInSeconds: Int?,
    ) : OAuthFrame

    /** The provider asks for a pasted code or redirect URL. */
    data class PromptRequest(val message: String, val placeholder: String?, val token: String) : OAuthFrame

    /** The provider asks the user to pick one of several accounts/organizations. */
    data class SelectRequest(
        val message: String,
        val options: List<OAuthSelectOption>,
        val token: String,
    ) : OAuthFrame

    /** Progress text from omp (`notify` frames). */
    data class Progress(val message: String) : OAuthFrame

    data object Success : OAuthFrame

    data class Failed(val message: String) : OAuthFrame

    data object Cancelled : OAuthFrame
}

private val oauthJson = Json {
    ignoreUnknownKeys = true
    isLenient = true
}

private fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

private fun JsonObject.int(key: String): Int? = (this[key] as? JsonPrimitive)?.intOrNull

/**
 * Parses one `data:` payload of the login stream. Malformed JSON, unknown
 * frame types and frames missing their required field are dropped (`null`), so
 * a broken frame never tears the flow down — exactly like the web handler.
 */
fun parseOAuthFrame(data: String): OAuthFrame? {
    val root = try {
        oauthJson.parseToJsonElement(data)
    } catch (_: Exception) {
        return null
    } as? JsonObject ?: return null
    return when (root.string("type")) {
        "auth" -> {
            val url = root.string("url")?.takeIf { it.isNotBlank() } ?: return null
            OAuthFrame.Auth(
                url = url,
                instructions = root.string("instructions")?.takeIf { it.isNotBlank() },
                token = root.string("token").orEmpty(),
            )
        }
        "device_code" -> {
            val userCode = root.string("userCode")?.takeIf { it.isNotBlank() } ?: return null
            val uri = root.string("verificationUri")?.takeIf { it.isNotBlank() } ?: return null
            OAuthFrame.DeviceCode(
                userCode = userCode,
                verificationUri = uri,
                intervalSeconds = root.int("intervalSeconds"),
                expiresInSeconds = root.int("expiresInSeconds"),
            )
        }
        "prompt_request" -> OAuthFrame.PromptRequest(
            message = root.string("message")?.takeIf { it.isNotBlank() } ?: return null,
            placeholder = root.string("placeholder")?.takeIf { it.isNotBlank() },
            token = root.string("token").orEmpty(),
        )
        "select_request" -> {
            val options = (root["options"] as? JsonArray).orEmpty().mapNotNull { element ->
                val option = element as? JsonObject ?: return@mapNotNull null
                val id = option.string("id")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
                OAuthSelectOption(id = id, label = option.string("label")?.takeIf { it.isNotBlank() } ?: id)
            }
            OAuthFrame.SelectRequest(
                message = root.string("message")?.takeIf { it.isNotBlank() } ?: return null,
                options = options,
                token = root.string("token").orEmpty(),
            )
        }
        "progress" -> OAuthFrame.Progress(root.string("message").orEmpty())
        "success" -> OAuthFrame.Success
        "error" -> OAuthFrame.Failed(root.string("message").orEmpty())
        "cancelled" -> OAuthFrame.Cancelled
        else -> null
    }
}

/** What the login panel renders. Mirrors the web's `OAuthLoginState` union. */
sealed interface OAuthLoginState {
    data object Idle : OAuthLoginState

    /** The stream is being opened; omp has not answered yet. */
    data object Connecting : OAuthLoginState

    data class Auth(val url: String, val instructions: String?, val token: String) : OAuthLoginState

    data class DeviceCode(
        val userCode: String,
        val verificationUri: String,
        val intervalSeconds: Int?,
        val expiresInSeconds: Int?,
    ) : OAuthLoginState

    data class Prompt(val message: String, val placeholder: String?, val token: String) : OAuthLoginState

    data class Select(
        val message: String,
        val options: List<OAuthSelectOption>,
        val token: String,
    ) : OAuthLoginState

    /** The answer was posted and the server is verifying it. */
    data object Submitting : OAuthLoginState

    data class Progress(val message: String) : OAuthLoginState

    data object Success : OAuthLoginState

    /** [message] is the server's text; blank means "show the generic failure". */
    data class Error(val message: String) : OAuthLoginState

    /** The stream ended without a terminal frame (server restart, network loss). */
    data object TransportLost : OAuthLoginState
}

/** Whether the flow still owns a stream / expects user interaction. */
val OAuthLoginState.isWorking: Boolean
    get() = when (this) {
        OAuthLoginState.Idle, OAuthLoginState.Success, is OAuthLoginState.Error, OAuthLoginState.TransportLost -> false
        else -> true
    }

/** The value the panel's paste field submits (the token the frame carried). */
val OAuthLoginState.submitToken: String?
    get() = when (this) {
        is OAuthLoginState.Auth -> token
        is OAuthLoginState.Prompt -> token
        is OAuthLoginState.Select -> token
        else -> null
    }

/**
 * The login flow's transitions. Immutable so a view model can hand it to the
 * UI without copies of mutable state; terminal states ignore later frames the
 * same way the web closes its `EventSource` on success/error.
 */
data class OAuthLoginMachine(val state: OAuthLoginState = OAuthLoginState.Idle) {

    fun start(): OAuthLoginMachine = copy(state = OAuthLoginState.Connecting)

    /** Cancel is local: closing the stream makes the server dispose its child. */
    fun cancel(): OAuthLoginMachine = copy(state = OAuthLoginState.Idle)

    /** The user (or a Select row) posted an answer; the server verifies it now. */
    fun submitting(): OAuthLoginMachine =
        if (state.submitToken == null) this else copy(state = OAuthLoginState.Submitting)

    fun onFrame(frame: OAuthFrame): OAuthLoginMachine = when (frame) {
        is OAuthFrame.Auth ->
            if (isTerminal()) this else copy(state = OAuthLoginState.Auth(frame.url, frame.instructions, frame.token))
        is OAuthFrame.DeviceCode ->
            if (isTerminal()) this
            else copy(
                state = OAuthLoginState.DeviceCode(
                    userCode = frame.userCode,
                    verificationUri = frame.verificationUri,
                    intervalSeconds = frame.intervalSeconds,
                    expiresInSeconds = frame.expiresInSeconds,
                ),
            )
        is OAuthFrame.PromptRequest ->
            if (isTerminal()) this
            else copy(state = OAuthLoginState.Prompt(frame.message, frame.placeholder, frame.token))
        is OAuthFrame.SelectRequest ->
            if (isTerminal()) this
            else copy(state = OAuthLoginState.Select(frame.message, frame.options, frame.token))
        is OAuthFrame.Progress ->
            if (isTerminal()) this else copy(state = OAuthLoginState.Progress(frame.message))
        OAuthFrame.Success -> copy(state = OAuthLoginState.Success)
        is OAuthFrame.Failed -> copy(state = OAuthLoginState.Error(frame.message))
        // A server-side cancel only happens for a flow this panel owns; the
        // user's own Cancel already moved to Idle before the frame could arrive.
        OAuthFrame.Cancelled -> copy(state = OAuthLoginState.Idle)
    }

    /** `POST` refused the answer (expired token, wrong provider, network error). */
    fun submitFailed(message: String): OAuthLoginMachine = copy(state = OAuthLoginState.Error(message))

    /** The SSE connection ended; settled screens (success, error) stay as they are. */
    fun streamEnded(): OAuthLoginMachine = when (state) {
        OAuthLoginState.Success, is OAuthLoginState.Error -> this
        else -> copy(state = OAuthLoginState.TransportLost)
    }

    /** 401/403 from the stream request itself: the panel is not signed in. */
    fun streamFailed(message: String): OAuthLoginMachine =
        if (state == OAuthLoginState.Success) this else copy(state = OAuthLoginState.Error(message))

    private fun isTerminal(): Boolean =
        state == OAuthLoginState.Success || state is OAuthLoginState.Error || state == OAuthLoginState.TransportLost
}

/** A callback target that points at the phone's own loopback interface. */
data class LoopbackCallback(val host: String, val port: Int?)

private val IPV4 = Regex("""^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$""")

/** `localhost`, `*.localhost`, `127.0.0.0/8`, `0.0.0.0` and `::1`. */
fun isLoopbackHost(host: String): Boolean {
    val normalized = host.trim().lowercase().removePrefix("[").removeSuffix("]").substringBefore('%')
    if (normalized.isEmpty()) return false
    if (normalized == "localhost" || normalized.endsWith(".localhost")) return true
    if (normalized == "::1" || normalized == "::" || normalized == "0.0.0.0") return true
    val match = IPV4.matchEntire(normalized) ?: return false
    val octets = match.groupValues.drop(1).map { it.toIntOrNull() ?: return false }
    if (octets.any { it > 255 }) return false
    // 127.0.0.0/8 is the whole IPv4 loopback block; 0.0.0.0 is "this host".
    return octets[0] == 127 || octets.all { it == 0 }
}

/**
 * Returns the loopback target of [url] when the phone itself cannot complete
 * the flow, or `null` for a normal public URL.
 *
 * Two shapes count:
 * - the URL's own host is loopback (`http://localhost:1455/auth/callback?code=…`);
 * - the URL's `redirect_uri`/`redirect_url` query parameter is loopback, i.e.
 *   the provider will send the browser to a server that runs on the PC.
 *
 * The web UI can open both in a browser on the same machine; a phone would
 * open its own loopback and land on a dead port, so the panel explains that
 * the flow must be finished on the PC and accepts the pasted redirect URL.
 */
fun loopbackCallbackTarget(url: String): LoopbackCallback? {
    val trimmed = url.trim()
    if (trimmed.isEmpty()) return null
    val schemeEnd = trimmed.indexOf("://")
    if (schemeEnd <= 0) return null
    val afterScheme = trimmed.substring(schemeEnd + 3)
    val authority = afterScheme.substringBefore('/').substringBefore('?').substringBefore('#')
    if (authority.isEmpty()) return null
    val ownTarget = parseHostPort(authority.substringAfterLast('@'))
    if (ownTarget != null && isLoopbackHost(ownTarget.host)) return ownTarget

    val query = afterScheme.substringAfter('?', "").substringBefore('#')
    for (pair in query.split('&')) {
        val separator = pair.indexOf('=')
        if (separator <= 0) continue
        val key = pair.substring(0, separator)
        if (key != "redirect_uri" && key != "redirect_url" && key != "callback") continue
        val decoded = decodeQueryValue(pair.substring(separator + 1)) ?: continue
        val nested = loopbackCallbackTarget(decoded) ?: continue
        return nested
    }
    return null
}

private fun decodeQueryValue(raw: String): String? = try {
    URLDecoder.decode(raw.replace("+", "%2B"), "UTF-8")
} catch (_: Exception) {
    null
}

private fun parseHostPort(authority: String): LoopbackCallback? {
    if (authority.isEmpty()) return null
    if (authority.startsWith("[")) {
        val close = authority.indexOf(']')
        if (close < 0) return null
        val host = authority.substring(1, close)
        val portText = authority.substring(close + 1).removePrefix(":")
        return LoopbackCallback(host, portText.toIntOrNull())
    }
    val host = authority.substringBefore(':')
    val portText = authority.substringAfter(':', "")
    return LoopbackCallback(host, portText.toIntOrNull())
}

/** The loopback target of the current phase, when the phone cannot complete it. */
fun OAuthLoginState.loopbackTarget(): LoopbackCallback? = when (this) {
    is OAuthLoginState.Auth -> loopbackCallbackTarget(url)
    is OAuthLoginState.DeviceCode -> loopbackCallbackTarget(verificationUri)
    else -> null
}
