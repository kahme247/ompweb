package io.github.kahme247.ompweb.ui.render

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.graphics.Canvas
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.graphics.createBitmap
import androidx.webkit.WebViewAssetLoader
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import kotlinx.coroutines.delay
import org.json.JSONObject
import java.util.Locale
import kotlin.math.roundToInt

/**
 * Mermaid diagram with the same interaction model as `MermaidBlock.tsx`:
 * the source is shown by default and a "Preview" toggle renders it (cached
 * bitmap). Rendering runs in a sandboxed offscreen WebView with the bundled
 * `assets/mermaid.min.js`; there is no network and the only JS bridge is the
 * result callback. Any failure (parse error, timeout, empty capture) falls
 * back to the source block.
 */
@Composable
fun MermaidBlock(code: String, modifier: Modifier = Modifier) {
    val colors = LocalOmpColors.current
    val dark = colors.background.luminance() < 0.5f
    val cacheKey = remember(code, dark) { MermaidBitmapCache.key(code, dark) }
    var preview by remember(code) { mutableStateOf(false) }
    var bitmap by remember(code, dark) { mutableStateOf(MermaidBitmapCache.get(cacheKey)) }
    var error by remember(code) { mutableStateOf<String?>(null) }
    var attempt by remember(code) { mutableIntStateOf(0) }

    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = if (preview) "mermaid" else "",
                color = colors.textDim,
                fontSize = 11.sp,
                fontFamily = io.github.kahme247.ompweb.ui.theme.OmpMonoFontFamily,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = "Source",
                color = if (!preview) colors.text else colors.textMuted,
                fontSize = 11.sp,
                modifier = Modifier
                    .clickable { preview = false }
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            )
            Text(
                text = "Preview",
                color = if (preview) colors.text else colors.textMuted,
                fontSize = 11.sp,
                modifier = Modifier
                    .clickable {
                        preview = true
                        if (bitmap == null && error != null) {
                            error = null
                            attempt++
                        }
                    }
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            )
        }

        if (!preview) {
            CodeBlock(code = code, language = "mermaid", modifier = Modifier.fillMaxWidth())
        } else {
            when {
                bitmap != null -> Image(
                    bitmap = bitmap!!.asImageBitmap(),
                    contentDescription = "Mermaid diagram",
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp)),
                    // The capture is already at the SVG's natural size; drawing it
                    // 1:1 keeps the diagram's scale identical to the web render.
                    alignment = Alignment.TopStart,
                    contentScale = ContentScale.None,
                )
                error != null -> {
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(8.dp))
                            .background(colors.backgroundSubtle)
                            .padding(10.dp),
                    ) {
                        Text(
                            text = "Mermaid render failed: $error",
                            color = colors.statusError,
                            fontSize = 12.sp,
                        )
                        Text(
                            text = "Retry",
                            color = colors.accent,
                            fontSize = 12.sp,
                            modifier = Modifier
                                .clickable {
                                    error = null
                                    attempt++
                                }
                                .padding(top = 6.dp),
                        )
                    }
                    // Fallback: the source is never dropped.
                    CodeBlock(
                        code = code,
                        language = "mermaid",
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 6.dp),
                    )
                }
                else -> MermaidWebView(
                    code = code,
                    dark = dark,
                    attempt = attempt,
                    onRendered = { rendered ->
                        MermaidBitmapCache.put(cacheKey, rendered)
                        bitmap = rendered
                    },
                    onError = { message -> error = message ?: "unknown error" },
                )
            }
        }
    }
}

