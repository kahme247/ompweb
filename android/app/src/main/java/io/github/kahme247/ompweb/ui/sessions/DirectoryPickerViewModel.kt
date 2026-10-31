package io.github.kahme247.ompweb.ui.sessions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.kahme247.ompweb.domain.appendProgress
import io.github.kahme247.ompweb.domain.cloneDirectoryName
import io.github.kahme247.ompweb.net.ApiClient
import io.github.kahme247.ompweb.net.ApiError
import io.github.kahme247.ompweb.net.CloneFrame
import io.github.kahme247.ompweb.net.DirectoryEntry
import io.github.kahme247.ompweb.net.ProjectLaunchConfig
import io.github.kahme247.ompweb.net.captureApi
import io.github.kahme247.ompweb.net.userMessage
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.Call

data class DirectoryPickerUiState(
    val path: String = "",
    val pathInput: String = "",
    val parentPath: String? = null,
    val directories: List<DirectoryEntry> = emptyList(),
    val drives: List<DirectoryEntry> = emptyList(),
    val loading: Boolean = true,
    val error: String? = null,
    val profile: String = "",
    val advisor: Boolean = false,
    val extraArgs: String = "",
    val cloneUrl: String = "",
    val cloneLog: String = "",
    val cloneRunning: Boolean = false,
    val cloneStatus: String? = null,
) {
    val cloneName: String?
        get() = cloneDirectoryName(cloneUrl)

    /** `null` when the typed URL is invalid; the target preview stays hidden. */
    val cloneTarget: String?
        get() {
            val name = cloneName ?: return null
            var base = path
            if (base.isEmpty()) return null
            if (!base.endsWith("/") && !base.endsWith("\\")) {
                base += if ('\\' in base) "\\" else "/"
            }
            return base + name
        }

    val hasUncommittedPath: Boolean
        get() = pathInput.trim() != path && pathInput.isNotBlank()

    val canSelect: Boolean
        get() = path.isNotBlank() && !hasUncommittedPath && !cloneRunning &&
            (cloneUrl.isBlank() || cloneName != null)
}

/**
 * Server-side directory browser with the workspace-adding/dir-picking clone
 * flow (`components/DirectoryPicker.tsx`, `app/api/projects/clone/route.ts`).
 *
 * Cloning streams NDJSON progress; cancelling after the POST responded leaves
 * the stream open so the server can report its cleanup, while a 404 before
 * that means the server has not registered the clone yet and dropping the
 * request makes it cancel during git.
 */
class DirectoryPickerViewModel(private val api: ApiClient) : ViewModel() {

    private val _state = MutableStateFlow(DirectoryPickerUiState())
    val state: StateFlow<DirectoryPickerUiState> = _state.asStateFlow()

    private var loadGeneration = 0L
    private var cloneJob: Job? = null
    private var cloneCall: Call? = null
    private var cloneId: String? = null
    private var cloneResponded = false

    /** Clone the user dropped locally; its transport errors are not failures. */
    private var cancelledCloneId: String? = null

    fun start(initialPath: String?) {
        if (_state.value.path.isNotBlank()) return
        navigate(initialPath)
    }

