package io.github.kahme247.ompweb.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FileLinksTest {

    @Test
    fun `posix paths become catch-all segments`() {
        assertEquals(listOf("home", "me", "a.ts"), FileLinks.apiPathSegments("/home/me/a.ts"))
        assertEquals(listOf("relative", "a.ts"), FileLinks.apiPathSegments("relative/a.ts"))
    }

    @Test
    fun `dots never climb out of the workspace`() {
        assertTrue(FileLinks.apiPathSegments("../../models").isEmpty())
        assertTrue(FileLinks.apiPathSegments("/home/me/../etc/passwd").isEmpty())
        assertTrue(FileLinks.apiPathSegments("./a.ts").isEmpty())
    }

    @Test
    fun `windows drive paths use forward slashes`() {
        assertEquals(
            listOf("C:", "Users", "me", "a.ts"),
            FileLinks.apiPathSegments("""C:\Users\me\a.ts"""),
        )
        assertEquals(
            listOf("C:", "Users", "me", "a.ts"),
            FileLinks.apiPathSegments("C:/Users/me/a.ts"),
        )
    }

    @Test
    fun `unc paths keep their server prefix`() {
        assertEquals(
            listOf("//server", "share", "a.ts"),
            FileLinks.apiPathSegments("""\\server\share\a.ts"""),
        )
        assertEquals(
            listOf("//server", "share", "a.ts"),
            FileLinks.apiPathSegments("//server/share/a.ts"),
        )
    }
}
