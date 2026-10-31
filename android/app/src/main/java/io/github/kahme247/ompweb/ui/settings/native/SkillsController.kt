package io.github.kahme247.ompweb.ui.settings.native

import io.github.kahme247.ompweb.net.NativeSkillInfo
import io.github.kahme247.ompweb.net.SkillSearchResult
import io.github.kahme247.ompweb.net.SkillUpdateResult
import io.github.kahme247.ompweb.net.SkillsApi
import io.github.kahme247.ompweb.net.userMessage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** State of the Skills section (`components/SkillsConfig.tsx`). */
data class SkillsState(
    val cwd: String? = null,
    val loading: Boolean = false,
    val error: String? = null,
    val skills: List<NativeSkillInfo> = emptyList(),
    val selected: String? = null,
    val busy: Set<String> = emptySet(),
    val adding: Boolean = false,
    val searchQuery: String = "",
    val searching: Boolean = false,
    val searchError: String? = null,
    val results: List<SkillSearchResult> = emptyList(),
    val installScope: String = "global",
    val installing: String? = null,
    val installed: Set<String> = emptySet(),
    val checks: Map<String, SkillUpdateResult> = emptyMap(),
    val checking: Set<String> = emptySet(),
    val checkingAll: Boolean = false,
    val notice: String? = null,
    val noticeError: Boolean = false,
    val loadedFor: String? = null,
) {
    val selectedSkill: NativeSkillInfo? get() = skills.firstOrNull { it.filePath == selected }

    /** At least one installed skill can be checked, so the bulk button shows. */
    val canCheckAll: Boolean get() = skills.any { it.install?.canCheckForUpdates == true }

    val updateCount: Int get() = checks.values.count { it.state == "update-available" }
}

/**
 * Skills list plus toggling, per-skill update checks and the skills.sh
 * add/search panel. Every mutation reloads the list from the server so the
 * page never claims a state the file system does not have.
 */
