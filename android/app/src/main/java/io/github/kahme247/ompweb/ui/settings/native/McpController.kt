package io.github.kahme247.ompweb.ui.settings.native

import io.github.kahme247.ompweb.domain.OMP_RESOURCE_NAME_RE
import io.github.kahme247.ompweb.domain.McpServerParse
import io.github.kahme247.ompweb.domain.NEW_MCP_SERVER_JSON
import io.github.kahme247.ompweb.domain.parseMcpServerJson
import io.github.kahme247.ompweb.domain.validateMcpServer
import io.github.kahme247.ompweb.net.McpApi
import io.github.kahme247.ompweb.net.McpLiveServer
import io.github.kahme247.ompweb.net.McpServerEntry
import io.github.kahme247.ompweb.net.McpUserConfig
import io.github.kahme247.ompweb.net.userMessage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** One editor result line (a validation/selection/save message). */
data class McpMessage(val text: String, val error: Boolean)

/** State of the MCP section: project servers, user-level summary, editor. */
data class McpState(
    val cwd: String? = null,
    val loading: Boolean = false,
    val error: String? = null,
    val servers: List<McpServerEntry> = emptyList(),
    val user: McpUserConfig? = null,
    val inventory: List<McpLiveServer> = emptyList(),
    val liveServers: List<McpLiveServer>? = null,
    val liveError: String? = null,
    val path: String? = null,
    val selected: String? = null,
    val editorName: String = "",
    val editorText: String = NEW_MCP_SERVER_JSON,
    val saving: Boolean = false,
    val checking: Boolean = false,
    val message: McpMessage? = null,
    val loadedFor: String? = null,
) {
    /** True while a new (unselected) server is being composed. */
    val adding: Boolean get() = selected == null
}

/**
 * Project MCP servers plus the shared editor (`components/McpConfig.tsx`).
 *
 * The editor always works on one server: selecting a row loads its redacted
 * config, "Add server" loads the stdio template. A save sends the name and
 * JSON as-is; the server keeps the previously stored `env`/`headers` when the
 * client omits them, so a redacted round-trip is safe.
 */
class McpController(
    private val api: McpApi,
    private val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow(McpState())
    val state: StateFlow<McpState> = _state.asStateFlow()

    private var loadJob: Job? = null

    fun load(cwd: String?, sessionId: String?, force: Boolean = false) {
        val current = _state.value
        if (loadJob?.isActive == true) return
        if (!force && current.loadedFor == cwd && current.error == null) return
        loadJob = scope.launch {
            _state.update { it.copy(cwd = cwd, loading = true, error = null) }
            try {
                val snapshot = api.load(cwd, sessionId, live = sessionId != null)
                val selected = _state.value.selected?.takeIf { name ->
                    snapshot.servers.any { it.name == name }
                }
                _state.update {
                    it.copy(
                        loading = false,
                        error = null,
                        servers = snapshot.servers,
                        user = snapshot.user,
                        inventory = snapshot.inventory,
                        liveServers = snapshot.liveServers,
                        liveError = snapshot.liveError,
                        path = snapshot.path,
                        loadedFor = cwd,
                        selected = selected,
                        editorName = selected ?: "",
                        editorText = selected?.let { name ->
                            snapshot.servers.firstOrNull { it.name == name }?.let { entry -> pretty(entry.config) }
                        } ?: NEW_MCP_SERVER_JSON,
                    )
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                _state.update { it.copy(loading = false, error = error.userMessage()) }
            }
        }
    }

    fun refresh(cwd: String?, sessionId: String?) = load(cwd, sessionId, force = true)

    /** Selects an existing server (or null to start a new one). */
    fun select(name: String?) {
        val current = _state.value
        if (name == null) {
            _state.update {
                it.copy(selected = null, editorName = "", editorText = NEW_MCP_SERVER_JSON, message = null)
            }
            return
        }
        val entry = current.servers.firstOrNull { it.name == name } ?: return
        _state.update {
            it.copy(
                selected = name,
                editorName = name,
                editorText = pretty(entry.config),
                message = null,
            )
        }
    }

    fun setEditorName(name: String) {
        _state.update { it.copy(editorName = name, message = null) }
    }

    fun setEditorText(text: String) {
        _state.update { it.copy(editorText = text, message = null) }
    }

    /** `PUT /api/mcp`: validates without writing. */
    fun check() {
        val current = _state.value
        if (current.checking) return
        val (name, server, problem) = parsed(current)
        if (problem != null) {
            _state.update { it.copy(message = McpMessage(problem, true)) }
            return
        }
        scope.launch {
            _state.update { it.copy(checking = true, message = null) }
            try {
                val message = api.validate(name, server)
                _state.update { it.copy(checking = false, message = McpMessage(message, false)) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                _state.update { it.copy(checking = false, message = McpMessage(error.userMessage(), true)) }
            }
        }
    }

    /** `POST /api/mcp`: create, update or rename the selected server. */
    fun save(cwd: String, sessionId: String?) {
        val current = _state.value
        if (current.saving) return
        val (name, server, problem) = parsed(current)
        if (problem != null) {
            _state.update { it.copy(message = McpMessage(problem, true)) }
            return
        }
        val previousName = current.selected
        scope.launch {
            _state.update { it.copy(saving = true, message = null) }
            try {
                api.save(cwd, name, previousName, server)
                _state.update {
                    it.copy(
                        saving = false,
                        selected = name,
                        editorName = name,
                        editorText = pretty(server),
                        message = McpMessage(SAVED_MESSAGE, false),
                    )
                }
                load(cwd, sessionId, force = true)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                _state.update { it.copy(saving = false, message = McpMessage(error.userMessage(), true)) }
            }
        }
    }

    fun remove(cwd: String, sessionId: String?) {
        val name = _state.value.selected ?: return
        if (_state.value.saving) return
        scope.launch {
            _state.update { it.copy(saving = true, message = null) }
            try {
                api.remove(cwd, name)
                _state.update {
                    it.copy(
                        saving = false,
                        selected = null,
                        editorName = "",
                        editorText = NEW_MCP_SERVER_JSON,
                        message = McpMessage(REMOVED_MESSAGE, false),
                    )
                }
                load(cwd, sessionId, force = true)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                _state.update { it.copy(saving = false, message = McpMessage(error.userMessage(), true)) }
            }
        }
    }

    fun dismissMessage() {
        _state.update { it.copy(message = null) }
    }

    private data class Parsed(val name: String, val server: JsonObject, val problem: String?)

    private fun parsed(state: McpState): Parsed {
        val name = state.editorName.trim()
        if (!OMP_RESOURCE_NAME_RE.matches(name)) {
            return Parsed(name, JsonObject(emptyMap()), "Server name may contain letters, numbers, dots, dashes, and underscores")
        }
        return when (val parsed = parseMcpServerJson(state.editorText)) {
            is McpServerParse.Invalid -> Parsed(name, JsonObject(emptyMap()), parsed.message)
            is McpServerParse.Valid -> Parsed(name, parsed.server, validateMcpServer(name, parsed.server))
        }
    }

    private fun pretty(element: JsonElement): String =
        prettyJson.encodeToString(JsonElement.serializer(), element)

    companion object {
        /** The web's post-save line (`mcpConfig.savedMsg`). */
        const val SAVED_MESSAGE =
            "Saved. Restart OMP sessions or run /mcp reload to apply it."

        /** The web's post-remove line (`mcpConfig.removedMsg`). */
        const val REMOVED_MESSAGE =
            "MCP server removed. Restart OMP sessions or run /mcp reload to apply it."

        private val prettyJson = Json { prettyPrint = true }
    }
}
