package io.github.kahme247.ompweb.ui.panels.extension

import io.github.kahme247.ompweb.domain.ClipboardBridge
import io.github.kahme247.ompweb.domain.ClipboardPrompt
import io.github.kahme247.ompweb.domain.ExtensionDialogState
import io.github.kahme247.ompweb.domain.ExtensionNotice
import io.github.kahme247.ompweb.domain.ExtensionNoticeLevel
import io.github.kahme247.ompweb.domain.ExtensionOpenUrlPrompt
import io.github.kahme247.ompweb.domain.ExtensionResponse
import io.github.kahme247.ompweb.domain.ExtensionStatusItem
import io.github.kahme247.ompweb.domain.ExtensionTerminalState
import io.github.kahme247.ompweb.domain.ExtensionUiFrame
import io.github.kahme247.ompweb.domain.ExtensionUiState
import io.github.kahme247.ompweb.domain.ExtensionWidgetItem
import io.github.kahme247.ompweb.domain.HostUriRequest
import io.github.kahme247.ompweb.domain.CLIPBOARD_EMPTY_RESULT
import io.github.kahme247.ompweb.domain.CLIPBOARD_READ_DENIED
import io.github.kahme247.ompweb.domain.CLIPBOARD_UNAVAILABLE_READ
import io.github.kahme247.ompweb.domain.CLIPBOARD_UNAVAILABLE_WRITE
import io.github.kahme247.ompweb.domain.CLIPBOARD_WRITE_FAILED
import io.github.kahme247.ompweb.domain.extensionInputCommand
import io.github.kahme247.ompweb.domain.extensionResponseCommand
import io.github.kahme247.ompweb.domain.hostUriResource
import io.github.kahme247.ompweb.domain.hostUriResultCommand
import io.github.kahme247.ompweb.domain.isSafeOpenUrl
import io.github.kahme247.ompweb.domain.parseExtensionUiFrame
import io.github.kahme247.ompweb.domain.parseHostUriRequest
import io.github.kahme247.ompweb.domain.unknownHostUriResult
import io.github.kahme247.ompweb.net.ExtensionApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * The extension UI of the open session: blocking dialogs (`select`, `confirm`,
 * `input`, `editor`, `ask`), the status bar/widgets, the custom/terminal panel,
 * `extension_ui_input`, and the `pi-web://clipboard` host URI.
 *
 * Frame routing follows `hooks/useAgentSession.ts`: a replayed request keeps
 * one dialog and `cancel` only clears a matching id. Unlike the web, an
 * answered panel closes on the tap instead of 250 ms after the RPC: the route
 * only queues the response (fire-and-forget) yet the round trip on a phone
 * takes seconds, and a panel that stays up that long swallows every further
 * Done/Cancel tap.
 *
 * Host access is consent-gated: `open_url` never opens on its own (the user
 * taps Open on the notice) and clipboard reads are default-deny with a
 * per-session approval. Writes and every read are announced in the chat. While
 * the surface is hidden the prompts wait for the return (`open_url`) or are
 * answered without asking (`host_uri_request`: a read is denied, a write is
 * unavailable), because omp waits for its result either way.
 */
