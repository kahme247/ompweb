package io.github.kahme247.ompweb.domain

import io.github.kahme247.ompweb.net.ManagedProject
import io.github.kahme247.ompweb.net.SessionSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Ports the filter in `components/SessionSidebar.tsx` (`visibleProjectEntries`):
 * `(s.name ?? "").includes(q) || s.firstMessage.includes(q)` plus the
 * label/alias clause that keeps a matching workspace visible.
 */
class SessionSearchTest {

    private fun session(
        id: String,
        name: String? = null,
        firstMessage: String = "hi",
        cwd: String = "/work/$id",
    ) = SessionSummary(
        id = id,
        path = "/sessions/$id.jsonl",
        cwd = cwd,
        name = name,
        created = "2026-01-01T00:00:00.000Z",
        modified = "2026-01-01T00:00:00.000Z",
        messageCount = 1,
        firstMessage = firstMessage,
    )

    @Test
    fun `a session without a stored title is found through its first message`() {
        val untitled = session("a", name = null, firstMessage = "Wie deploye ich den Server?")
        assertTrue(sessionMatchesSearch(untitled, "deploye"))
        assertTrue(sessionMatchesSearch(untitled, "DEPLOYE"))
        assertTrue(sessionMatchesSearch(untitled, "  deploye  "))
        assertFalse(sessionMatchesSearch(untitled, "rollback"))
    }

    @Test
    fun `the whole first message is searched, not only its first line or 120 characters`() {
        val long = session(
            "b",
            firstMessage = "Erste Zeile ohne Treffer\n".repeat(10) + "versteckter Suchbegriff am Ende",
        )
        assertTrue(sessionMatchesSearch(long, "versteckter suchbegriff"))
    }

    @Test
    fun `a stored title matches too`() {
        val titled = session("c", name = "Release-Vorbereitung", firstMessage = "die antwort steht im chat")
        assertTrue(sessionMatchesSearch(titled, "release"))
        assertTrue(sessionMatchesSearch(titled, "antwort"))
        assertFalse(sessionMatchesSearch(titled, "rollback"))
    }

    @Test
    fun `path, cwd and id are not searched, exactly like the web`() {
        val s = session("01abc", name = null, firstMessage = "hello", cwd = "/ssd/projects/quantum")
        assertFalse(sessionMatchesSearch(s, "quantum"))
        assertFalse(sessionMatchesSearch(s, "01abc"))
        assertFalse(sessionMatchesSearch(s, "/ssd"))
    }

    @Test
    fun `an empty query keeps every session`() {
        assertTrue(sessionMatchesSearch(session("d"), ""))
        assertTrue(sessionMatchesSearch(session("d"), "   "))
    }

    @Test
    fun `a workspace with no matching sessions stays visible when its label or alias matches`() {
        val projects = listOf(
            ManagedProject(path = "/work/quantum-lab"),
            ManagedProject(path = "/work/other", alias = "Mein Projekt"),
        )
        val byProject = mapOf(
            "/work/quantum-lab" to listOf(session("x", firstMessage = "nothing")),
            "/work/other" to emptyList(),
        )

        val labelMatch = visibleSessionEntries(projects, byProject, runningOnly = false, runningIds = emptySet(), query = "quantum")
        assertEquals(listOf("/work/quantum-lab"), labelMatch.map { it.first.path })
        assertTrue(labelMatch.single().second.isEmpty())

        val aliasMatch = visibleSessionEntries(projects, byProject, runningOnly = false, runningIds = emptySet(), query = "mein projekt")
        assertEquals(listOf("/work/other"), aliasMatch.map { it.first.path })

        val noMatch = visibleSessionEntries(projects, byProject, runningOnly = false, runningIds = emptySet(), query = "zzz")
        assertTrue(noMatch.isEmpty())
    }

    @Test
    fun `sessions are filtered per project and keep project order`() {
        val projects = listOf(ManagedProject(path = "/work/alpha"), ManagedProject(path = "/work/beta"))
        val byProject = mapOf(
            "/work/alpha" to listOf(session("1", firstMessage = "match here"), session("2", firstMessage = "nope")),
            "/work/beta" to listOf(session("3", firstMessage = "another match")),
        )
        val entries = visibleSessionEntries(projects, byProject, runningOnly = false, runningIds = emptySet(), query = "match")
        assertEquals(listOf("/work/alpha", "/work/beta"), entries.map { it.first.path })
        assertEquals(listOf("1"), entries[0].second.map { it.id })
        assertEquals(listOf("3"), entries[1].second.map { it.id })
    }

    @Test
    fun `running only hides workspaces without a running session`() {
        val projects = listOf(ManagedProject(path = "/work/alpha"), ManagedProject(path = "/work/beta"))
        val byProject = mapOf(
            "/work/alpha" to listOf(session("1")),
            "/work/beta" to listOf(session("2")),
        )
        val entries = visibleSessionEntries(
            projects,
            byProject,
            runningOnly = true,
            runningIds = setOf("2"),
            query = "",
        )
        assertEquals(listOf("/work/beta"), entries.map { it.first.path })
    }

    @Test
    fun `without a filter every workspace stays visible even without sessions`() {
        val projects = listOf(ManagedProject(path = "/work/empty"), ManagedProject(path = "/work/full"))
        val byProject = mapOf("/work/full" to listOf(session("1")))
        val entries = visibleSessionEntries(projects, byProject, runningOnly = false, runningIds = emptySet(), query = "")
        assertEquals(listOf("/work/empty", "/work/full"), entries.map { it.first.path })
    }
}
