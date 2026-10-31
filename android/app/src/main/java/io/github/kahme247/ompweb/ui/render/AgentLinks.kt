package io.github.kahme247.ompweb.ui.render

/**
 * Port of `lib/agent-links.ts`: `agent://<id>[/<child>...]` handles omp
 * advertises for subagent output. A trailing sentence period is never part of
 * a match, and the write-only broadcast address is never linked.
 */
private const val SEGMENT = """[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*"""
private const val AGENT_URL_SOURCE = "agent://$SEGMENT(?:/$SEGMENT)*"

/** The lookbehind rejects handles glued to words or paths (`xagent://`, `a/agent://`). */
private val AGENT_URL_PROSE_RE = Regex("""(?<![\w/])$AGENT_URL_SOURCE""")
private val AGENT_URL_EXACT_RE = Regex("^$AGENT_URL_SOURCE$")
private val AGENT_HREF_RE = Regex("""^agent://($SEGMENT)((?:/[^?#]*)?)(?:[?#].*)?$""")
private val CHILD_SEGMENT_RE = Regex("""^[A-Za-z0-9_-]+$""")

/** omp's write-only broadcast address: reading it fails, so it is never linked. */
const val BROADCAST_AGENT_URL: String = "agent://all"

/** True when [href] names a subagent handle (broadcast included; see [findAgentHandles]). */
fun isAgentHref(href: String?): Boolean = href != null && AGENT_HREF_RE.matches(href)

/** True when [text] is exactly one subagent handle (inline-code linking rule). */
fun isExactAgentHandle(text: String): Boolean =
    text != BROADCAST_AGENT_URL && AGENT_URL_EXACT_RE.matches(text)

/** Half-open offsets of every bare `agent://` handle in a plain text run. */
fun findAgentHandles(text: String): List<IntRange> =
    AGENT_URL_PROSE_RE.findAll(text)
        .filter { it.value != BROADCAST_AGENT_URL }
        .map { it.range }
        .toList()

/**
 * Subagent ids an `agent://` href may name, most specific first. Mirrors omp's
 * resolver: `agent://Parent/Child` names `Parent.Child` when that output
 * exists, else the slash path is JSON extraction on `Parent`.
 */
fun agentLinkIds(href: String?): List<String> {
    if (href == null) return emptyList()
    val match = AGENT_HREF_RE.matchEntire(href) ?: return emptyList()
    val id = match.groups[1]!!.value
    if ("agent://$id" == BROADCAST_AGENT_URL) return emptyList()
    val path = match.groups[2]?.value.orEmpty()
    val segments = path.split('/').filter { it.isNotEmpty() }
    if (segments.isNotEmpty() && segments.all { CHILD_SEGMENT_RE.matches(it) }) {
        return listOf((listOf(id) + segments).joinToString("."), id)
    }
    return listOf(id)
}

/**
 * The link target for an `agent://` handle, or null for the broadcast address
 * and for hrefs that are not subagent handles.
 */
fun agentLinkTarget(href: String?): LinkTarget.Agent? =
    if (isAgentHref(href) && agentLinkIds(href).isNotEmpty()) LinkTarget.Agent(href!!) else null
