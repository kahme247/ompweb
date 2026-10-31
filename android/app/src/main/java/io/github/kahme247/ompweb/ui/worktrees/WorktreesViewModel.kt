package io.github.kahme247.ompweb.ui.worktrees

import android.content.Context
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.WorktreeFailure
import io.github.kahme247.ompweb.domain.canRemoveWorktree
import io.github.kahme247.ompweb.domain.comparableProjectPath
import io.github.kahme247.ompweb.domain.currentWorktreePath
import io.github.kahme247.ompweb.domain.isWorktreeContextAvailable
import io.github.kahme247.ompweb.domain.validateWorktreeBranch
import io.github.kahme247.ompweb.domain.withCreatedWorktree
import io.github.kahme247.ompweb.domain.withoutWorktree
import io.github.kahme247.ompweb.domain.worktreeCwdAfterRemove
import io.github.kahme247.ompweb.domain.worktreeFailure
import io.github.kahme247.ompweb.net.WorktreeEntry
import io.github.kahme247.ompweb.net.WorktreeList
import io.github.kahme247.ompweb.net.WorktreesApi
import io.github.kahme247.ompweb.net.captureApi
import io.github.kahme247.ompweb.net.userMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Display strings for the failures the client words itself; the rest come from the server. */
data class WorktreeStrings(
    val branchRequired: String = "Enter a branch name.",
    val invalidBranch: String = "Invalid branch name.",
    val directoryExists: String = "That checkout directory already exists.",
    val notAWorktree: String = "That directory is not a worktree of this repository.",
    val cannotRemoveMain: String = "The main worktree cannot be removed.",
    val accessDenied: String = "Access denied.",
    val directoryNotFound: String = "That directory does not exist.",
    val dirty: String = "The worktree has uncommitted changes.",
) {
    companion object {
        fun from(context: Context): WorktreeStrings {
            val app = context.applicationContext
            return WorktreeStrings(
                branchRequired = app.getString(R.string.worktree_error_branch_required),
                invalidBranch = app.getString(R.string.worktree_error_invalid_branch),
                directoryExists = app.getString(R.string.worktree_error_directory_exists),
                notAWorktree = app.getString(R.string.worktree_error_not_a_worktree),
                cannotRemoveMain = app.getString(R.string.worktree_error_cannot_remove_main),
                accessDenied = app.getString(R.string.worktree_error_access_denied),
                directoryNotFound = app.getString(R.string.worktree_error_directory_not_found),
                dirty = app.getString(R.string.worktree_error_dirty),
            )
        }
    }
}

/**
 * The active repo's worktrees, as the web's `WorktreeContext` hands them to
 * `WorktreesPanel` and the new-session `<select>`.
 *
 * [projectRoot] stays `null` for a non-Git directory and for a plain repo
 * subdirectory: the pane then shows the "Git repository roots only" state and
 * the shell may hide the tab. The active repo's list is never mixed with
 * another repo's (see [WorktreeCache]).
 */
data class WorktreeContextState(
    val projectRoot: String? = null,
    val worktrees: List<WorktreeEntry> = emptyList(),
    val currentPath: String? = null,
    val loading: Boolean = false,
    val error: String? = null,
    /** A load for the bound cwd finished (successfully or not). */
    val ready: Boolean = false,
    /** A create/remove is in flight. */
    val busy: Boolean = false,
    /** A dirty worktree: ask before removing it with `force` (409 `worktree_dirty`). */
    val confirmRemove: String? = null,
) {
    val available: Boolean get() = projectRoot != null
}

/**
 * List/create/remove/switch the worktrees of the bound repo
 * (`components/WorktreesPanel.tsx` over `GET/POST/DELETE /api/worktrees`).
 *
 * - Switching never touches the open session: it emits the new path on
 *   [switched] so the shell moves the effective/new-session cwd.
 * - Creating selects the new checkout (`<repoRoot>-worktrees/<branch>`, the
 *   server picks the path) and refreshes the list; the row appears immediately.
 * - Removing asks first when git answers 409 `worktree_dirty` (force flow) and
 *   refuses the main worktree. Removing the current checkout moves the
 *   effective cwd back to the main checkout.
 * - Lists come from [WorktreeCache], the same cache the new-session select uses.
 */