    fun navigate(path: String?) {
        loadGeneration++
        val generation = loadGeneration
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            val result = captureApi { api.browseDirectory(path) }
            if (generation != loadGeneration) return@launch
            result.fold(
                onSuccess = { data ->
                    _state.update {
                        it.copy(
                            path = data.path,
                            pathInput = data.path,
                            parentPath = data.parentPath,
                            directories = data.directories,
                            drives = data.drives ?: emptyList(),
                            loading = false,
                            error = null,
                        )
                    }
                },
                onFailure = { error ->
                    _state.update { it.copy(loading = false, error = error.userMessage()) }
                },
            )
        }
    }

    fun setPathInput(value: String) {
        _state.update { it.copy(pathInput = value) }
    }

    fun submitPath() {
        val candidate = _state.value.pathInput.trim()
        if (candidate.isNotEmpty()) navigate(candidate)
    }

    fun setProfile(value: String) {
        _state.update { it.copy(profile = value) }
    }

    fun setAdvisor(value: Boolean) {
        _state.update { it.copy(advisor = value) }
    }

    fun setExtraArgs(value: String) {
        _state.update { it.copy(extraArgs = value) }
    }

    fun setCloneUrl(value: String) {
        _state.update { it.copy(cloneUrl = value, cloneStatus = null) }
    }

    fun launchConfig(): ProjectLaunchConfig? {
        val current = _state.value
        val args = current.extraArgs.split("\n").map { it.trim() }.filter { it.isNotEmpty() }
        val config = ProjectLaunchConfig(
            profile = current.profile.trim().takeIf { it.isNotEmpty() },
            advisor = current.advisor.takeIf { it },
            extraArgs = args.takeIf { it.isNotEmpty() },
        )
        return config.takeIf { !it.isEmpty() }
    }

    /**
     * Selects the current directory, or starts a clone and reports the new
     * checkout via [onSelected] (same as the web picker: the cloned folder is
     * the selection).
     */
    fun select(onSelected: (String, ProjectLaunchConfig?) -> Unit) {
        val current = _state.value
        if (!current.canSelect) return
        val config = launchConfig()
        if (current.cloneUrl.isBlank()) {
            onSelected(current.path, config)
            return
        }
        startClone(current.path, current.cloneUrl.trim(), config, onSelected)
    }

    private fun startClone(
        parent: String,
        url: String,
        config: ProjectLaunchConfig?,
        onSelected: (String, ProjectLaunchConfig?) -> Unit,
    ) {
        val id = UUID.randomUUID().toString()
        cloneJob?.cancel()
        cloneId = id
        cloneResponded = false
        cancelledCloneId = null
        _state.update {
            it.copy(
                cloneRunning = true,
                cloneLog = "",
                cloneStatus = "Cloning…",
                cloneUrl = "",
            )
        }
        cloneJob = viewModelScope.launch {
            try {
                val terminal = api.cloneRepo(
                    id = id,
                    parent = parent,
                    url = url,
                    onOpened = { if (cloneId == id) cloneResponded = true },
                    onCall = { call -> if (cloneId == id) cloneCall = call },
                    onOutput = { chunk ->
                        _state.update { current -> current.copy(cloneLog = appendProgress(current.cloneLog, chunk)) }
                    },
                )
                when (terminal) {
                    is CloneFrame.Done -> {
                        _state.update { it.copy(cloneStatus = "Cloned into ${terminal.path}") }
                        navigate(terminal.path)
                        onSelected(terminal.path, config)
                    }
                    is CloneFrame.Cancelled -> {
                        _state.update { it.copy(cloneStatus = "Clone cancelled: ${terminal.path}") }
                    }
                    is CloneFrame.Error -> {
                        _state.update { it.copy(cloneStatus = terminal.message) }
                    }
                    is CloneFrame.Output -> Unit
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: ApiError) {
                // Cancelling the call surfaces as a transport failure; the
                // user-initiated cancel already set the status.
                if (cancelledCloneId != id) {
                    _state.update { it.copy(cloneStatus = error.userMessage()) }
                }
            } finally {
                _state.update { it.copy(cloneRunning = false) }
                if (cloneId == id) {
                    cloneId = null
                    cloneCall = null
                }
            }
        }
    }

    /**
     * Cancels the running clone. Like the web picker, a rejected DELETE
     * always drops the stream (the server aborts on disconnect), and a 404
     * drops it only before the POST response arrived; afterwards the server
     * reports its own cleanup. Dropping cancels the HTTP call itself, because
     * a cancelled coroutine cannot interrupt the blocking read.
     */
    fun cancelClone() {
        val id = cloneId ?: return
        _state.update { it.copy(cloneStatus = "Cancelling…") }
        viewModelScope.launch {
            val dropStream = {
                cancelledCloneId = id
                _state.update { it.copy(cloneStatus = "Clone cancelled") }
                cloneCall?.cancel()
                cloneJob?.cancel()
            }
            val cancelled = captureApi { api.cancelClone(id) }
            if (cancelled.isFailure) {
                dropStream()
            } else if (cancelled.getOrThrow().not() && !cloneResponded) {
                dropStream()
            }
        }
    }

    fun reset() {
        cloneJob?.cancel()
        cloneCall?.cancel()
        cloneJob = null
        cloneCall = null
        cloneId = null
        cloneResponded = false
        cancelledCloneId = null
        loadGeneration++
        _state.value = DirectoryPickerUiState()
    }
}
