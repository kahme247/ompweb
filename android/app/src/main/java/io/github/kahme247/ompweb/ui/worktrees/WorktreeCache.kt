package io.github.kahme247.ompweb.ui.worktrees

import io.github.kahme247.ompweb.domain.comparableProjectPath
import io.github.kahme247.ompweb.net.WorktreeList
import io.github.kahme247.ompweb.net.WorktreesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * The one worktree cache (AGENTS.md "Worktrees and project grouping", web
 * `SessionSidebar`'s per-repo `worktreeStateByProject`): the Worktrees tab and
 * the new-session worktree select read the same entries instead of fetching a
 * second list.
 *
 * Entries are keyed by the repo's `projectRoot`, so a switch to another repo
 * cannot leak the previous repo's worktrees into the new one — a cwd (main
 * checkout, linked worktree or session dir) resolves to its repo first.
 */
class WorktreeCache(private val api: WorktreesApi) {

    private val lock = Any()
    private val byProject = mutableMapOf<String, WorktreeList>()
    private val projectByCwd = mutableMapOf<String, String>()

    private val _revision = MutableStateFlow(0L)

    /**
     * Bumped whenever a list is stored. Consumers that render a worktree list
     * of their own (the new-session select) follow this instead of polling, so
     * a create/remove in the Files panel reaches an already open pane.
     */
    val revision: StateFlow<Long> = _revision.asStateFlow()

    /** The cached list for [cwd] (its own project root or any of its worktrees), if any. */
    fun cached(cwd: String): WorktreeList? = synchronized(lock) {
        val key = projectByCwd[comparableProjectPath(cwd)]
        if (key != null) byProject[key] else byProject[comparableProjectPath(cwd)]
    }

    /**
     * The list for [cwd]: cached when present, fetched otherwise. [force]
     * bypasses the cache after a create/remove (or a manual refresh).
     */
    suspend fun list(cwd: String, force: Boolean = false): WorktreeList {
        if (!force) cached(cwd)?.let { return it }
        val list = api.list(cwd)
        put(cwd, list)
        return list
    }

    /** Registers a server answer (or an optimistic update) under its project root. */
    fun put(cwd: String, list: WorktreeList) {
        val projectKey = comparableProjectPath(list.projectRoot.ifBlank { cwd })
        synchronized(lock) {
            byProject[projectKey] = list
            projectByCwd[comparableProjectPath(cwd)] = projectKey
            for (entry in list.worktrees) {
                projectByCwd[comparableProjectPath(entry.path)] = projectKey
            }
        }
        _revision.update { it + 1 }
    }

    /** Drops every entry; call after a create/remove or a workspace switch. */
    fun invalidate() {
        synchronized(lock) {
            byProject.clear()
            projectByCwd.clear()
        }
    }
}
