package io.github.kahme247.ompweb.domain

/**
 * Final folder name of a path, portable across `/` and `\` separators.
 * Port of `projectLabel`/`displayCwd` in `components/SessionSidebar-helpers.ts`.
 */
fun projectPathLabel(projectPath: String): String {
    val trimmed = projectPath.trimEnd('/', '\\')
    val index = maxOf(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
    return if (index >= 0) trimmed.substring(index + 1) else trimmed
}

/** Substitute the home dir prefix with `~` (no path truncation). */
fun displayCwd(cwd: String, home: String?): String =
    if (!home.isNullOrEmpty() && cwd.startsWith(home)) "~" + cwd.substring(home.length) else cwd
