package io.github.kahme247.ompweb.ui.render

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GithubRefsTest {

    @Test
    fun `links bare refs to the session repository and qualified refs to their own`() {
        val refs = findGithubRefs("On PR #3460 (see can1357/oh-my-pi#12130).", GithubRepoRef("kahme247", "ompweb"))
        assertEquals(2, refs.size)
        assertEquals("#3460", refs[0].text)
        assertEquals(LinkTarget.GithubIssue("kahme247", "ompweb", 3460), refs[0].target)
        assertEquals("can1357/oh-my-pi#12130", refs[1].text)
        assertEquals(LinkTarget.GithubIssue("can1357", "oh-my-pi", 12130), refs[1].target)
    }

    @Test
    fun `bare refs need a repository while qualified refs do not`() {
        assertTrue(findGithubRefs("#12 and a/b#7", null).map { it.text } == listOf("a/b#7"))
    }

    @Test
    fun `ignores glued references, code and url fragments`() {
        val text = "C#3 file.ts#4 a/b/c#5 #6x #0 https://x.test/p#7 &#123;"
        assertTrue(findGithubRefs(text, GithubRepoRef("o", "r")).isEmpty())
    }

    @Test
    fun `matches ranges and issue urls`() {
        val ref = findGithubRefs("see #12 now", GithubRepoRef("o", "r")).single()
        assertEquals("see ".length, ref.start)
        assertEquals("see #12".length, ref.end)

        assertEquals(
            LinkTarget.GithubIssue("o", "r", 12),
            githubIssueFromUrl("https://github.com/o/r/issues/12?x=1"),
        )
        assertEquals(
            LinkTarget.GithubIssue("o", "r", 12),
            githubIssueFromUrl("https://www.github.com/o/r/pull/12/"),
        )
        assertNull(githubIssueFromUrl("https://github.com/o/r"))
        assertFalse(findGithubRefs("#0", GithubRepoRef("o", "r")).isNotEmpty())
    }
}
