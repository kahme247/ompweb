package io.github.kahme247.ompweb.ui.files

import android.graphics.Color
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

internal const val HTML_PREVIEW_MIME_TYPE = "text/html"
internal const val HTML_PREVIEW_ENCODING = "utf-8"

/**
 * The HTML preview's sandbox (web `components/HtmlPreview.tsx` renders in a
 * plain iframe). The document is user content: no script, no file or content
 * access and no network at all — the docx/markdown HTML embeds its images as
 * data URIs, and every navigation away is refused.
 */
internal fun configureHtmlPreview(webView: WebView) {
    webView.settings.javaScriptEnabled = false
    webView.settings.allowFileAccess = false
    webView.settings.allowContentAccess = false
    webView.settings.blockNetworkLoads = true
    webView.settings.loadsImagesAutomatically = true
    webView.setBackgroundColor(Color.TRANSPARENT)
    webView.isVerticalScrollBarEnabled = true
    webView.webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(
            view: WebView,
            request: WebResourceRequest,
        ): Boolean = true
    }
}

/**
 * Loads [html] with no base URL: relative URLs cannot resolve and no origin
 * cookies apply. The caller decides when a document actually changed.
 */
internal fun loadHtmlPreview(webView: WebView, html: String) {
    webView.loadDataWithBaseURL(null, html, HTML_PREVIEW_MIME_TYPE, HTML_PREVIEW_ENCODING, null)
}
