package io.github.kahme247.ompweb.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Ports `lib/git-clone.test.mjs` case by case. */
class GitCloneTest {

    @Test
    fun `cloneDirectoryName derives git's directory name from https and ssh URLs`() {
        assertEquals("ompweb", cloneDirectoryName("https://github.com/kahme247/ompweb.git"))
        assertEquals("repo", cloneDirectoryName("https://user:token@gitlab.example.com/group/sub/repo/"))
        assertEquals("ompweb", cloneDirectoryName("git@github.com:kahme247/ompweb.git"))
        assertEquals("repo", cloneDirectoryName("gh:owner/repo"))
        assertEquals("repo", cloneDirectoryName("ssh://git@host:2222/srv/repo.git"))
        assertEquals("repo", cloneDirectoryName("  git@host:repo  "))
        assertEquals("repo", cloneDirectoryName("git@host:/srv/git/repo.git"))
        assertEquals("r", cloneDirectoryName("https://h/o/r.git?x=1#f"))
    }

    @Test
    fun `cloneDirectoryName rejects non-https and ssh transports and unsafe names`() {
        val rejected = listOf(
            "",
            "http://github.com/o/r.git",
            "file:///tmp/repo",
            "ext::sh\$IFS-c\$IFS'touch\$IFS/x'/x",
            "--upload-pack=touch /tmp/pwned",
            "/tmp/repo",
            "C:\\repos\\repo",
            "C:/repos/repo",
            "https://h/o/..\\..\\evil",
            "https://h/o/a\$b",
            "https://github.com/o/r extra",
            "https://github.com/o/..",
            "https://github.com/",
        )
        for (url in rejected) {
            assertNull(url, cloneDirectoryName(url))
        }
    }

    @Test
    fun `appendProgress applies carriage returns across chunks`() {
        var log = appendProgress("", "Cloning into 'repo'...\n")
        log = appendProgress(log, "Receiving objects:  10% (1/10)\r")
        log = appendProgress(log, "Receiving objects:  50% (5/10)\r")
        assertEquals("Cloning into 'repo'...\nReceiving objects:  50% (5/10)\r", log)
        log = appendProgress(log, "Receiving objects: 100% (10/10), done.\nResolving deltas: 100%\n")
        assertEquals(
            "Cloning into 'repo'...\nReceiving objects: 100% (10/10), done.\nResolving deltas: 100%\n",
            log,
        )
    }

    @Test
    fun `appendProgress keeps only the latest 200 lines`() {
        val log = appendProgress("", (0 until 250).joinToString("\n") { "line $it" })
        val lines = log.split("\n")
        assertEquals(MAX_PROGRESS_LINES, lines.size)
        assertEquals("line 50", lines.first())
    }
}
