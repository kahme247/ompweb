package io.github.kahme247.ompweb.ui.render

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Navigation policy of the sandboxed Mermaid WebView: the document may only be
 * replaced by the bundled asset origin under `/assets/`. The source of a
 * diagram is user-controlled, so a link in it must not be able to move the
 * renderer anywhere the asset loader does not answer.
 */
class MermaidNavigationTest {

    @Test
    fun `the bundled asset document may load`() {
        assertTrue(allowsMermaidNavigation("https", "appassets.androidplatform.net", "/assets/"))
        assertTrue(allowsMermaidNavigation("https", "appassets.androidplatform.net", "/assets/mermaid.min.js"))
    }

    @Test
    fun `the asset host with another path is blocked`() {
        assertFalse(allowsMermaidNavigation("https", "appassets.androidplatform.net", "/"))
        assertFalse(allowsMermaidNavigation("https", "appassets.androidplatform.net", "/api/sessions"))
    }

    @Test
    fun `plain http is blocked even for the asset host`() {
        assertFalse(allowsMermaidNavigation("http", "appassets.androidplatform.net", "/assets/"))
    }

    @Test
    fun `a foreign origin is blocked`() {
        assertFalse(allowsMermaidNavigation("https", "example.com", "/assets/"))
        assertFalse(allowsMermaidNavigation("https", "appassets.androidplatform.net.evil.test", "/assets/"))
    }

    @Test
    fun `a document without a path is blocked`() {
        assertFalse(allowsMermaidNavigation("about", "appassets.androidplatform.net", null))
        assertFalse(allowsMermaidNavigation("data", "appassets.androidplatform.net", null))
        assertFalse(allowsMermaidNavigation(null, null, null))
    }
}
