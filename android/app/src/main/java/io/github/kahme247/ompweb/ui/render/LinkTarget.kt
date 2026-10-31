package io.github.kahme247.ompweb.ui.render

/**
 * What a click on a link in a rendered message should do.
 *
 * Mirrors the routing rules of the web's `MarkdownBody` (`components/MarkdownBody.tsx`)
 * and `lib/agent-links.ts`; the chat screen owns the actual navigation.
 */
sealed interface LinkTarget {
    /** Any link that is not a local file, an `agent://` handle or a GitHub ref. */
    data class External(val url: String) : LinkTarget

    /** A local path, already resolved and normalized like `resolveLocalFileHref`. */
    data class File(val path: String, val line: Int?) : LinkTarget

    /** `agent://…` — [handle] is the full URL, e.g. `agent://Parent/Child`. */
    data class Agent(val handle: String) : LinkTarget

    /** `#N` / `owner/repo#N`; `/issues/N` redirects to the PR when N is one. */
    data class GithubIssue(val owner: String, val repo: String, val number: Int) : LinkTarget

    /**
     * A href the app must not hand to the system: any scheme outside
     * http/https/mailto (`javascript:`, `intent:`, `content:`, …), fragments
     * and relative paths. Such links render as plain text.
     */
    data object Inert : LinkTarget
}
