package io.github.kahme247.ompweb.ui.sessions

import io.github.kahme247.ompweb.net.ExitedSession
import io.github.kahme247.ompweb.net.ManagedProject
import io.github.kahme247.ompweb.net.SessionSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionPlaceholdersTest {

    @Test
    fun `a running session without a file still gets a row`() {
        val display = withLivePlaceholders(
            sessions = emptyList(),
            runningIds = setOf("fresh"),
            runningCwds = mapOf("fresh" to "/work/app"),
            exited = emptyMap(),
            projects = listOf(ManagedProject(path = "/work/app")),
            activeCwd = null,
        )

        assertEquals(listOf("fresh"), display.map { it.id })
        assertEquals("/work/app", display.single().cwd)
        assertEquals("/work/app", display.single().projectRoot)
    }

    @Test
    fun `an exited session keeps the directory the server reported`() {
        val display = withLivePlaceholders(
            sessions = emptyList(),
            runningIds = emptySet(),
            runningCwds = emptyMap(),
            exited = mapOf("gone" to ExitedSession(id = "gone", cwd = "/work/other")),
            projects = emptyList(),
            activeCwd = "/work/active",
        )

        assertEquals("/work/other", display.single().cwd)
        assertEquals("/work/other", display.single().projectRoot)
    }

    @Test
    fun `sessions that are on disk are not duplicated and unregistered workspaces become projects`() {
        val existing = SessionSummary(id = "known", cwd = "/work/app")
        val display = withLivePlaceholders(
            sessions = listOf(existing),
            runningIds = setOf("known", "fresh"),
            runningCwds = mapOf("known" to "/work/app", "fresh" to "/work/lonely"),
            exited = emptyMap(),
            projects = listOf(ManagedProject(path = "/work/app")),
            activeCwd = null,
        )

        assertEquals(listOf("known", "fresh"), display.map { it.id })
        val projects = withWorkspaceProjects(listOf(ManagedProject(path = "/work/app")), display)
        assertEquals(listOf("/work/app", "/work/lonely"), projects.map { it.path })
    }

    @Test
    fun `a live session without any directory falls back to the active workspace`() {
        val display = withLivePlaceholders(
            sessions = emptyList(),
            runningIds = setOf("bare"),
            runningCwds = emptyMap(),
            exited = emptyMap(),
            projects = emptyList(),
            activeCwd = "/work/active",
        )

        assertEquals("/work/active", display.single().cwd)
    }

    @Test
    fun `a session without a directory has no workspace key`() {
        val display = withLivePlaceholders(
            sessions = emptyList(),
            runningIds = setOf("bare"),
            runningCwds = emptyMap(),
            exited = emptyMap(),
            projects = emptyList(),
            activeCwd = null,
        )

        assertNull(display.single().projectRoot)
    }
}
