package io.github.kahme247.ompweb.ui.settings

import io.github.kahme247.ompweb.net.ReleaseNotes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * P11Sec 3: `htmlUrl` is server-controlled. The dialog may only hand an
 * http/https/mailto link to `ACTION_VIEW`; every other scheme hides the button.
 */
class ReleaseNotesUrlTest {

    private fun notes(url: String) = ReleaseNotes(version = "1.1.0", body = "- fix", htmlUrl = url)

    @Test
    fun `https and http release links are offered`() {
        assertEquals(
            "https://github.com/o/r/releases/tag/v1.1.0",
            releaseNotesUrl(notes("https://github.com/o/r/releases/tag/v1.1.0")),
        )
        assertEquals("http://example.test/release", releaseNotesUrl(notes("http://example.test/release")))
    }

    @Test
    fun `non-http schemes and relative links are dropped`() {
        assertNull(releaseNotesUrl(notes("file:///etc/passwd")))
        assertNull(releaseNotesUrl(notes("javascript:alert(1)")))
        assertNull(releaseNotesUrl(notes("intent://scan/#Intent;scheme=zxing;end")))
        assertNull(releaseNotesUrl(notes("//evil.test/release")))
        assertNull(releaseNotesUrl(notes("github.com/o/r/releases")))
    }

    @Test
    fun `blank and missing notes have no link`() {
        assertNull(releaseNotesUrl(notes("   ")))
        assertNull(releaseNotesUrl(null))
    }
}
