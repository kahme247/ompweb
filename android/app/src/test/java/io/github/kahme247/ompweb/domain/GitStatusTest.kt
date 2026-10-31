package io.github.kahme247.ompweb.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Parity tests for `lib/git-types.ts` + `lib/git-changes.test.mjs`
 * (`classifyGitStatus`, the badge codes) applied to the Android side: the
 * client parses the route's answer, never porcelain output — git runs on the
 * server.
 */
class GitStatusTest {

    private val statusBody = """
        {
          "isGitRepository": true,
          "repositoryRoot": "C:/work/repo",
          "files": [
            {"filePath": "C:/work/repo/src/App.tsx", "status": "modified", "code": "M", "indexStatus": " ", "worktreeStatus": "M"},
            {"filePath": "C:/work/repo/notes.txt", "status": "untracked", "code": "U", "indexStatus": "?", "worktreeStatus": "?"},
            {"filePath": "C:/work/repo/graph.json", "status": "modified", "code": "M", "indexStatus": " ", "worktreeStatus": "M", "collapseReason": "no-diff"},
            {"filePath": "C:/work/repo/docs/a.md", "status": "added", "code": "A", "indexStatus": "A", "worktreeStatus": " ", "collapseReason": "documentation"}
          ]
        }
    """.trimIndent()

    @Test
    fun `parses the status route into rows`() {
        val parsed = parseGitStatusResponse(statusBody)!!

        assertTrue(parsed.isGitRepository)
        assertEquals("C:/work/repo", parsed.repositoryRoot)
        assertEquals(4, parsed.files.size)
        assertEquals(GitFileStatusKind.MODIFIED, parsed.files[0].status)
        assertEquals("M", parsed.files[0].code)
        assertEquals("U", parsed.files[1].code)
        assertEquals(GitCollapseReason.NO_DIFF, parsed.files[2].collapseReason)
        assertEquals(GitCollapseReason.DOCUMENTATION, parsed.files[3].collapseReason)
    }

    @Test
    fun `maps every status kind to the web badge code`() {
        // lib/git-changes.test.mjs "classifies Git status for explorer badges".
        assertEquals(GitFileStatusKind.MODIFIED, GitFileStatusKind.fromWire("modified"))
        assertEquals(GitFileStatusKind.UNTRACKED, GitFileStatusKind.fromWire("untracked"))
        assertEquals(GitFileStatusKind.ADDED, GitFileStatusKind.fromWire("added"))
        assertEquals(GitFileStatusKind.RENAMED, GitFileStatusKind.fromWire("renamed"))
        assertEquals(GitFileStatusKind.CONFLICT, GitFileStatusKind.fromWire("conflict"))
        assertEquals(GitFileStatusKind.DELETED, GitFileStatusKind.fromWire("deleted"))

        assertEquals("M", GitFileStatusKind.fromCode("M")?.code)
        assertEquals("U", GitFileStatusKind.fromCode("U")?.code)
        assertEquals("A", GitFileStatusKind.fromCode("A")?.code)
        assertEquals("R", GitFileStatusKind.fromCode("R")?.code)
        assertEquals("C", GitFileStatusKind.fromCode("C")?.code)
        assertEquals("D", GitFileStatusKind.fromCode("D")?.code)
        assertNull(GitFileStatusKind.fromCode("X"))
        assertNull(GitFileStatusKind.fromWire("exploded"))
    }

    @Test
    fun `a row without a recognizable status is dropped, the rest survives`() {
        val body = """
            {"isGitRepository":true,"repositoryRoot":"/repo","files":[
              {"filePath":"/repo/a.ts","status":"unknown","code":"M","indexStatus":" ","worktreeStatus":"M"},
              {"filePath":"/repo/b.ts","status":"exploded","code":"X"},
              {"filePath":"","status":"modified","code":"M"},
              "not-an-object"
            ]}
        """.trimIndent()

        val parsed = parseGitStatusResponse(body)!!

        // The code is the server's own fallback for a kind the client is too old to know.
        assertEquals(1, parsed.files.size)
        assertEquals("a.ts", fileName(parsed.files.single().filePath))
        assertEquals(GitFileStatusKind.MODIFIED, parsed.files.single().status)
    }

    @Test
    fun `a body that is not the documented shape is rejected`() {
        assertNull(parseGitStatusResponse("not json"))
        assertNull(parseGitStatusResponse("""{"isGitRepository":true}"""))
        assertNull(parseGitStatusResponse("""{"isGitRepository":true,"files":{}}"""))
    }

    @Test
    fun `parses the diff route`() {
        val supported = parseGitFileDiff(
            """{"supported":true,"status":"modified","patch":"@@ -1 +1 @@\n-a\n+b"}""",
        )!!
        assertTrue(supported.supported)
        assertEquals("@@ -1 +1 @@\n-a\n+b", supported.patch)

        val unsupported = parseGitFileDiff("""{"supported":false}""")!!
        assertEquals(false, unsupported.supported)
        assertNull(unsupported.patch)

        assertNull(parseGitFileDiff("""{"patch":"x"}"""))
        assertNull(parseGitFileDiff("[]"))
    }

    @Test
    fun `keeps or picks the previewed file like the web`() {
        val files = parseGitStatusResponse(statusBody)!!.files

        assertEquals("C:/work/repo/src/App.tsx", pickGitSelection("C:/work/repo/src/App.tsx", files))
        // A vanished selection falls back to the first reviewable row …
        assertEquals("C:/work/repo/src/App.tsx", pickGitSelection("C:/work/repo/gone.ts", files))
        // … while an existing one is kept even when .gitattributes collapsed it.
        assertEquals("C:/work/repo/graph.json", pickGitSelection("C:/work/repo/graph.json", files))
        // Only .gitattributes rows: still show something.
        val collapsedOnly = files.filter { it.collapseReason != null }
        assertEquals("C:/work/repo/graph.json", pickGitSelection(null, collapsedOnly))
        assertNull(pickGitSelection(null, emptyList()))
    }

    @Test
    fun `splits filtered files into the main list and the gitattributes group`() {
        val files = parseGitStatusResponse(statusBody)!!.files

        val all = gitChangeGroups(files, "", "C:/work/repo")
        assertEquals(2, all.primary.size)
        assertEquals(2, all.collapsed.size)

        val byName = gitChangeGroups(files, "APP", "C:/work/repo")
        assertEquals(listOf("src/App.tsx"), byName.primary.map { relativeFilePath(it.filePath, "C:/work/repo") })
        assertTrue(byName.collapsed.isEmpty())

        val collapsedMatch = gitChangeGroups(files, "graph", "C:/work/repo")
        assertTrue(collapsedMatch.primary.isEmpty())
        assertEquals(1, collapsedMatch.collapsed.size)

        val nothing = gitChangeGroups(files, "zzz", "C:/work/repo")
        assertTrue(nothing.primary.isEmpty())
        assertTrue(nothing.collapsed.isEmpty())
    }

    @Test
    fun `the filter matches Windows paths case-insensitively`() {
        val parsed = parseGitStatusResponse(statusBody)!!

        // The row shows `src/App.tsx` relative to a differently cased cwd
        // (NTFS); the filter runs on that relative form.
        val mixed = gitChangeGroups(parsed.files, "SRC/APP", "c:/WORK/repo/")
        assertEquals(listOf("C:/work/repo/src/App.tsx"), mixed.primary.map { it.filePath })
    }
}
