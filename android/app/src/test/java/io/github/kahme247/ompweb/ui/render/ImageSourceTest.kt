package io.github.kahme247.ompweb.ui.render

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ImageSourceTest {

    @Test
    fun `resolves server paths against the origin`() {
        assertEquals(
            "http://host:30178/api/media/abc",
            resolveImageUrl("/api/media/abc", "http://host:30178/"),
        )
        assertEquals(
            "http://host:30178/api/media/abc",
            resolveImageUrl("api/media/abc", "http://host:30178"),
        )
    }

    @Test
    fun `keeps absolute urls and opaque schemes`() {
        assertEquals("https://example.com/a.png", resolveImageUrl("https://example.com/a.png", "http://host"))
        assertEquals("data:image/png;base64,AA", resolveImageUrl("data:image/png;base64,AA", "http://host"))
        assertEquals("content://media/1", resolveImageUrl("content://media/1", "http://host"))
    }

    @Test
    fun `thumbnails only touch media endpoints`() {
        assertEquals(
            "http://host/api/media/abc?thumb=1",
            withThumbnail("http://host/api/media/abc", thumbnail = true),
        )
        assertEquals(
            "http://host/api/media/abc?x=1&thumb=1",
            withThumbnail("http://host/api/media/abc?x=1", thumbnail = true),
        )
        assertEquals(
            "http://host/api/media/abc",
            withThumbnail("http://host/api/media/abc", thumbnail = false),
        )
        assertEquals(
            "https://example.com/a.png",
            withThumbnail("https://example.com/a.png", thumbnail = true),
        )
        assertEquals(
            "http://host/api/media/abc?thumb=1",
            withThumbnail("http://host/api/media/abc?thumb=1", thumbnail = true),
        )
    }

    @Test
    fun `data uris become inline sources`() {
        val source = imageSourceFor("data:image/png;base64,QUJD")
        assertTrue(source is ImageSource.Inline)
        source as ImageSource.Inline
        assertEquals("image/png", source.mimeType)
        assertEquals("QUJD", source.base64)

        val plain = imageSourceFor("/api/media/abc")
        assertEquals(ImageSource.Url("/api/media/abc"), plain)
    }
}