// Lint cannot see the Kotlin override on the anonymous client below; the
// handler is implemented (`onRenderProcessGone`) and destroys the WebView.
@SuppressLint("SetJavaScriptEnabled", "MissingOnRenderProcessGone")
@Composable
private fun MermaidWebView(
    code: String,
    dark: Boolean,
    attempt: Int,
    onRendered: (Bitmap) -> Unit,
    onError: (String?) -> Unit,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val density = LocalDensity.current
    val colors = LocalOmpColors.current
    var webView by remember { mutableStateOf<WebView?>(null) }
    var targetHeightPx by remember { mutableIntStateOf(220 * density.density.roundToInt()) }
    var contentWidthPx by remember { mutableIntStateOf(0) }
    var contentHeightPx by remember { mutableIntStateOf(0) }
    var reported by remember { mutableStateOf(false) }
    val backgroundArgb = colors.background.toArgbCompat()

    DisposableEffect(Unit) {
        onDispose {
            webView?.apply {
                stopLoading()
                removeJavascriptInterface("ompMermaid")
                destroy()
            }
            webView = null
        }
    }

    LaunchedEffect(reported, contentWidthPx, contentHeightPx, webView) {
        if (!reported) return@LaunchedEffect
        val view = webView ?: return@LaunchedEffect
        // Give Chromium a couple of frames to reflow the SVG after the resize.
        delay(120)
        repeat(4) {
            val bitmap = drawWebView(view)
            if (bitmap != null && hasVisibleContent(bitmap, backgroundArgb)) {
                onRendered(cropToContent(bitmap, contentWidthPx, contentHeightPx))
                return@LaunchedEffect
            }
            delay(120)
        }
        onError("empty capture")
    }

    LaunchedEffect(attempt, code) {
        delay(12_000)
        if (!reported) onError("timeout")
    }

    Box(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(colors.background),
    ) {
        AndroidView(
            modifier = Modifier
                .fillMaxWidth()
                .height(with(density) { targetHeightPx.toDp() }),
            factory = { ctx ->
            WebView(ctx).apply {
                setBackgroundColor(backgroundArgb)
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = false
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.setSupportZoom(false)
                settings.builtInZoomControls = false
                settings.blockNetworkLoads = true
                settings.cacheMode = WebSettings.LOAD_NO_CACHE
                settings.mediaPlaybackRequiresUserGesture = true
                settings.javaScriptCanOpenWindowsAutomatically = false

                val assetLoader = WebViewAssetLoader.Builder()
                    .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(ctx))
                    .build()
                webViewClient = object : WebViewClient() {
                    override fun shouldInterceptRequest(
                        view: WebView,
                        request: WebResourceRequest,
                    ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

                    override fun shouldOverrideUrlLoading(
                        view: WebView,
                        request: WebResourceRequest,
                    ): Boolean = !allowsMermaidNavigation(
                        scheme = request.url.scheme,
                        host = request.url.host,
                        path = request.url.path,
                    )

                    override fun onRenderProcessGone(
                        view: WebView,
                        detail: RenderProcessGoneDetail,
                    ): Boolean {
                        view.destroy()
                        onError("renderer crashed")
                        return true
                    }
                }

                addJavascriptInterface(
                    object {
                        @JavascriptInterface
                        fun postMessage(value: String) {
                            post {
                                try {
                                    val json = JSONObject(value)
                                    if (!json.optBoolean("ok")) {
                                        onError(json.optString("error").ifBlank { "parse error" })
                                        return@post
                                    }
                                    val w = json.optDouble("w", 1.0).coerceAtLeast(1.0)
                                    val h = json.optDouble("h", 1.0).coerceAtLeast(1.0)
                                    // The SVG box in CSS px; captured at device density
                                    // so the bitmap keeps the diagram at its natural size.
                                    contentWidthPx = (w * density.density).roundToInt().coerceAtLeast(1)
                                    contentHeightPx = (h * density.density).roundToInt().coerceAtLeast(1)
                                    targetHeightPx = contentHeightPx.coerceIn(60, 2400)
                                    reported = true
                                } catch (e: Exception) {
                                    onError(e.message)
                                }
                            }
                        }
                    },
                    "ompMermaid",
                )

                loadDataWithBaseURL(
                    "https://$ASSET_HOST/assets/",
                    mermaidHtml(code, dark = dark, backgroundArgb = backgroundArgb),
                    "text/html",
                    "UTF-8",
                    null,
                )
                webView = this
                }
            },
            update = { view -> webView = view },
        )
    }
}

/**
 * The origin the bundled assets are served from: `WebViewAssetLoader` answers
 * `https://appassets.androidplatform.net/assets/...` from APK assets, so the
 * document never needs a real network origin.
 */
private const val ASSET_HOST = "appassets.androidplatform.net"

