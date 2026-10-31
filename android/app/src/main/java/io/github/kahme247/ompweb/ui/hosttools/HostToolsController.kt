package io.github.kahme247.ompweb.ui.hosttools

import io.github.kahme247.ompweb.data.ChatSettings
import io.github.kahme247.ompweb.domain.HostToolDecision
import io.github.kahme247.ompweb.domain.HostToolKind
import io.github.kahme247.ompweb.domain.HostToolPrompt
import io.github.kahme247.ompweb.domain.NOTIFICATION_SHOWN_RESULT
import io.github.kahme247.ompweb.domain.NO_PATH_RESULT
import io.github.kahme247.ompweb.domain.UNSAFE_URL_RESULT
import io.github.kahme247.ompweb.domain.askedResult
import io.github.kahme247.ompweb.domain.hostToolResultCommand
import io.github.kahme247.ompweb.domain.isCrossSession
import io.github.kahme247.ompweb.domain.openedResult
import io.github.kahme247.ompweb.domain.openFileDecision
import io.github.kahme247.ompweb.domain.openUrlDecision
import io.github.kahme247.ompweb.domain.setHostToolsCommand
import io.github.kahme247.ompweb.domain.setHostUriSchemesCommand
import io.github.kahme247.ompweb.domain.unknownHostToolResult
import io.github.kahme247.ompweb.events.EventChannel
import io.github.kahme247.ompweb.events.EventMux
import io.github.kahme247.ompweb.net.ExtensionApi
import io.github.kahme247.ompweb.ui.panels.extension.ExtensionStrings
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** What the shell can do with a consented host-tool action. */
interface HostToolOpener {
    fun openUrl(url: String)

    /** True when a system notification was actually posted. */
    fun notify(title: String, message: String): Boolean
}

/**
 * Executes the host tools this app registers with omp (`open_url`, `notify`,
 * `open_file`) and answers every call with `host_tool_result`, so an agent
 * turn can never hang on a tool nobody answers.
 *
 * Calls arrive on two paths: the viewed session's own stream (the chat view
 * model forwards `host_tool_call` frames) and the app-wide `host-tools`
 * channel for sessions no tab watches (`start`/`stop`). Consent rules mirror
 * `AppShell.tsx`: a URL from the viewed session opens directly only when the
 * `omp-web:open-url-automatically` preference is on; everything from another
 * session asks first.
 */
