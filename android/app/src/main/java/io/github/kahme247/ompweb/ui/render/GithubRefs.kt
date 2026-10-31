package io.github.kahme247.ompweb.ui.render

/**
 * Port of `lib/github-refs.ts`: links GitHub issue/PR references in prose.
 *
 * `owner/repo#N` always links; bare `#N` links only when a repository is known.
 * The lookbehind rejects references glued to words or paths (`C#12`, `file.ts#12`,
 * `a/b/c#12`, `&#123;`). Code spans, existing links and link labels are not
 * scanned — the markdown renderer only calls this for plain text runs.
 */
private val GITHUB_REF_RE = Regex(
    """(?<![\w./#&-])(?:([A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+))?#([1-9]\d{0,9})(?![\w-])""",
)

/** One `#N` occurrence found in a text run, with the target it resolves to. */
data class GithubRef(
    /** Inclusive start offset in the scanned text. */
    val start: Int,
    /** Exclusive end offset in the scanned text. */
    val end: Int,
    /** The matched source text, rendered as the link label. */
    val text: String,
    val target: LinkTarget.GithubIssue,
)

/**
 * Finds every GitHub reference in [text]. [repo] is the repository bare `#N`
 * resolves against (the session's GitHub remote, if any).
 */
fun findGithubRefs(text: String, repo: GithubRepoRef?): List<GithubRef> {
    val defaultSlug = repo?.takeIf { it.owner.isNotBlank() && it.repo.isNotBlank() }?.let { "${it.owner}/${it.repo}" }
    return GITHUB_REF_RE.findAll(text).mapNotNull { match ->
        val slug = match.groups[1]?.value ?: defaultSlug ?: return@mapNotNull null
        val owner = slug.substringBefore('/')
        val name = slug.substringAfter('/', "")
        if (owner.isEmpty() || name.isEmpty()) return@mapNotNull null
        val number = match.groups[2]?.value?.toIntOrNull() ?: return@mapNotNull null
        GithubRef(
            start = match.range.first,
            end = match.range.last + 1,
            text = match.value,
            target = LinkTarget.GithubIssue(owner = owner, repo = name, number = number),
        )
    }.toList()
}

/** `/issues/N` links a PR too, so both spellings classify as a GitHub issue. */
private val GITHUB_ISSUE_URL = Regex(
    """^https?://(?:www\.)?github\.com/([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9._-]+)/(?:issues|pull)/([1-9]\d{0,9})/?$""",
    RegexOption.IGNORE_CASE,
)

/** Classifies an explicit GitHub issue/PR URL, ignoring query strings and fragments. */
fun githubIssueFromUrl(url: String): LinkTarget.GithubIssue? {
    val clean = url.substringBefore('#').substringBefore('?').trimEnd('/')
    val match = GITHUB_ISSUE_URL.matchEntire(clean) ?: return null
    val number = match.groups[3]?.value?.toIntOrNull() ?: return null
    return LinkTarget.GithubIssue(
        owner = match.groups[1]!!.value,
        repo = match.groups[2]!!.value,
        number = number,
    )
}