/**
 * Whether a navigation may replace the rendered document. Only the bundled
 * asset origin under `/assets/` qualifies: a diagram can carry a link, and
 * anything else — a `data:`/`about:` load, the asset host with another path, a
 * foreign origin — is blocked instead of being handed to the WebView. The
 * loader only answers `/assets/`, so this adds nothing it would serve anyway.
 */
internal fun allowsMermaidNavigation(scheme: String?, host: String?, path: String?): Boolean =
    scheme == "https" && host == ASSET_HOST && path.orEmpty().startsWith("/assets/")

private fun mermaidHtml(code: String, dark: Boolean, backgroundArgb: Int): String {
    val theme = if (dark) "dark" else "default"
    val background = String.format(Locale.US, "#%06X", backgroundArgb and 0xFFFFFF)
    val escaped = JSONObject.quote(code)
        .replace("<", "\\u003c")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    return """
        <!doctype html>
        <html><head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          html, body { margin: 0; padding: 0; background: $background; overflow: hidden; }
          #out { width: 100%; }
          #out svg { display: block; max-width: 100%; height: auto; }
        </style>
        <script src="mermaid.min.js"></script>
        </head>
        <body><div id="out"></div>
        <script>
          (async function () {
            try {
              mermaid.initialize({
                startOnLoad: false,
                securityLevel: 'strict',
                theme: '$theme',
                fontFamily: 'sans-serif'
              });
              const result = await mermaid.render('ompGraph' + Date.now(), $escaped);
              const out = document.getElementById('out');
              out.innerHTML = result.svg;
              await new Promise(function (resolve) {
                requestAnimationFrame(function () { requestAnimationFrame(resolve); });
              });
              const node = out.querySelector('svg') || out;
              const rect = node.getBoundingClientRect();
              ompMermaid.postMessage(JSON.stringify({
                ok: true,
                w: Math.max(1, rect.width),
                h: Math.max(1, rect.height)
              }));
            } catch (error) {
              ompMermaid.postMessage(JSON.stringify({
                ok: false,
                error: String((error && error.message) || error)
              }));
            }
          })();
        </script>
        </body></html>
    """.trimIndent()
}

/**
 * The WebView spans the full chat width, but the SVG keeps its natural width
 * (mermaid's inline `max-width`), so the capture has unused background to the
 * right and below. Crop to the reported SVG box so the transcript does not
 * reserve that empty space.
 */
private fun cropToContent(bitmap: Bitmap, width: Int, height: Int): Bitmap {
    val w = width.coerceIn(1, bitmap.width)
    val h = height.coerceIn(1, bitmap.height)
    if (w == bitmap.width && h == bitmap.height) return bitmap
    return Bitmap.createBitmap(bitmap, 0, 0, w, h)
}

private fun drawWebView(view: WebView): Bitmap? {
    val width = view.width
    val height = view.height
    if (width <= 0 || height <= 0) return null
    return try {
        val bitmap = createBitmap(width, height)
        view.draw(Canvas(bitmap))
        bitmap
    } catch (_: Exception) {
        null
    }
}

/** Guards against capturing before Chromium painted the diagram. */
private fun hasVisibleContent(bitmap: Bitmap, background: Int): Boolean {
    val stepX = (bitmap.width / 24).coerceAtLeast(1)
    val stepY = (bitmap.height / 24).coerceAtLeast(1)
    var y = stepY / 2
    while (y < bitmap.height) {
        var x = stepX / 2
        while (x < bitmap.width) {
            if (bitmap.getPixel(x, y) != background) return true
            x += stepX
        }
        y += stepY
    }
    return false
}

private fun androidx.compose.ui.graphics.Color.toArgbCompat(): Int =
    android.graphics.Color.argb(alpha, red, green, blue)

/** LRU of rendered diagrams; bitmaps are large, so the cache stays tiny. */
private object MermaidBitmapCache {
    private const val MAX_ENTRIES = 4
    private val entries = object : LinkedHashMap<String, Bitmap>(MAX_ENTRIES, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Bitmap>?): Boolean =
            size > MAX_ENTRIES
    }

    fun key(code: String, dark: Boolean): String = "${if (dark) "dark" else "light"}:$code"

    @Synchronized
    fun get(key: String): Bitmap? = entries[key]

    @Synchronized
    fun put(key: String, bitmap: Bitmap) {
        entries[key] = bitmap
    }
}
