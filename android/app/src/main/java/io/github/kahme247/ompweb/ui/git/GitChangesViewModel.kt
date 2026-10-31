package io.github.kahme247.ompweb.ui.git

import io.github.kahme247.ompweb.domain.GitFileStatus
import io.github.kahme247.ompweb.domain.pickGitSelection
import io.github.kahme247.ompweb.net.GitApi
import io.github.kahme247.ompweb.net.captureApi
import io.github.kahme247.ompweb.net.userMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** What the Git tab renders (web `GitChangesPanel` state, minus the inline diff). */
data class GitChangesState(
    /** The directory the list belongs to; the pane opens files in Diff mode against it. */
    val cwd: String? = null,
    val files: List<GitFileStatus> = emptyList(),
    val isRepo: Boolean = false,
    val loading: Boolean = false,
    /** A load for [cwd] has finished (successfully or not); before that the pane shows a spinner. */
    val loaded: Boolean = false,
    /** Display-ready failure of the last load (web "Failed to load changes"). */
    val error: String? = null,
    val filter: String = "",
    val selectedPath: String? = null,
    /** `.gitattributes` rows are folded behind a row; the web opens the group when only those changed. */
    val attributeGroupOpen: Boolean = false,
)

/**
 * The changed files of one workspace (`GET /api/git/status`), plus the web's
 * list rules: filter/clear, refresh, keep-or-pick the previewed file, and the
 * `.gitattributes` group.
 *
 * It owns no diff: selecting a row opens Slice A's viewer in Diff mode, which
 * fetches `GET /api/git/diff` through [GitApi.diff].
 *
 * [bind] is idempotent per cwd, so the pane may call it from a
 * `LaunchedEffect(cwd)` on every recomposition boundary; a late answer for a
 * cwd that is no longer bound is dropped.
 */
class GitChangesViewModel(
    private val api: GitApi,
    private val scope: CoroutineScope,
) {

    private val _state = MutableStateFlow(GitChangesState())
    val state: StateFlow<GitChangesState> = _state.asStateFlow()

    private var boundCwd: String? = null
    private var requestGeneration = 0L

    /** Loads [cwd] once; a repeated call for the same cwd is a no-op. */
    fun bind(cwd: String?) {
        if (cwd == boundCwd && _state.value.loaded) return
        boundCwd = cwd
        _state.value = GitChangesState(cwd = cwd, filter = _state.value.filter)
        load(cwd)
    }

    /**
     * The tab was (re)entered — the panel builds only the visible tab, so this
     * is the web's reload-on-mount (`GitChangesPanel`'s `useEffect([cwd,
     * refreshKey])`): a new cwd binds, the same cwd reloads instead of showing
     * the list from the last visit.
     */
    fun activate(cwd: String?) {
        if (cwd == boundCwd && _state.value.loaded) {
            refresh()
        } else {
            bind(cwd)
        }
    }

    /** Reloads the bound cwd, keeping the filter and the previewed file while it still exists. */
    fun refresh() {
        if (boundCwd == null) return
        load(boundCwd)
    }

    fun setFilter(value: String) {
        _state.update { it.copy(filter = value) }
    }

    fun clearFilter() {
        _state.update { it.copy(filter = "") }
    }

    fun select(path: String?) {
        _state.update { it.copy(selectedPath = path) }
    }

    fun toggleAttributeGroup() {
        _state.update { it.copy(attributeGroupOpen = !it.attributeGroupOpen) }
    }

    private fun load(cwd: String?) {
        requestGeneration++
        val generation = requestGeneration
        if (cwd.isNullOrBlank()) {
            _state.update { it.copy(loading = false, loaded = true, isRepo = false, files = emptyList(), selectedPath = null) }
            return
        }
        _state.update { it.copy(cwd = cwd, loading = true, error = null) }
        scope.launch {
            val result = captureApi { api.status(cwd) }
            if (generation != requestGeneration) return@launch
            result.fold(
                onSuccess = { response ->
                    val files = if (response.isGitRepository) response.files else emptyList()
                    _state.update { current ->
                        if (current.cwd != cwd) {
                            current
                        } else {
                            current.copy(
                                loading = false,
                                loaded = true,
                                isRepo = response.isGitRepository,
                                files = files,
                                selectedPath = pickGitSelection(current.selectedPath, files),
                                // The web force-opens the group when nothing else is reviewable.
                                attributeGroupOpen = current.attributeGroupOpen ||
                                    (files.isNotEmpty() && files.all { it.collapseReason != null }),
                                error = null,
                            )
                        }
                    }
                },
                onFailure = { error ->
                    _state.update { current ->
                        if (current.cwd != cwd) {
                            current
                        } else {
                            current.copy(
                                loading = false,
                                loaded = true,
                                isRepo = false,
                                files = emptyList(),
                                selectedPath = null,
                                error = error.userMessage(),
                            )
                        }
                    }
                },
            )
        }
    }
}
