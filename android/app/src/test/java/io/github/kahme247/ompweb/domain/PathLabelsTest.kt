package io.github.kahme247.ompweb.domain

import org.junit.Assert.assertEquals
import org.junit.Test

class PathLabelsTest {

    @Test
    fun `project label keeps the final segment on both separators`() {
        assertEquals("ompweb", projectPathLabel("/srv/ompweb/"))
        assertEquals("Waku", projectPathLabel("D:\\OtherProjects\\Waku"))
        assertEquals("repo", projectPathLabel("repo"))
    }

    @Test
    fun `displayCwd replaces a literal home prefix like the web helper`() {
        assertEquals("~/project/sub", displayCwd("/home/me/project/sub", "/home/me"))
        assertEquals("/var/log", displayCwd("/var/log", "/home/me"))
        // The web helper is a literal prefix replace, not a path-boundary check.
        assertEquals("~not", displayCwd("/home/menot", "/home/me"))
        assertEquals("/home/me", displayCwd("/home/me", null))
    }
}
