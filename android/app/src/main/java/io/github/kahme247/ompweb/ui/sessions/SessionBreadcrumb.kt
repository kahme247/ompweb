package io.github.kahme247.ompweb.ui.sessions

import io.github.kahme247.ompweb.domain.displayCwd
import io.github.kahme247.ompweb.domain.projectLabel
import io.github.kahme247.ompweb.net.ManagedProject
import io.github.kahme247.ompweb.net.SessionInfo

/**
 * The context line of the detail header (web `AppShell`'s project / cwd /
 * branch context): project label first when the session belongs to a managed
 * project, then the home-relative cwd, then the worktree branch.
 *
 * [project] is the display label (alias or shortened path); [cwd] and
 * [branch] are null when unknown, so a session outside every managed project
 * still gets a useful line.
 */
data class SessionBreadcrumb(
    val project: String?,
    val cwd: String?,
    val branch: String?,
) {
    val isEmpty: Boolean get() = project == null && cwd == null && branch == null

    /** The parts joined for the header; empty when nothing is known. */
    val text: String
        get() = listOfNotNull(project, cwd, branch).joinToString(" · ")
}

/**
 * Resolves the breadcrumb parts. A session's project is its `projectKey`
 * (the workspace the server grouped it under), else its worktree's
 * [SessionInfo.projectRoot], else the managed project whose path contains the
 * cwd — the same fallback the sidebar grouping uses.
 */
fun sessionBreadcrumb(
    info: SessionInfo,
    projects: List<ManagedProject>,
    home: String?,
    branch: String? = null,
): SessionBreadcrumb {
    val cwd = info.cwd.takeIf { it.isNotBlank() }
    val project = projects.firstOrNull { project ->
        project.path == info.projectKey ||
            project.path == info.projectRoot ||
            (cwd != null && (cwd == project.path || cwd.startsWith(project.path.trimEnd('/', '\\') + "/") ||
                cwd.startsWith(project.path.trimEnd('/', '\\') + "\\")))
    }
    return SessionBreadcrumb(
        project = project?.let(::projectLabel),
        cwd = cwd?.let { displayCwd(it, home) },
        branch = (branch ?: info.worktreeBranch)?.takeIf { it.isNotBlank() },
    )
}
