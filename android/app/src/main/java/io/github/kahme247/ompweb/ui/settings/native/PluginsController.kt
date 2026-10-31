package io.github.kahme247.ompweb.ui.settings.native

import io.github.kahme247.ompweb.net.PluginAction
import io.github.kahme247.ompweb.net.PluginPackageInfo
import io.github.kahme247.ompweb.net.PluginsApi
import io.github.kahme247.ompweb.net.PluginsSnapshot
import io.github.kahme247.ompweb.net.userMessage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** State of the Plugins section (`components/PluginsConfig.tsx`). */
data class PluginsState(
    val cwd: String? = null,
    val loading: Boolean = false,
    val error: String? = null,
    val snapshot: PluginsSnapshot? = null,
    val selected: String? = null,
    val adding: Boolean = false,
    val source: String = "",
    val scope: String = "project",
    val busy: String? = null,
    val reloading: Boolean = false,
    val notice: String? = null,
    val noticeError: Boolean = false,
    val loadedFor: String? = null,
) {
    val selectedPackage: PluginPackageInfo? get() = snapshot?.packages?.firstOrNull { it.source == selected }
}

/**
 * Plugin management delegated to the server's omp binary. Every action
 * answers the refreshed list, so the page shows the server's view instead of
 * an optimistic guess.
 */
class PluginsController(
    private val api: PluginsApi,
    private val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow(PluginsState())
    val state: StateFlow<PluginsState> = _state.asStateFlow()

    private var loadJob: Job? = null

    fun load(cwd: String, force: Boolean = false) {
        val current = _state.value
        if (loadJob?.isActive == true) return
        if (!force && current.loadedFor == cwd && current.error == null) return
        loadJob = scope.launch {
            _state.update { it.copy(cwd = cwd, loading = true, error = null) }
            try {
                val snapshot = api.load(cwd)
                _state.update { state ->
                    state.copy(
                        loading = false,
                        error = null,
                        snapshot = snapshot,
                        loadedFor = cwd,
                        selected = state.selected?.takeIf { source ->
                            snapshot.packages.any { it.source == source }
                        },
                    )
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                _state.update { it.copy(loading = false, error = error.userMessage()) }
            }
        }
    }

    fun refresh(cwd: String) = load(cwd, force = true)

    fun select(source: String?) {
        _state.update { it.copy(selected = source, adding = false, notice = null) }
    }

    fun openAdd() {
        _state.update { it.copy(adding = true, selected = null, source = "", notice = null) }
    }

    fun closeAdd() {
        _state.update { it.copy(adding = false, source = "") }
    }

    fun setSource(source: String) {
        _state.update { it.copy(source = source, notice = null) }
    }

    fun setScope(scope: String) {
        _state.update { it.copy(scope = scope) }
    }

    fun install(cwd: String) {
        val source = _state.value.source.trim()
        if (source.isEmpty() || _state.value.busy != null) return
        send(PluginAction.INSTALL, source, _state.value.scope, cwd)
    }

    fun action(action: PluginAction, packageInfo: PluginPackageInfo, cwd: String) {
        if (_state.value.busy != null) return
        send(action, packageInfo.source, packageInfo.scope, cwd)
    }

    fun reload(sessionId: String) {
        if (_state.value.reloading) return
        scope.launch {
            _state.update { it.copy(reloading = true, notice = null) }
            try {
                api.reload(sessionId)
                _state.update {
                    it.copy(reloading = false, notice = "Session reloaded.", noticeError = false)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                _state.update { it.copy(reloading = false, notice = error.userMessage(), noticeError = true) }
            }
        }
    }

    fun dismissNotice() {
        _state.update { it.copy(notice = null) }
    }

    private fun send(action: PluginAction, source: String, targetScope: String, cwd: String) {
        scope.launch {
            _state.update { it.copy(busy = action.wire, notice = null) }
            try {
                val snapshot = api.action(action, source, targetScope, cwd)
                val notice = when (action) {
                    PluginAction.INSTALL -> "Package installed."
                    PluginAction.REMOVE -> "Package removed."
                    PluginAction.UPDATE -> "Package updated."
                    PluginAction.DISABLE -> "Package disabled."
                    PluginAction.ENABLE -> "Package enabled."
                }
                _state.update {
                    it.copy(
                        busy = null,
                        snapshot = snapshot,
                        notice = notice,
                        noticeError = false,
                        selected = if (action == PluginAction.REMOVE) null else it.selected,
                        adding = if (action == PluginAction.INSTALL) false else it.adding,
                        source = if (action == PluginAction.INSTALL) "" else it.source,
                    )
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                _state.update { it.copy(busy = null, notice = error.userMessage(), noticeError = true) }
            }
        }
    }
}
