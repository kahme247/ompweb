package io.github.kahme247.ompweb.ui.files

import android.content.Context
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * B29: the HTML preview is user content, so it runs sandboxed — no script, no
 * file/content access, no network and no navigation, and the document is
 * loaded without a base URL (no relative fetch, no origin cookies).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], application = android.app.Application::class)
class FileHtmlPreviewTest {

    private fun webView(): WebView =
        WebView(ApplicationProvider.getApplicationContext<Context>())

    @Test
    fun sandboxDisablesScriptNetworkAndFileAccess() {
        val view = webView()
        configureHtmlPreview(view)
        val settings = view.settings
        assertFalse(settings.javaScriptEnabled)
        assertFalse(settings.allowFileAccess)
        assertFalse(settings.allowContentAccess)
        assertTrue(settings.blockNetworkLoads)
        assertTrue(settings.loadsImagesAutomatically)
    }

    @Test
    fun everyNavigationIsRefused() {
        val view = webView()
        configureHtmlPreview(view)
        val request = object : WebResourceRequest {
            override fun getUrl(): Uri = Uri.parse("https://example.com/track")
            override fun isForMainFrame(): Boolean = true
            override fun isRedirect(): Boolean = false
            override fun hasGesture(): Boolean = true
            override fun getMethod(): String = "GET"
            override fun getRequestHeaders(): MutableMap<String, String> = mutableMapOf()
        }
        assertTrue(view.webViewClient.shouldOverrideUrlLoading(view, request))
    }

    @Test
    fun loadsTheDocumentWithoutBaseUrl() {
        val view = webView()
        configureHtmlPreview(view)
        val html = "<html><body><p>hello</p></body></html>"
        loadHtmlPreview(view, html)
        val load = shadowOf(view).lastLoadDataWithBaseURL
        assertNull(load.baseUrl)
        assertEquals(html, load.data)
        assertEquals("text/html", load.mimeType)
        assertEquals("utf-8", load.encoding)
        assertNull(load.historyUrl)
    }
}