class HostToolsController(
    private val api: ExtensionApi,
    private val events: EventMux,
    private val settings: ChatSettings,
    private val scope: CoroutineScope,
    private val strings: ExtensionStrings = ExtensionStrings(),
) {
    private val queue = ArrayDeque<HostToolPrompt>()

    private val _pending = MutableStateFlow<HostToolPrompt?>(null)
    val pending: StateFlow<HostToolPrompt?> = _pending.asStateFlow()

    private val _notices = MutableSharedFlow<String>(
        extraBufferCapacity = 16,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    /** Snackbar text for `notify` when no system notification could be posted. */
    val notices: SharedFlow<String> = _notices.asSharedFlow()

    private var viewedSessionId: String? = null
    private var channelJob: Job? = null
    private var opener: HostToolOpener? = null
    private var openFile: ((sessionId: String, path: String) -> Unit)? = null

    /** Subscribes the app-wide `host-tools` channel; safe to call twice. */
    fun start() {
        if (channelJob?.isActive == true) return
        channelJob = scope.launch {
            try {
                events.subscribe(EventChannel.HostTools).collect { frame -> onChannelFrame(frame) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                // The mux reconnects and resubscribes; a refusal has no user action.
            }
        }
    }

    fun stop() {
        channelJob?.cancel()
        channelJob = null
    }

    /** The session the user is looking at; null while no chat is open. */
    fun setViewedSession(id: String?) {
        viewedSessionId = id
    }

    /** Drops the viewed session and every unanswered prompt (sign-out / wipe). */
    fun reset() {
        viewedSessionId = null
        queue.clear()
        _pending.value = null
    }

    /**
     * `set_host_tools` + `set_host_uri_schemes` for [sessionId]. Registration is
     * per wrapper and not persisted, so re-send it on every `connected` frame
     * and after a prompt started the session (web `registerHostTools`).
     */
    fun register(sessionId: String) {
        scope.launch {
            try {
                api.command(sessionId, setHostToolsCommand())
                api.command(sessionId, setHostUriSchemesCommand())
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                // Older omp builds have no host bridge: the UI then stays passive.
            }
        }
    }

    /** Attached by [HostToolPromptHost]; the Android actions live in that file. */
    fun attach(opener: HostToolOpener, onOpenFile: (sessionId: String, path: String) -> Unit) {
        this.opener = opener
        openFile = onOpenFile
    }

    fun detach() {
        opener = null
        openFile = null
    }

    /**
     * Consume a frame of the viewed session's channel. Returns true for
     * `host_tool_call`/`host_tool_cancel`, false for everything else.
     */
    fun onFrame(sessionId: String, frame: JsonObject): Boolean = when (frame.type()) {
        "host_tool_call" -> {
            handleCall(
                sessionId = sessionId,
                id = frame.string("id").orEmpty(),
                toolName = frame.string("toolName").orEmpty(),
                args = frame["arguments"] as? JsonObject,
            )
            true
        }

        "host_tool_cancel" -> {
            dropPrompt(frame.string("targetId").orEmpty())
            true
        }

        else -> false
    }

    /** Open the pending target (the consent prompt's confirm action). */
    fun approve() {
        val prompt = takePrompt() ?: return
        when (prompt.kind) {
            HostToolKind.OpenUrl -> opener?.openUrl(prompt.target)
            HostToolKind.OpenFile -> openFile?.invoke(prompt.sessionId, prompt.target)
        }
    }

    /** Dismiss the pending target; the call was already answered with "Asked …". */
    fun deny() {
        takePrompt()
    }

    private fun onChannelFrame(frame: JsonObject) {
        when (frame.type()) {
            "host_tool_call" -> handleCall(
                sessionId = frame.string("sessionId").orEmpty(),
                id = frame.string("id").orEmpty(),
                toolName = frame.string("toolName").orEmpty(),
                args = frame["arguments"] as? JsonObject,
            )

            "host_tool_cancel" -> dropPrompt(frame.string("targetId").orEmpty())
        }
    }

    private fun handleCall(sessionId: String, id: String, toolName: String, args: JsonObject?) {
        if (sessionId.isEmpty() || id.isEmpty() || toolName.isEmpty()) return
        when (toolName) {
            "open_url" -> handleOpenUrl(sessionId, id, args)
            "notify" -> handleNotify(sessionId, id, args)
            "open_file" -> handleOpenFile(sessionId, id, args)
            else -> answer(sessionId, id, unknownHostToolResult(toolName), isError = true)
        }
    }

    private fun handleOpenUrl(sessionId: String, id: String, args: JsonObject?) {
        val url = args?.string("url").orEmpty()
        val autoOpen = settings.snapshot.value.openUrlAutomatically
        var decision = openUrlDecision(url, sessionId, viewedSessionId, autoOpen)
        if (decision == HostToolDecision.Execute && opener == null) decision = HostToolDecision.Ask
        when (decision) {
            HostToolDecision.Error ->
                // Web parity: an empty URL is a plain refusal, a bad scheme is an error.
                answer(sessionId, id, UNSAFE_URL_RESULT, isError = url.isNotEmpty())

            HostToolDecision.Ask -> {
                val crossSession = isCrossSession(sessionId, viewedSessionId)
                // Web parity: the tool call is answered while the prompt is up,
                // so an agent turn never blocks on the user's later click.
                answer(sessionId, id, askedResult(url, crossSession), isError = false)
                enqueue(
                    HostToolPrompt(
                        id = id,
                        sessionId = sessionId,
                        toolName = "open_url",
                        kind = HostToolKind.OpenUrl,
                        target = url,
                        crossSession = crossSession,
                    ),
                )
            }

            HostToolDecision.Execute -> {
                opener?.openUrl(url)
                answer(sessionId, id, openedResult(url), isError = false)
            }
        }
    }

    private fun handleNotify(sessionId: String, id: String, args: JsonObject?) {
        val title = args?.string("title")?.takeIf { it.isNotBlank() } ?: "OMP"
        val message = args?.string("message").orEmpty()
        if (opener?.notify(title, message) != true) {
            _notices.tryEmit(strings.notificationFallback(title, message))
        }
        answer(sessionId, id, NOTIFICATION_SHOWN_RESULT, isError = false)
    }

    private fun handleOpenFile(sessionId: String, id: String, args: JsonObject?) {
        val path = args?.string("path").orEmpty()
        var decision = openFileDecision(path, sessionId, viewedSessionId)
        if (decision == HostToolDecision.Execute && openFile == null) decision = HostToolDecision.Ask
        when (decision) {
            HostToolDecision.Error ->
                answer(sessionId, id, NO_PATH_RESULT, isError = true)

            HostToolDecision.Ask -> {
                val crossSession = isCrossSession(sessionId, viewedSessionId)
                answer(sessionId, id, askedResult(path, crossSession), isError = false)
                enqueue(
                    HostToolPrompt(
                        id = id,
                        sessionId = sessionId,
                        toolName = "open_file",
                        kind = HostToolKind.OpenFile,
                        target = path,
                        crossSession = crossSession,
                    ),
                )
            }

            HostToolDecision.Execute -> {
                openFile?.invoke(sessionId, path)
                answer(sessionId, id, openedResult(path), isError = false)
            }
        }
    }

    private fun enqueue(prompt: HostToolPrompt) {
        if (queue.any { it.id == prompt.id } || _pending.value?.id == prompt.id) return
        queue.addLast(prompt)
        _pending.value = queue.firstOrNull()
    }

    private fun dropPrompt(targetId: String) {
        if (targetId.isEmpty()) return
        queue.removeAll { it.id == targetId }
        if (_pending.value?.id == targetId) _pending.value = queue.firstOrNull()
    }

    private fun takePrompt(): HostToolPrompt? {
        if (queue.isEmpty()) return null
        val prompt = queue.removeFirst()
        _pending.value = queue.firstOrNull()
        return prompt
    }

    private fun answer(sessionId: String, id: String, text: String, isError: Boolean) {
        scope.launch {
            try {
                api.command(sessionId, hostToolResultCommand(id, text, isError))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _notices.tryEmit(error.message ?: "Unable to answer the host tool call")
            }
        }
    }

    private fun JsonObject.type(): String? = string("type")

    private fun JsonObject.string(key: String): String? =
        (this[key] as? JsonPrimitive)?.contentOrNull
}