class SkillsController(
    private val api: SkillsApi,
    private val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow(SkillsState())
    val state: StateFlow<SkillsState> = _state.asStateFlow()

    private var loadJob: Job? = null

    fun load(cwd: String, force: Boolean = false) {
        val current = _state.value
        if (loadJob?.isActive == true) return
        if (!force && current.loadedFor == cwd && current.error == null) return
        loadJob = scope.launch {
            _state.update { it.copy(cwd = cwd, loading = true, error = null) }
            try {
                val skills = api.list(cwd)
                _state.update { state ->
                    val selected = state.selected?.takeIf { path -> skills.any { it.filePath == path } }
                    state.copy(
                        loading = false,
                        error = null,
                        skills = skills,
                        selected = selected,
                        loadedFor = cwd,
                        checks = state.checks.filterKeys { path -> skills.any { it.filePath == path } },
                    )
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                _state.update { it.copy(loading = false, error = error.userMessage()) }
            }
        }
    }

    fun select(filePath: String?) {
        _state.update { it.copy(selected = filePath, adding = false, notice = null) }
    }

    fun openAdd() {
        _state.update { it.copy(adding = true, selected = null, notice = null) }
    }

    fun closeAdd() {
        _state.update {
            it.copy(adding = false, searchQuery = "", searchError = null, results = emptyList())
        }
    }

    fun setSearchQuery(query: String) {
        _state.update { it.copy(searchQuery = query, searchError = null) }
    }

    fun setInstallScope(scope: String) {
        _state.update { it.copy(installScope = scope) }
    }

    fun search() {
        val query = _state.value.searchQuery.trim()
        if (query.isEmpty() || _state.value.searching) return
        scope.launch {
            _state.update { it.copy(searching = true, searchError = null) }
            try {
                val results = api.search(query)
                _state.update { it.copy(searching = false, results = results) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                _state.update { it.copy(searching = false, searchError = error.userMessage()) }
            }
        }
    }

    fun install(packageName: String, cwd: String?) {
        val scopeName = _state.value.installScope
        if (_state.value.installing != null) return
        if (scopeName == "project" && cwd == null) {
            _state.update { it.copy(notice = "Select a workspace to install project skills", noticeError = true) }
            return
        }
        scope.launch {
            _state.update { it.copy(installing = packageName, notice = null) }
            try {
                api.install(packageName, scopeName, cwd.takeIf { scopeName == "project" })
                _state.update {
                    it.copy(
                        installing = null,
                        installed = it.installed + packageName,
                        notice = "Installed $packageName",
                        noticeError = false,
                    )
                }
                cwd?.let { load(it, force = true) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                _state.update { it.copy(installing = null, notice = error.userMessage(), noticeError = true) }
            }
        }
    }

    /** `PATCH /api/skills`: the server answers the file's resulting value. */
    fun toggle(skill: NativeSkillInfo, cwd: String?) {
        if (!skill.togglable || skill.filePath in _state.value.busy) return
        scope.launch {
            _state.update { it.copy(busy = it.busy + skill.filePath, notice = null) }
            try {
                val disabled = api.setModelInvocationDisabled(
                    skill.filePath,
                    !skill.disableModelInvocation,
                    cwd,
                )
                _state.update { state ->
                    state.copy(
                        busy = state.busy - skill.filePath,
                        skills = state.skills.map {
                            if (it.filePath == skill.filePath) it.copy(disableModelInvocation = disabled) else it
                        },
                    )
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                _state.update {
                    it.copy(busy = it.busy - skill.filePath, notice = error.userMessage(), noticeError = true)
                }
            }
        }
    }

    fun check(skill: NativeSkillInfo, cwd: String) {
        val install = skill.install ?: return
        if (skill.filePath in _state.value.checking) return
        scope.launch {
            _state.update { it.copy(checking = it.checking + skill.filePath) }
            try {
                val updates = api.checkUpdates(cwd, install.packageName, install.scope)
                val result = updates.firstOrNull {
                    it.packageName == install.packageName && it.scope == install.scope
                }
                _state.update { state ->
                    state.copy(
                        checking = state.checking - skill.filePath,
                        checks = if (result == null) state.checks
                        else state.checks + (skill.filePath to result),
                    )
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                _state.update {
                    it.copy(
                        checking = it.checking - skill.filePath,
                        notice = error.userMessage(),
                        noticeError = true,
                    )
                }
            }
        }
    }

    fun checkAll(cwd: String) {
        if (_state.value.checkingAll) return
        scope.launch {
            _state.update { it.copy(checkingAll = true, notice = null) }
            try {
                val updates = api.checkUpdates(cwd)
                // The same package can be installed globally and per project;
                // the web keys the map `scope\0package` (SkillsConfig.tsx).
                val byInstall = updates.associateBy { "${it.scope}\u0000${it.packageName}" }
                _state.update { state ->
                    val checks = state.checks.toMutableMap()
                    for (skill in state.skills) {
                        val install = skill.install ?: continue
                        byInstall["${install.scope}\u0000${install.packageName}"]?.let {
                            checks[skill.filePath] = it
                        }
                    }
                    state.copy(checkingAll = false, checks = checks)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                _state.update {
                    it.copy(checkingAll = false, notice = error.userMessage(), noticeError = true)
                }
            }
        }
    }

    fun update(skill: NativeSkillInfo, cwd: String?) {
        val install = skill.install ?: return
        if (cwd == null || skill.filePath in _state.value.busy) return
        scope.launch {
            _state.update { it.copy(busy = it.busy + skill.filePath, notice = null) }
            try {
                api.update(cwd, install.packageName, install.scope)
                _state.update {
                    it.copy(
                        busy = it.busy - skill.filePath,
                        notice = "Updated ${install.packageName}",
                        noticeError = false,
                        checks = it.checks - skill.filePath,
                    )
                }
                load(cwd, force = true)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                _state.update {
                    it.copy(busy = it.busy - skill.filePath, notice = error.userMessage(), noticeError = true)
                }
            }
        }
    }

    fun dismissNotice() {
        _state.update { it.copy(notice = null) }
    }
}
