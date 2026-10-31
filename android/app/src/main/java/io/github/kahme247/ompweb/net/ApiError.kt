package io.github.kahme247.ompweb.net

import java.io.IOException

/**
 * Every failure an API call can produce, in the terms the UI needs.
 *
 * [Unauthorized] is reported globally (the app returns to the password screen)
 * as well as to the caller; [ServerMisconfigured] is a server-side setup
 * problem that retrying cannot fix.
 */
sealed class ApiError(message: String, cause: Throwable? = null) : Exception(message, cause) {

    /** 401: the session cookie is missing, expired or invalid. */
    class Unauthorized(val body: String) : ApiError("Not signed in")

    /** 503: ompweb is running, but its password configuration is broken. */
    class ServerMisconfigured(val body: String) : ApiError("Server is misconfigured")

    /**
     * `session_slow`: omp is busy (it blocks its event loop for tens of
     * seconds on large sessions) and did not answer in time. The session and
     * its run keep going — callers retry later, they never treat this as the
     * run ending or as a fatal error. On a prompt ack timeout
     * [maybeStarted] is true: the frame may already be running, so the send
     * stays locked until a frame or a successful state snapshot arrives.
     * On an abort timeout [abortUnconfirmed] is true: neither the stop nor the
     * run state is known, so the UI must not claim the run ended.
     */
    class SessionSlow(
        val serverMessage: String?,
        val maybeStarted: Boolean = false,
        val abortUnconfirmed: Boolean = false,
        /**
         * The run state from the 503 body: `false` means no turn is in flight —
         * the child is alive but only blocked (a fresh spawn loading a large
         * session answers `get_state` too late) — so the poll must settle the
         * run instead of keeping it marked. `null` = the server does not report
         * it (older build); the caller then bounds the unknown window.
         */
        val running: Boolean? = null,
    ) : ApiError(serverMessage ?: "The agent is busy")

    /**
     * 409 `session_running_elsewhere`: another omp process owns this session,
     * so the server refused to spawn a writer. The chat is not broken and the
     * text was not sent — the composer keeps the draft, the screen shows the
     * foreign-owner banner and only an explicit "send anyway (copy)" retries
     * with `?force=1`. [elsewhere] is the owner report from the body (null if
     * the body was unreadable).
     */
    class SessionRunningElsewhere(val elsewhere: ElsewhereSession?) :
        ApiError("Another omp process is running this session")

    /** 403: the origin gate or a proxy refused the request. */
    class Forbidden(val body: String) : ApiError("Request refused")

    /** No server origin is configured (the user is on "change server"). */
    data object NotConfigured : ApiError("No server origin is configured")

    /** No answer: DNS, connection, TLS or a timeout. */
    class Network(cause: IOException) : ApiError("Cannot reach the server", cause)

    /**
     * A non-2xx answer whose JSON body carries a stable `code`/`error` pair,
     * as the project, archive, clone and session routes send it. The UI can
     * localize these; the status stays available for branching.
     */
    class ServerResponse(
        val status: Int,
        val code: String?,
        val serverMessage: String?,
    ) : ApiError(serverMessage ?: "HTTP $status")

    /** Any other non-2xx status. */
    class Http(val code: Int, val body: String) : ApiError("HTTP $code")
}

/**
 * The one user-facing wording for API failures. Every screen shows these
 * strings; localized variants would go here instead of being copied per view
 * model (the copies had already started to drift).
 */
fun ApiError.userMessage(): String = when (this) {
    is ApiError.ServerResponse -> serverMessage ?: code ?: "HTTP $status"
    is ApiError.Http -> "HTTP $code"
    is ApiError.Network -> "Cannot reach the server"
    is ApiError.Forbidden -> "Not allowed"
    is ApiError.ServerMisconfigured -> "The server needs configuration"
    is ApiError.SessionSlow ->
        serverMessage ?: "The agent is busy and did not answer in time. It is still running — try again in a moment."
    is ApiError.SessionRunningElsewhere ->
        "Another omp process is running this chat. Sending would create a copy — your message was not sent."
    is ApiError.Unauthorized -> "The session expired; sign in again"
    is ApiError.NotConfigured -> "No server configured"
}

/** [ApiError.userMessage] for any throwable; non-API failures fall back to their message. */
fun Throwable.userMessage(): String = (this as? ApiError)?.userMessage() ?: message ?: "Request failed"