class ExtensionUiController(
    private val api: ExtensionApi,
    private val scope: CoroutineScope,
    private val strings: ExtensionStrings = ExtensionStrings(),
) {
    private val state = ExtensionUiState()

    private val _dialog = MutableStateFlow<ExtensionDialogState?>(null)
    val dialog: StateFlow<ExtensionDialogState?> = _dialog.asStateFlow()

    private val _statusItems = MutableStateFlow<List<ExtensionStatusItem>>(emptyList())
    val statusItems: StateFlow<List<ExtensionStatusItem>> = _statusItems.asStateFlow()

    private val _widgets = MutableStateFlow<List<ExtensionWidgetItem>>(emptyList())
    val widgets: StateFlow<List<ExtensionWidgetItem>> = _widgets.asStateFlow()

    private val _terminal = MutableStateFlow<ExtensionTerminalState?>(null)
    val terminal: StateFlow<ExtensionTerminalState?> = _terminal.asStateFlow()

    private val _notices = MutableSharedFlow<ExtensionNotice>(
        extraBufferCapacity = 16,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    /** In-app notices for the chat's notice bar (`notify`, RPC failures, host access). */
    val notices: SharedFlow<ExtensionNotice> = _notices.asSharedFlow()

    private val _editorText = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val editorText: SharedFlow<String> = _editorText.asSharedFlow()

    private val _clipboardPrompt = MutableStateFlow<ClipboardPrompt?>(null)

    /** A clipboard read waiting for the user's Allow/Deny. */
    val clipboardPrompt: StateFlow<ClipboardPrompt?> = _clipboardPrompt.asStateFlow()

    private val _openUrlPrompt = MutableStateFlow<ExtensionOpenUrlPrompt?>(null)

    /** An `open_url` the user has not confirmed yet; the chat shows Open/Dismiss. */
    val openUrlPrompt: StateFlow<ExtensionOpenUrlPrompt?> = _openUrlPrompt.asStateFlow()

    private var sessionId: String? = null
    /**
     * The session whose panels [state] holds. It outlives [sessionId] while the
     * chat surface is hidden: the chat keeps its live subscription there, so a
     * dialog that arrives in the meantime exists only in this controller (the
     * server replays it only to a *new* subscriber, and the hidden chat's
     * subscription never stopped).
     */
    private var panelSession: String? = null
    /** The response awaiting its RPC; blocks a second answer of the same request. */
    private var submittingId: String? = null
    private var expiryJob: Job? = null
    private var urlOpener: ((String) -> Unit)? = null
    private var clipboard: ClipboardBridge? = null

    /** Sessions the user allowed to read the clipboard; cleared when the chat changes. */
    private val clipboardAllowed = mutableSetOf<String>()

    /** Sessions whose read request the user refused; further reads fail without asking. */
    private val clipboardDenied = mutableSetOf<String>()

    private var clipboardRequest: CompletableDeferred<Boolean>? = null

    /**
     * Attach the panels to one session. The chat changing drops them (another
     * chat's dialog, widget or `open_url` prompt must never appear there, and
     * its answered ids stay known); the surface merely leaving the stage
     * (`null`) keeps them, so a request that arrived while nothing rendered it
     * is still there when the chat comes back — from the list, a notification
     * or a rotation. Only the session itself can settle it then (`cancel`, its
     * own deadline, an answer from another tab).
     */
    fun bind(sessionId: String?) {
        if (this.sessionId == sessionId) return
        this.sessionId = sessionId
        submittingId = null
        answerPendingClipboard(false)
        clipboardAllowed.clear()
        clipboardDenied.clear()
        val now = System.currentTimeMillis()
        if (sessionId != null && sessionId != panelSession) {
            panelSession = sessionId
            state.bindSession()
            cancelExpiry()
            // Another chat: its pending `open_url` must not appear here.
            _openUrlPrompt.value = null
        } else if (state.dialog == null) {
            cancelExpiry()
        } else if (state.expire(now)) {
            cancelExpiry()
        } else {
            // Back on the chat that asked (or still away from it): the pending
            // request kept its own deadline while nothing rendered it.
            scheduleExpiry(now)
        }
        publish()
    }

    /**
     * Forget every panel and every answered id: the signed-in user is being
     * dropped (sign-out, server switch, 401), so nothing of that installation
     * may survive in the heap. [bind] is for the chat surface only.
     */
    fun reset() {
        this.sessionId = null
        panelSession = null
        submittingId = null
        answerPendingClipboard(false)
        clipboardAllowed.clear()
        clipboardDenied.clear()
        cancelExpiry()
        _openUrlPrompt.value = null
        state.reset()
        publish()
    }

    /**
     * Consume one session-channel frame. Returns true for every
     * `extension_ui_request` (even a method this client ignores) and for
     * `host_uri_request`, so the chat engine never mistakes them for transcript
     * frames.
     */
    fun onFrame(frame: JsonObject): Boolean {
        val now = System.currentTimeMillis()
        parseExtensionUiFrame(frame, now)?.let { parsed ->
            apply(parsed, now)
            return true
        }
        val uri = parseHostUriRequest(frame) ?: return false
        handleHostUri(uri)
        return true
    }

    /**
     * Answer the shown dialog; the request id rides in the response.
     *
     * The panel closes on this tap, not on the RPC's answer. The route does not
     * acknowledge the response (`extension_ui_response` only goes into the
     * write queue), yet a phone on a tunnel still waits seconds for the round
     * trip (far longer when the session has to be started first). While the
     * panel stayed up it looked untouched and swallowed every further tap —
     * Done and Cancel alike — so the user pressed again and again. The request
     * is claimed before the send (its reconnect replay is filtered), it is sent
     * exactly once, and a failed send puts the same panel back — but only in
     * the session that asked, and only while the request has not expired.
     */
    fun respond(response: ExtensionResponse) {
        val id = response.id
        // A second tap on the same request never reaches the wire.
        if (submittingId == id) return
        // No session, no claim: a panel without a chat cannot be answered, and
        // claiming first would burn its id (the replay could not reopen it).
        val sid = sessionId ?: return
        // Only the dialog the user is looking at answers; a replay may have
        // replaced it (or a newer question arrived) since the tap.
        val request = state.dialog?.takeIf { it.id == id } ?: return
        if (!state.claimAnswer(request)) return
        submittingId = id
        publish()
        scope.launch {
            try {
                api.command(sid, extensionResponseCommand(response))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                // The tap never reached omp: bring the panel back so the answer
                // can be repeated, and say why. Only while the panels still
                // belong to the session that asked: after a switch the old
                // panel belongs to another chat and must not appear there, but
                // a chat that merely left the stage keeps it (its subscription
                // never stopped, so no replay would bring it back). An expired
                // request stays gone (the server settled it), and a newer
                // dialog keeps the screen.
                if (panelSession == sid) {
                    val now = System.currentTimeMillis()
                    if (state.restore(request, now)) {
                        publish()
                        scheduleExpiry(now)
                    }
                }
                notice(error.message ?: "Unable to answer the extension dialog", ExtensionNoticeLevel.Error)
            } finally {
                if (submittingId == id) submittingId = null
            }
        }
    }

    /** `extension_ui_input` for the open custom/terminal panel. */
    fun sendInput(data: JsonElement) {
        val sid = sessionId ?: return
        val id = state.terminal?.id ?: return
        scope.launch {
            try {
                api.command(sid, extensionInputCommand(id, data))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                notice(error.message ?: "Unable to send extension input", ExtensionNoticeLevel.Error)
            }
        }
    }

    /** The user allowed the shown clipboard read. */
    fun approveClipboardRead() {
        val pending = clipboardRequest ?: return
        clipboardRequest = null
        _clipboardPrompt.value = null
        sessionId?.let { clipboardAllowed += it }
        pending.complete(true)
    }

    /** The user refused the shown clipboard read; later reads of this chat fail without asking. */
    fun denyClipboardRead() {
        val pending = clipboardRequest ?: return
        clipboardRequest = null
        _clipboardPrompt.value = null
        sessionId?.let { clipboardDenied += it }
        pending.complete(false)
    }

    /** Hand the pending `open_url` to the system (the notice's Open action). */
    fun openUrlNow() {
        val prompt = _openUrlPrompt.value ?: return
        _openUrlPrompt.value = null
        if (!isSafeOpenUrl(prompt.url)) {
            notice(strings.unsafeUrlBlocked(prompt.url), ExtensionNoticeLevel.Warning)
            return
        }
        urlOpener?.invoke(prompt.url)
            ?: notice(strings.openInBrowser(prompt.url), ExtensionNoticeLevel.Info)
    }

    /** Dismiss the pending `open_url` without opening it. */
    fun dismissOpenUrl() {
        _openUrlPrompt.value = null
    }

    /** Attached by [ExtensionDialogHost]: Custom Tab opener and clipboard access. */
    fun attachPlatform(opener: (String) -> Unit, clipboard: ClipboardBridge) {
        urlOpener = opener
        this.clipboard = clipboard
    }

    fun detachPlatform() {
        urlOpener = null
        clipboard = null
    }

    private fun apply(frame: ExtensionUiFrame, now: Long) {
        when (frame) {
            is ExtensionUiFrame.Dialog -> {
                // A replayed request that this client already answered must not
                // reopen a panel nobody can answer; any other replay replaces
                // the current one (drafts survive by request id).
                if (state.request(frame.request)) {
                    publish()
                    scheduleExpiry(now)
                }
            }

            is ExtensionUiFrame.Cancel -> if (state.cancel(frame.targetId)) publish()

            is ExtensionUiFrame.Notify -> if (frame.message.isNotBlank()) {
                notice(frame.message, frame.level)
            }

            is ExtensionUiFrame.OpenUrl -> openUrl(frame)

            is ExtensionUiFrame.Status -> {
                state.setStatus(frame.key, frame.text)
                publish()
            }

            is ExtensionUiFrame.Widget -> {
                state.setWidget(frame.key, frame.lines, frame.placement)
                publish()
            }

            is ExtensionUiFrame.EditorText -> _editorText.tryEmit(frame.text)

            is ExtensionUiFrame.Terminal -> {
                state.setTerminal(frame.id, frame.lines)
                publish()
            }

            is ExtensionUiFrame.TerminalClosed -> if (state.closeTerminal(frame.id)) publish()

            ExtensionUiFrame.Ignored -> Unit
        }
    }

    /**
     * An extension asked to open a URL. Never auto-opens: the user confirms on
     * the notice (web parity plus Android's explicit user gesture).
     */
    private fun openUrl(frame: ExtensionUiFrame.OpenUrl) {
        if (!isSafeOpenUrl(frame.url)) {
            notice(strings.unsafeUrlBlocked(frame.url), ExtensionNoticeLevel.Warning)
            return
        }
        _openUrlPrompt.value = ExtensionOpenUrlPrompt(frame.url, frame.instructions)
    }

    private fun scheduleExpiry(now: Long) {
        expiryJob?.cancel()
        expiryJob = null
        val request = state.dialog ?: return
        val at = request.expiresAt ?: return
        expiryJob = scope.launch {
            delay((at - now).coerceAtLeast(0))
            // The deadline is known: compare against it, not against the wake
            // time (a delayed coroutine still expires the request).
            if (state.expire(at)) publish()
            expiryJob = null
        }
    }

    /** Stop the deadline timer of a panel that is being dropped. */
    private fun cancelExpiry() {
        expiryJob?.cancel()
        expiryJob = null
    }

    /**
     * Answer one `host_uri_request` for the session whose stream delivered it.
     * The surface may be hidden (list, rotation, notification) while that
     * stream keeps running: omp waits for `host_uri_result`, so the answer
     * goes out either way. While nothing is on screen, a read is denied
     * instead of stacking a consent dialog nobody can see, and a write is
     * refused because the chat that would announce it is not there.
     */
    private fun handleHostUri(request: HostUriRequest) {
        val sid = sessionId ?: panelSession ?: return
        val onScreen = sessionId != null
        scope.launch {
            val resource = hostUriResource(request.url)
            val command = when {
                !resource.equals("clipboard", ignoreCase = true) ->
                    hostUriResultCommand(request.id, error = unknownHostUriResult(resource))

                !onScreen -> hostUriResultCommand(
                    request.id,
                    error = if (request.write) CLIPBOARD_UNAVAILABLE_WRITE else CLIPBOARD_READ_DENIED,
                )

                else -> clipboardCommand(request)
            }
            try {
                api.command(sid, command)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                notice(error.message ?: "Unable to answer the host request", ExtensionNoticeLevel.Error)
            }
        }
    }

    private suspend fun clipboardCommand(request: HostUriRequest): JsonObject {
        val bridge = clipboard
        if (request.write) {
            if (bridge == null) return hostUriResultCommand(request.id, error = CLIPBOARD_UNAVAILABLE_WRITE)
            return try {
                bridge.writeText(request.content.orEmpty())
                notice(strings.clipboardWriteNotice)
                hostUriResultCommand(request.id)
            } catch (error: Exception) {
                hostUriResultCommand(request.id, error = CLIPBOARD_WRITE_FAILED)
            }
        }
        if (bridge == null) return hostUriResultCommand(request.id, error = CLIPBOARD_UNAVAILABLE_READ)
        if (!allowClipboardRead()) return hostUriResultCommand(request.id, error = CLIPBOARD_READ_DENIED)
        return try {
            val text = bridge.readText()
            notice(strings.clipboardReadNotice)
            hostUriResultCommand(
                request.id,
                content = text?.takeIf { it.isNotEmpty() } ?: CLIPBOARD_EMPTY_RESULT,
            )
        } catch (error: Exception) {
            hostUriResultCommand(request.id, error = CLIPBOARD_READ_DENIED)
        }
    }

    /**
     * Default-deny read gate: the first read of a chat asks the user, a denial
     * sticks for the session, and a second concurrent read is refused instead
     * of stacking prompts.
     */
    private suspend fun allowClipboardRead(): Boolean {
        val sid = sessionId ?: return false
        if (sid in clipboardAllowed) return true
        if (sid in clipboardDenied) return false
        if (clipboardRequest != null) return false
        val decision = CompletableDeferred<Boolean>()
        clipboardRequest = decision
        _clipboardPrompt.value = ClipboardPrompt(sid)
        val granted = try {
            decision.await()
        } finally {
            if (clipboardRequest === decision) clipboardRequest = null
        }
        return granted
    }

    /** Answer a read whose chat is going away; the request never hangs. */
    private fun answerPendingClipboard(granted: Boolean) {
        val pending = clipboardRequest ?: return
        clipboardRequest = null
        _clipboardPrompt.value = null
        pending.complete(granted)
    }

    private fun notice(message: String, level: ExtensionNoticeLevel = ExtensionNoticeLevel.Info) {
        _notices.tryEmit(ExtensionNotice(message, level))
    }

    private fun publish() {
        _dialog.value = state.dialog
        _statusItems.value = state.statusItems
        _widgets.value = state.widgets
        _terminal.value = state.terminal
    }
}
