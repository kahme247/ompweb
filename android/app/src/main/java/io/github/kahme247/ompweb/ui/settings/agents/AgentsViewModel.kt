package io.github.kahme247.ompweb.ui.settings.agents

import io.github.kahme247.ompweb.net.AgentDiagnostic
import io.github.kahme247.ompweb.net.AgentInfo
import io.github.kahme247.ompweb.net.AgentsApi
import io.github.kahme247.ompweb.net.ApiError
import io.github.kahme247.ompweb.net.captureApi
import io.github.kahme247.ompweb.net.userMessage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Everything the Agents tab renders. */
data class AgentsState(
    val cwd: String? = null,
    val loading: Boolean = false,
    val saving: Boolean = false,
    val creating: Boolean = false,
    val agents: List<AgentInfo> = emptyList(),
    val diagnostics: List<AgentDiagnostic> = emptyList(),
    val selectedName: String? = null,
    val search: String = "",
    val form: AgentDraft = AgentDraft(),
    val createScope: String = "user",
    val workspaceUnavailable: Boolean = false,
    val workspaceCheckPending: Boolean = false,
    val message: String? = null,
    val messageIsError: Boolean = false,
) {
    val filtered: List<AgentInfo> get() = filterAgents(agents, search)
    val counts: AgentCounts get() = AgentCounts.of(agents)
    val active: AgentInfo? get() = if (creating) null else agents.firstOrNull { it.name == selectedName }
    val canEditProject: Boolean get() = cwd != null && !workspaceUnavailable && !workspaceCheckPending
    val isBundledActive: Boolean get() = active?.isBundled == true
    val activeProjectUnavailable: Boolean get() = active?.scope == "project" && !canEditProject
}

/**
 * Roster + editor of the Agents tab (`components/AgentsConfig.tsx`).
 *
 * `cwd` arrives from the settings shell via [attach]; a stale workspace makes
 * the route answer 403, which this model turns into [AgentsState.workspaceUnavailable]
 * after retrying the global roster once — the same fallback as the web client.
 */