class WorktreesViewModel(
    private val api: WorktreesApi,
    private val scope: CoroutineScope,
    val cache: WorktreeCache = WorktreeCache(api),
    private val strings: WorktreeStrings = WorktreeStrings(),
) {

    private val _state = MutableStateFlow(WorktreeContextState())
    val state: StateFlow<WorktreeContextState> = _state.asStateFlow()

    private val switchedPaths = MutableSharedFlow<String>(
        extraBufferCapacity = 8,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    /** The effective cwd after a switch/create/remove-current; collect to move it. */
    val switched: SharedFlow<String> = switchedPaths.asSharedFlow()

    private var boundCwd: String? = null
    private var requestGeneration = 0L

    /** Loads the worktrees of [cwd] once; a repeated call for the same cwd is a no-op. */
    fun load(cwd: String?) {
        if (cwd == boundCwd && _state.value.ready) return
        boundCwd = cwd
        requestGeneration++
        val generation = requestGeneration
        if (cwd.isNullOrBlank()) {
            _state.value = WorktreeContextState(ready = true)
            return
        }
        _state.update { it.copy(loading = true, error = null, confirmRemove = null) }
        scope.launch {
            val result = captureApi { cache.list(cwd) }
            if (generation != requestGeneration) return@launch
            result.fold(
                onSuccess = { list ->
                    _state.value = contextOf(list, cwd)
                },
                onFailure = { error ->
                    // Keep whatever this repo already had on screen; the pane
                    // shows the failure with a retry above the list.
                    _state.update {
                        it.copy(loading = false, ready = true, error = error.userMessage())
                    }
                },
            )
        }
    }

    /** Re-fetches the bound repo's list (manual refresh / after a server-side change). */
    fun refresh() {
        val root = _state.value.projectRoot ?: boundCwd ?: return
        requestGeneration++
        val generation = requestGeneration
        _state.update { it.copy(loading = true, error = null) }
        scope.launch {
            val result = captureApi { cache.list(root, force = true) }
            if (generation != requestGeneration) return@launch
            result.fold(
                onSuccess = { list -> _state.value = contextOf(list, _state.value.currentPath ?: root) },
                onFailure = { error -> _state.update { it.copy(loading = false, error = error.userMessage()) } },
            )
        }
    }

    /** Moves the effective cwd to [path]; the open session keeps its own cwd. */
    fun select(path: String) {
        if (!_state.value.available) return
        _state.update { it.copy(currentPath = path, error = null) }
        switchedPaths.tryEmit(path)
    }

    /** `POST /api/worktrees`: create or reuse the branch's checkout and switch to it. */
    fun create(branch: String) {
        val current = _state.value
        val root = current.projectRoot ?: return
        if (current.busy) return
        validateWorktreeBranch(branch)?.let { failure ->
            _state.update { it.copy(error = messageFor(failure)) }
            return
        }
        _state.update { it.copy(busy = true, error = null, confirmRemove = null) }
        scope.launch {
            val result = captureApi { api.create(root, branch.trim()) }
            if (!isCurrent(root)) {
                _state.update { it.copy(busy = false) }
                return@launch
            }
            result.fold(
                onSuccess = { created ->
                    // Optimistic, like the web: the new checkout is selected at once.
                    _state.update {
                        it.copy(
                            busy = false,
                            worktrees = withCreatedWorktree(it.worktrees, created),
                            currentPath = created.path,
                        )
                    }
                    switchedPaths.tryEmit(created.path)
                    adopt(root, created.path)
                },
                onFailure = { error ->
                    _state.update { it.copy(busy = false, error = messageFor(worktreeFailure(error))) }
                },
            )
        }
    }

    /** `DELETE /api/worktrees`; a dirty worktree needs a second, forced call. */
    fun remove(path: String, force: Boolean = false) {
        val current = _state.value
        val root = current.projectRoot ?: return
        if (current.busy) return
        val target = current.worktrees.firstOrNull { comparableProjectPath(it.path) == comparableProjectPath(path) }
        if (target != null && !canRemoveWorktree(target)) {
            _state.update { it.copy(error = messageFor(WorktreeFailure.CannotRemoveMain)) }
            return
        }
        _state.update { it.copy(busy = true, error = null, confirmRemove = null) }
        scope.launch {
            val result = captureApi { api.remove(root, path, force) }
            if (!isCurrent(root)) {
                _state.update { it.copy(busy = false) }
                return@launch
            }
            result.fold(
                onSuccess = {
                    val previousCurrent = _state.value.currentPath
                    val nextCurrent = worktreeCwdAfterRemove(root, path, previousCurrent) ?: previousCurrent
                    _state.update {
                        it.copy(
                            busy = false,
                            worktrees = withoutWorktree(it.worktrees, path),
                            currentPath = nextCurrent,
                            confirmRemove = null,
                        )
                    }
                    // A removed checkout must never stay the effective cwd.
                    if (nextCurrent != null && nextCurrent != previousCurrent) {
                        switchedPaths.tryEmit(nextCurrent)
                    }
                    adopt(root, nextCurrent)
                },
                onFailure = { error ->
                    val failure = worktreeFailure(error)
                    if (failure == WorktreeFailure.Dirty && !force) {
                        // git refused; ask before retrying with force.
                        _state.update { it.copy(busy = false, confirmRemove = path, error = null) }
                    } else {
                        _state.update { it.copy(busy = false, error = messageFor(failure)) }
                    }
                },
            )
        }
    }

    /** Dismisses the force-remove prompt. */
    fun cancelRemove() {
        _state.update { it.copy(confirmRemove = null) }
    }

    /** Drops the inline error when the input changes or the prompt is dismissed. */
    fun clearError() {
        _state.update { it.copy(error = null) }
    }

    /** The callbacks the pane binds its controls to. */
    fun actions(): WorktreeActions = WorktreeActions(
        onSwitch = ::select,
        onCreate = ::create,
        onRemove = { path, force -> remove(path, force) },
        onCancelRemove = ::cancelRemove,
        onRefresh = ::refresh,
        onClearError = ::clearError,
    )

    /**
     * Re-fetches the list after a successful mutation. A failed refresh keeps
     * the optimistic row instead of turning a successful create/remove into an
     * error (the web's refresh is fire-and-forget as well).
     */
    private fun adopt(root: String, preferredCurrent: String?) {
        cache.invalidate()
        scope.launch {
            val result = captureApi { cache.list(root, force = true) }
            if (!isCurrent(root)) return@launch
            result.fold(
                onSuccess = { list ->
                    val next = contextOf(list, preferredCurrent)
                    _state.update {
                        it.copy(
                            worktrees = next.worktrees,
                            currentPath = next.currentPath,
                            projectRoot = next.projectRoot,
                            ready = true,
                            loading = false,
                            busy = false,
                        )
                    }
                },
                onFailure = { /* keep the optimistic state */ },
            )
        }
    }

    private fun isCurrent(root: String): Boolean {
        val projectRoot = _state.value.projectRoot ?: return false
        return comparableProjectPath(projectRoot) == comparableProjectPath(root)
    }

    private fun contextOf(list: WorktreeList, cwd: String?): WorktreeContextState {
        val available = isWorktreeContextAvailable(list)
        val worktrees = if (available) list.worktrees else emptyList()
        return WorktreeContextState(
            projectRoot = list.projectRoot.takeIf { available },
            worktrees = worktrees,
            currentPath = if (available) currentWorktreePath(worktrees, cwd) else null,
            ready = true,
        )
    }

    private fun messageFor(failure: WorktreeFailure): String = when (failure) {
        WorktreeFailure.Dirty -> strings.dirty
        WorktreeFailure.BranchRequired -> strings.branchRequired
        WorktreeFailure.InvalidBranchName -> strings.invalidBranch
        WorktreeFailure.DirectoryExists -> strings.directoryExists
        WorktreeFailure.NotAWorktree -> strings.notAWorktree
        WorktreeFailure.CannotRemoveMain -> strings.cannotRemoveMain
        WorktreeFailure.AccessDenied -> strings.accessDenied
        WorktreeFailure.DirectoryNotFound -> strings.directoryNotFound
        is WorktreeFailure.Other -> failure.message
    }
}
