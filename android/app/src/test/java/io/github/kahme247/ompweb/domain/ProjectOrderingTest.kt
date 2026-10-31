package io.github.kahme247.ompweb.domain

import io.github.kahme247.ompweb.net.ManagedProject
import io.github.kahme247.ompweb.net.SessionSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Ports `lib/project-ordering.test.mjs` case by case. */
class ProjectOrderingTest {

    private fun session(id: String, overrides: SessionSummary.() -> SessionSummary = { this }) =
        SessionSummary(
            id = id,
            path = "/sessions/$id.jsonl",
            cwd = "/work/$id",
            created = "2026-01-01T00:00:00.000Z",
            modified = "2026-01-01T00:00:00.000Z",
            messageCount = 1,
            firstMessage = "hi",
        ).overrides()

    @Test
    fun `sorts registered projects by most-recently-added, tie-broken by path`() {
        val projects = listOf(
            ManagedProject(path = "/proj/oldest", addedAt = "2026-01-01T00:00:00.000Z"),
            ManagedProject(path = "/proj/newest", addedAt = "2026-03-01T00:00:00.000Z"),
            ManagedProject(path = "/proj/middle", addedAt = "2026-02-01T00:00:00.000Z"),
        )
        assertEquals(
            listOf("/proj/newest", "/proj/middle", "/proj/oldest"),
            sortManagedProjects(projects).map { it.path },
        )
    }

    @Test
    fun `manual workspace order overrides add time and remains stable`() {
        val projects = listOf(
            ManagedProject(path = "/proj/new", addedAt = "2026-03-01T00:00:00.000Z", sortOrder = 1),
            ManagedProject(path = "/proj/old", addedAt = "2026-01-01T00:00:00.000Z", sortOrder = 0),
        )
        assertEquals(listOf("/proj/old", "/proj/new"), sortManagedProjects(projects).map { it.path })
    }

    @Test
    fun `project order is stable regardless of session activity`() {
        val projects = listOf(
            ManagedProject(path = "/proj/a", addedAt = "2026-01-01T00:00:00.000Z"),
            ManagedProject(path = "/proj/b", addedAt = "2026-02-01T00:00:00.000Z"),
        )
        val sessions = listOf(
            session("s-a") { copy(modified = "2026-06-01T00:00:00.000Z", projectRoot = "/proj/a") },
            session("s-b") { copy(modified = "2026-03-01T00:00:00.000Z", projectRoot = "/proj/b") },
        )
        assertEquals(listOf("/proj/b", "/proj/a"), sortManagedProjects(projects).map { it.path })
        assertEquals(listOf("/proj/b", "/proj/a"), sortManagedProjects(projects).map { it.path })
        assertEquals(2, sessions.size)
    }

    @Test
    fun `session-discovered projects without addedAt sort below registered, by path`() {
        val projects = listOf(
            ManagedProject(path = "/proj/registered"),
            ManagedProject(path = "/proj/active", addedAt = "2026-01-01T00:00:00.000Z"),
            ManagedProject(path = "/proj/inactive", addedAt = "2026-02-01T00:00:00.000Z"),
            ManagedProject(path = "/proj/zzz"),
        )
        assertEquals(
            listOf("/proj/inactive", "/proj/active", "/proj/registered", "/proj/zzz"),
            sortManagedProjects(projects).map { it.path },
        )
    }

    @Test
    fun `groups sessions under their project, including worktree sessions`() {
        val projects = listOf(
            ManagedProject(path = "/repo", addedAt = "2026-01-01T00:00:00.000Z"),
            ManagedProject(path = "/empty", addedAt = "2026-02-01T00:00:00.000Z"),
            ManagedProject(path = "/other"),
        )
        val sessions = listOf(
            session("wt") { copy(cwd = "/repo-worktrees/feature", projectRoot = "/repo") },
            session("fork") { copy(parentSessionId = "parent", projectRoot = "/other") },
            session("parent") { copy(projectRoot = "/other") },
        )
        val grouped = groupSessionsByProject(projects, sessions)
        assertEquals(listOf("wt"), grouped.getValue("/repo").map { it.id })
        assertEquals(emptyList<SessionSummary>(), grouped.getValue("/empty"))
        assertEquals(
            listOf("fork", "parent"),
            grouped.getValue("/other").map { it.id }.sorted(),
        )
    }

    @Test
    fun `projectActivityCounts tallies running, unread, and exited sessions per project`() {
        val sessions = listOf(
            session("running-main") { copy(projectRoot = "/repo") },
            session("unread-main") { copy(projectRoot = "/repo") },
            session("exited-main") { copy(projectRoot = "/repo") },
            session("running-wt") { copy(cwd = "/repo-worktrees/x", projectRoot = "/repo") },
            session("idle-other") { copy(projectRoot = "/other") },
        )
        val counts = projectActivityCounts(
            sessions,
            listOf("running-main", "running-wt"),
            listOf("unread-main"),
            listOf("exited-main"),
        )
        assertEquals(
            ProjectActivity(running = 2, unread = 1, exited = 1),
            counts.getValue(comparableProjectPath("/repo")),
        )
        assertEquals(ProjectActivity(), counts.getValue(comparableProjectPath("/other")))
    }

    @Test
    fun `casing-only projectRoot differences still group and tally on Windows`() {
        val projects = listOf(ManagedProject(path = "D:\\OtherProjects\\Waku", addedAt = "2026-01-01T00:00:00.000Z"))
        val sessions = listOf(session("s1") { copy(projectRoot = "d:\\otherprojects\\waku") })
        val grouped = groupSessionsByProject(projects, sessions)
        assertEquals(listOf("s1"), grouped.getValue("D:\\OtherProjects\\Waku").map { it.id })
        val counts = projectActivityCounts(sessions, listOf("s1"), emptyList())
        assertEquals(
            ProjectActivity(running = 1),
            counts.getValue(comparableProjectPath("d:\\otherprojects\\waku")),
        )
    }

    @Test
    fun `running session placeholders group stably under their own project cwd, not active workspace`() {
        val projects = listOf(
            ManagedProject(path = "/project-a", addedAt = "2026-01-01T00:00:00.000Z"),
            ManagedProject(path = "/project-b", addedAt = "2026-02-01T00:00:00.000Z"),
            ManagedProject(path = "/project-c", addedAt = "2026-03-01T00:00:00.000Z"),
        )
        val visible = listOf(
            session("session-b") { copy(projectRoot = "/project-b") },
            session("session-c") { copy(projectRoot = "/project-c") },
            session("running-in-a") { copy(path = "", cwd = "/project-a", projectRoot = "/project-a") },
        )
        val grouped = groupSessionsByProject(projects, visible)
        assertEquals(listOf("running-in-a"), grouped.getValue("/project-a").map { it.id })
        assertEquals(listOf("session-b"), grouped.getValue("/project-b").map { it.id })
        assertEquals(listOf("session-c"), grouped.getValue("/project-c").map { it.id })
    }

    @Test
    fun `workspaceKeyOf prefers projectKey then projectRoot then cwd`() {
        assertEquals("key", workspaceKeyOf(session("a") { copy(projectKey = "key", projectRoot = "root", cwd = "cwd") }))
        assertEquals("root", workspaceKeyOf(session("a") { copy(projectRoot = "root", cwd = "cwd") }))
        assertEquals("cwd", workspaceKeyOf(session("a") { copy(cwd = "cwd") }))
        assertTrue(comparableProjectPath("C:/Repo") == comparableProjectPath("c:\\repo\\"))
    }
}