class AgentsViewModel(
    private val api: AgentsApi,
    private val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow(AgentsState())
    val state: StateFlow<AgentsState> = _state.asStateFlow()

    private var loadJob: Job? = null
    private var generation = 0

    /** Called when the shell's workspace changes (and once on first composition). */
    fun attach(cwd: String?) {
        if (state.value.cwd == cwd && state.value.agents.isNotEmpty()) return
        _state.update { it.copy(cwd = cwd) }
        reload()
    }

    fun reload(forceSelect: Boolean = false, keepMessage: Boolean = false) {
        val cwd = state.value.cwd
        loadJob?.cancel()
        val request = ++generation
        _state.update {
            it.copy(
                loading = true,
                workspaceCheckPending = cwd != null,
                message = if (keepMessage) it.message else null,
            )
        }
        loadJob = scope.launch {
            try {
                var result = captureApi { api.list(cwd) }
                var unavailable = false
                if (result.isFailure && cwd != null && isForbidden(result.exceptionOrNull())) {
                    // Keep global agents usable when the workspace directory is gone.
                    result = captureApi { api.list(null) }
                    unavailable = result.isSuccess
                }
                if (request != generation) return@launch
                result.fold(
                    onSuccess = { document ->
                        val previous = _state.value
                        val chosen = if (forceSelect || !previous.creating) {
                            document.agents.firstOrNull { it.name == previous.selectedName }
                                ?: document.agents.firstOrNull()
                        } else {
                            null
                        }
                        val diagnosticErrors = document.diagnostics
                            .filter { it.type == "error" && it.message.isNotBlank() }
                            .map { it.message }
                        _state.update {
                            val next = it.copy(
                                loading = false,
                                workspaceCheckPending = false,
                                workspaceUnavailable = unavailable,
                                agents = document.agents,
                                diagnostics = document.diagnostics,
                                selectedName = chosen?.name,
                                form = chosen?.let(AgentDraft::from) ?: AgentDraft(),
                                creating = if (chosen == null) it.creating else false,
                                message = when {
                                    unavailable -> "The workspace is not available to ompweb. Only user agents are listed."
                                    diagnosticErrors.isNotEmpty() && document.agents.isEmpty() ->
                                        diagnosticErrors.joinToString("; ")
                                    // A save/remove/unpack confirmation survives the refresh it triggers.
                                    keepMessage -> it.message
                                    else -> null
                                },
                                messageIsError = when {
                                    unavailable -> true
                                    diagnosticErrors.isNotEmpty() && document.agents.isEmpty() -> true
                                    keepMessage -> it.messageIsError
                                    else -> false
                                },
                            )
                            next.copy(
                                createScope = when {
                                    next.creating && next.createScope == "project" -> "user"
                                    next.canEditProject -> "project"
                                    else -> "user"
                                },
                            )
                        }
                    },
                    onFailure = { error ->
                        _state.update {
                            it.copy(
                                loading = false,
                                workspaceCheckPending = false,
                                message = error.userMessage(),
                                messageIsError = true,
                            )
                        }
                    },
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } finally {
                if (request == generation) {
                    _state.update { it.copy(loading = false, workspaceCheckPending = false) }
                }
            }
        }
    }

    fun setSearch(query: String) = _state.update { it.copy(search = query) }

    fun select(name: String) {
        val agent = state.value.agents.firstOrNull { it.name == name } ?: return
        _state.update {
            it.copy(
                creating = false,
                selectedName = agent.name,
                form = AgentDraft.from(agent),
                message = null,
            )
        }
    }

    /** Search jump target: open the editor of the first agent when none is open. */
    fun applyHighlight(id: String) {
        if (id !in AGENT_HIGHLIGHTS) return
        val current = state.value
        if (current.creating || current.active != null) return
        current.agents.firstOrNull()?.let { select(it.name) }
    }

    fun startCreate() {
        _state.update {
            it.copy(
                creating = true,
                selectedName = null,
                form = AgentDraft(),
                createScope = if (it.canEditProject) "project" else "user",
                message = null,
            )
        }
    }

    fun cancelCreate() {
        val current = state.value
        val fallback = current.agents.firstOrNull()
        _state.update {
            it.copy(
                creating = false,
                selectedName = fallback?.name,
                form = fallback?.let(AgentDraft::from) ?: AgentDraft(),
                message = null,
            )
        }
    }

    fun setCreateScope(scope: String) = _state.update {
        it.copy(createScope = if (scope == "project" && it.canEditProject) "project" else "user")
    }

    fun updateForm(transform: (AgentDraft) -> AgentDraft) = _state.update {
        it.copy(form = transform(it.form))
    }

    fun dismissMessage() = _state.update { it.copy(message = null) }

    fun save() {
        val current = state.value
        if (current.saving) return
        when (validateAgentDraft(current.form.name, current.form.description)) {
            AgentValidation.NAME_REQUIRED -> return message("Name is required.", error = true)
            AgentValidation.NAME_PATTERN ->
                return message("Name must start with a letter or digit and use letters, digits, '.', '_' or '-'.", true)
            AgentValidation.DESCRIPTION_REQUIRED -> return message("Description is required.", true)
            AgentValidation.OK -> Unit
        }
        val active = current.active
        val scopeName = agentSaveScope(current.creating, active, current.createScope, current.canEditProject)
        if (scopeName == "project" && !current.canEditProject) {
            return message("Project agents need an available workspace.", error = true)
        }
        val pageCwd = if (scopeName == "project") current.cwd else null
        val editing = !current.creating && active != null && !active.isBundled
        val previousName = if (editing) agentFileStem(active!!.filePath) else null
        val payload = buildAgentPayload(
            draft = current.form,
            existingFrontmatter = if (editing) active?.rawFrontmatter else null,
        )
        val name = current.form.name.trim()
        _state.update { it.copy(saving = true, message = null) }
        scope.launch {
            val result = captureApi {
                api.save(
                    cwd = pageCwd,
                    scope = scopeName,
                    name = name,
                    previousName = previousName,
                    agent = payload,
                    update = editing,
                )
            }
            result.fold(
                onSuccess = {
                    _state.update {
                        it.copy(
                            saving = false,
                            creating = false,
                            selectedName = name,
                            message = if (editing) "Agent saved." else "Agent created.",
                            messageIsError = false,
                        )
                    }
                    reload(forceSelect = true, keepMessage = true)
                },
                onFailure = { error ->
                    _state.update {
                        it.copy(
                            saving = false,
                            workspaceUnavailable = it.workspaceUnavailable || (pageCwd != null && isForbidden(error)),
                            message = error.userMessage(),
                            messageIsError = true,
                        )
                    }
                },
            )
        }
    }

    fun remove() {
        val current = state.value
        val active = current.active ?: return
        if (current.saving || active.isBundled || current.activeProjectUnavailable) return
        val pageCwd = if (active.scope == "project") current.cwd else null
        val stem = agentFileStem(active.filePath).ifBlank { active.name }
        _state.update { it.copy(saving = true, message = null) }
        scope.launch {
            val result = captureApi { api.delete(pageCwd, active.scope, stem) }
            result.fold(
                onSuccess = {
                    _state.update {
                        it.copy(
                            saving = false,
                            creating = false,
                            selectedName = null,
                            form = AgentDraft(),
                            message = "Agent removed.",
                            messageIsError = false,
                        )
                    }
                    reload(keepMessage = true)
                },
                onFailure = { error ->
                    _state.update {
                        it.copy(
                            saving = false,
                            workspaceUnavailable = it.workspaceUnavailable || (pageCwd != null && isForbidden(error)),
                            message = error.userMessage(),
                            messageIsError = true,
                        )
                    }
                },
            )
        }
    }

    fun unpack() {
        val current = state.value
        if (current.saving) return
        val scopeName = if (current.canEditProject) "project" else "user"
        val pageCwd = if (scopeName == "project") current.cwd else null
        _state.update { it.copy(saving = true, message = null) }
        scope.launch {
            val result = captureApi { api.unpack(pageCwd, scopeName) }
            result.fold(
                onSuccess = { unpacked ->
                    _state.update {
                        it.copy(
                            saving = false,
                            message = "Unpacked ${unpacked.written} agent(s).",
                            messageIsError = false,
                        )
                    }
                    reload(keepMessage = true)
                },
                onFailure = { error ->
                    _state.update {
                        it.copy(
                            saving = false,
                            workspaceUnavailable = it.workspaceUnavailable || (pageCwd != null && isForbidden(error)),
                            message = error.userMessage(),
                            messageIsError = true,
                        )
                    }
                },
            )
        }
    }

    private fun message(text: String, error: Boolean) {
        _state.update { it.copy(message = text, messageIsError = error) }
    }

    private fun isForbidden(error: Throwable?): Boolean = when (error) {
        is ApiError.Forbidden -> true
        is ApiError.ServerResponse -> error.status == 403
        else -> false
    }

    private companion object {
        val AGENT_HIGHLIGHTS = setOf("agent-roster", "agent-model", "agent-tools", "agent-scope", "agent-thinking")
    }
}
