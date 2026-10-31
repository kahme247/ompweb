package io.github.kahme247.ompweb.ui.render

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Auto-load policy for transcript images: only the app's own origin and local
 * sources load without a tap (Phase 5 review, P5Sec #1).
 */
class RemoteImagePolicyTest {

    private val base = "http://100.64.0.10:30178"

    @Test
    fun `relative and same-origin images load immediately`() {
        assertEquals(ImageLoadDecision.Auto, imageLoadDecision("/api/media/abc", base))
        assertEquals(ImageLoadDecision.Auto, imageLoadDecision("api/media/abc", base))
        assertEquals(ImageLoadDecision.Auto, imageLoadDecision("$base/api/media/abc?thumb=1", base))
        assertEquals(
            ImageLoadDecision.Auto,
            imageLoadDecision("HTTP://100.64.0.10:30178/api/media/abc", base),
        )
    }

    @Test
    fun `a foreign host waits for the reader`() {
        val tracker = imageLoadDecision("https://tracker.example/p?u=x", base)
        assertEquals(ImageLoadDecision.External("tracker.example"), tracker)

        val lan = imageLoadDecision("http://192.168.1.1/setup.cgi?reboot=1", base)
        assertEquals(ImageLoadDecision.External("192.168.1.1"), lan)
    }

    @Test
    fun `a different port or scheme is a different origin`() {
        assertEquals(
            ImageLoadDecision.External("100.64.0.10"),
            imageLoadDecision("http://100.64.0.10:8080/api/media/abc", base),
        )
        assertEquals(
            ImageLoadDecision.External("100.64.0.10"),
            imageLoadDecision("https://100.64.0.10:30178/api/media/abc", base),
        )
    }

    @Test
    fun `protocol-relative urls are foreign`() {
        assertEquals(
            ImageLoadDecision.External("evil.example"),
            imageLoadDecision("//evil.example/x.png", base),
        )
    }

    @Test
    fun `local sources never need a tap`() {
        assertEquals(ImageLoadDecision.Auto, imageLoadDecision("data:image/png;base64,AAAA", base))
        assertEquals(ImageLoadDecision.Auto, imageLoadDecision("content://media/external/1", base))
        assertEquals(ImageLoadDecision.Auto, imageLoadDecision("android.resource://io.x/drawable/a", base))
        assertEquals(ImageLoadDecision.Auto, imageLoadDecision("", base))
    }

    @Test
    fun `non-http schemes are not fetched automatically`() {
        assertTrue(imageLoadDecision("file:///etc/passwd", base) is ImageLoadDecision.External)
        assertTrue(imageLoadDecision("ftp://example.com/a.png", base) is ImageLoadDecision.External)
        assertTrue(imageLoadDecision("intent://scan", base) is ImageLoadDecision.External)
    }

    @Test
    fun `camera ipv6 origins compare by literal and port`() {
        val ipv6 = "http://[::1]:30178"
        assertEquals(ImageLoadDecision.Auto, imageLoadDecision("http://[::1]:30178/api/media/a", ipv6))
        assertEquals(
            ImageLoadDecision.External("[::1]"),
            imageLoadDecision("http://[::1]:9000/api/media/a", ipv6),
        )
    }
}
