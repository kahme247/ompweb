package io.github.kahme247.ompweb.ui.render

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.util.Base64
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.kahme247.ompweb.ui.theme.OmpDialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import coil3.ImageLoader
import coil3.compose.AsyncImage
import coil3.compose.SubcomposeAsyncImage
import coil3.decode.DataSource
import coil3.decode.ImageSource as CoilImageSource
import coil3.fetch.FetchResult
import coil3.fetch.Fetcher
import coil3.svg.SvgDecoder
import coil3.fetch.SourceFetchResult
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import coil3.request.ImageRequest
import coil3.request.Options
import coil3.request.crossfade
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okio.Buffer
import okio.FileSystem
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import kotlin.math.min

/** Rendering environment supplied once by the app container. */
object RenderEnvironment {
    @Volatile
    private var baseUrlProvider: (() -> String?)? = null

    @Volatile
    private var httpClient: OkHttpClient? = null

    @Volatile
    private var imageLoader: ImageLoader? = null

    @Volatile
    private var generation = 0

    /**
     * Wires the authenticated OkHttp client (cookie jar + policy interceptor)
     * and the origin resolver into the render layer. Called from
     * `AppContainer` before the first chat screen composes.
     */
    fun configure(baseUrlProvider: () -> String?, httpClient: OkHttpClient) {
        synchronized(this) {
            this.baseUrlProvider = baseUrlProvider
            this.httpClient = httpClient
            imageLoader = null
            generation++
        }
    }

    /** Current server origin without trailing slash, or null while unknown. */
    fun baseUrl(): String? = baseUrlProvider?.invoke()?.trimEnd('/')?.takeIf { it.isNotEmpty() }

    fun httpClient(): OkHttpClient? = httpClient

    internal fun generation(): Int = generation

    internal fun loader(context: Context): ImageLoader? {
        val client = httpClient ?: return null
        imageLoader?.let { return it }
        return synchronized(this) {
            imageLoader ?: ImageLoader.Builder(context.applicationContext)
                .components {
                    add(InlineImageFetcher.Factory())
                    // SVG files have no platform decoder (Bug 17 in the Phase 9
                    // review): `coil-svg` renders them, so an `.svg` in the
                    // explorer opens instead of showing an empty box.
                    add(SvgDecoder.Factory())
                    add(OkHttpNetworkFetcherFactory(callFactory = { client }))
                }
                .crossfade(true)
                .build()
                .also { imageLoader = it }
        }
    }
}

/** A decoded-on-demand inline image (base64 payload from the transcript). */
internal class InlineImage(val mimeType: String, val bytes: ByteArray)

/** Coil fetcher for inline transcript images; never touches network or disk. */
internal class InlineImageFetcher(private val image: InlineImage) : Fetcher {
    override suspend fun fetch(): FetchResult? = SourceFetchResult(
        source = CoilImageSource(
            source = Buffer().write(image.bytes),
            fileSystem = FileSystem.SYSTEM,
        ),
        mimeType = image.mimeType.ifBlank { null },
        dataSource = DataSource.MEMORY,
    )

    class Factory : Fetcher.Factory<InlineImage> {
        override fun create(data: InlineImage, options: Options, imageLoader: ImageLoader): Fetcher =
            InlineImageFetcher(data)
    }
}

/**
 * Resolves a transcript image path against the server origin. Absolute URLs
 * and opaque schemes pass through untouched.
 */
internal fun resolveImageUrl(path: String, baseUrl: String?): String {
    if (path.isEmpty()) return path
    val lower = path.lowercase()
    if (
        lower.startsWith("http://") || lower.startsWith("https://") ||
        lower.startsWith("data:") || lower.startsWith("content:") ||
        lower.startsWith("android.resource:")
    ) {
        return path
    }
    if (baseUrl.isNullOrBlank()) return path
    val base = baseUrl.trimEnd('/')
    return if (path.startsWith("/")) base + path else "$base/$path"
}

/** Media thumbnails are served by the same endpoint with `?thumb=1`. */
internal fun withThumbnail(url: String, thumbnail: Boolean): String {
    if (!thumbnail || !url.contains("/api/media/")) return url
    if (url.contains("thumb=")) return url
    return url + if (url.contains('?')) "&thumb=1" else "?thumb=1"
}

/** Hard cap for one image download; a message must not stream an unbounded file. */
internal const val MAX_IMAGE_BYTES = 16L * 1024 * 1024

/** Longest inline base64 payload that is decoded at all (~12 MB of bytes). */
internal const val MAX_INLINE_BASE64_CHARS = 16_000_000

/** Decoded bitmap edge cap: a phone screen never needs more than this. */
internal const val MAX_IMAGE_EDGE_PX = 2560

/** Whether an image may load without asking the reader. */
internal sealed interface ImageLoadDecision {
    /** Local data or the app's own origin. */
    data object Auto : ImageLoadDecision

    /** A foreign host (or unsupported scheme); the row asks before loading. */
    data class External(val host: String) : ImageLoadDecision
}

private val SCHEME_PREFIX = Regex("""^([a-zA-Z][a-zA-Z0-9+.-]*):""")

private data class HttpOrigin(val scheme: String, val host: String, val port: Int)

/**
 * Auto-load policy: `data:`/`content:`/`android.resource:` images and images
 * served by the app's own origin load immediately; everything else waits for
 * a tap, so an assistant-authored message cannot make the device fetch from
 * an arbitrary server (IP leak, tracking pixel).
 */
internal fun imageLoadDecision(path: String, baseUrl: String?): ImageLoadDecision {
    if (path.isEmpty()) return ImageLoadDecision.Auto
    val lower = path.lowercase()
    if (
        lower.startsWith("data:") || lower.startsWith("content:") ||
        lower.startsWith("android.resource:")
    ) {
        return ImageLoadDecision.Auto
    }
    // Protocol-relative `//host/…` points at a foreign origin.
    if (path.startsWith("//")) {
        val host = authorityHost(path.substring(2))
        return if (host.isEmpty()) ImageLoadDecision.Auto else ImageLoadDecision.External(host)
    }
    val match = SCHEME_PREFIX.find(path) ?: return ImageLoadDecision.Auto // relative → app origin
    val scheme = match.groupValues[1].lowercase()
    val rest = path.substring(match.range.last + 1).removePrefix("//")
    if (scheme != "http" && scheme != "https") {
        // `file:`, `ftp:`, `intent:` … are not remote previews.
        return ImageLoadDecision.External(authorityHost(rest).ifEmpty { scheme })
    }
    val origin = parseOrigin(scheme, rest)
    val baseOrigin = baseUrl?.let { base ->
        val baseMatch = SCHEME_PREFIX.find(base) ?: return@let null
        parseOrigin(baseMatch.groupValues[1].lowercase(), base.substring(baseMatch.range.last + 1).removePrefix("//"))
    }
    val sameOrigin = origin != null && baseOrigin != null &&
        origin.scheme == baseOrigin.scheme &&
        origin.host.equals(baseOrigin.host, ignoreCase = true) &&
        origin.port == baseOrigin.port
    return if (sameOrigin) {
        ImageLoadDecision.Auto
    } else {
        ImageLoadDecision.External(origin?.host?.takeIf { it.isNotEmpty() } ?: scheme)
    }
}

private fun authorityHost(authorityAndPath: String): String =
    authorityAndPath.substringBefore('/').substringBefore('?').substringBefore('#')
        .substringAfterLast('@').substringBefore(':')

private fun parseOrigin(scheme: String, authorityAndPath: String): HttpOrigin? {
    val authority = authorityAndPath.substringBefore('/').substringBefore('?').substringBefore('#')
    val hostPort = authority.substringAfterLast('@')
    if (hostPort.isEmpty()) return null
    val host: String
    val portText: String
    if (hostPort.startsWith("[")) {
        // IPv6 literal: `[::1]:8080`.
        val close = hostPort.indexOf(']')
        if (close < 0) return null
        host = hostPort.substring(0, close + 1)
        portText = hostPort.substring(close + 1).removePrefix(":")
    } else {
        host = hostPort.substringBefore(':')
        portText = if (hostPort.contains(':')) hostPort.substringAfter(':') else ""
    }
    if (host.isEmpty()) return null
    val port = portText.toIntOrNull() ?: if (scheme == "https") 443 else 80
    return HttpOrigin(scheme, host, port)
}

/**
 * Thumbnail that opens a full-screen lightbox. Relative URLs are resolved
 * against [RenderEnvironment.baseUrl]; media URLs request the server-side
 * WebP preview unless [thumbnail] is false.
 */
@Composable
fun RemoteImage(
    source: ImageSource,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    thumbnail: Boolean = true,
    onOpen: (() -> Unit)? = null,
) {
    val context = LocalContext.current
    val colors = LocalOmpColors.current
    val loader = rememberRenderImageLoader()
    var lightbox by remember(source) { mutableStateOf(false) }
    val baseUrl = RenderEnvironment.baseUrl()
    val decision = remember(source, baseUrl) {
        imageLoadDecision((source as? ImageSource.Url)?.path.orEmpty(), baseUrl)
    }
    var allowExternal by remember(source) { mutableStateOf(false) }
    // The external image waiting for the user's consent; null = nothing to ask.
    val blockedExternal = (decision as? ImageLoadDecision.External)?.takeUnless { allowExternal }
    // Base64 payloads are decoded off the main thread instead of during
    // composition; an oversized payload is refused outright.
    val inlineBytes by produceState<ByteArray?>(initialValue = null, source) {
        value = when (val inline = source as? ImageSource.Inline) {
            null -> null
            else -> withContext(Dispatchers.Default) { decodeInline(inline) }
        }
    }
    val model = remember(source, thumbnail, loader, blockedExternal, inlineBytes) {
        if (blockedExternal != null) null else imageModel(context, source, thumbnail, inlineBytes)
    }
    val shape = RoundedCornerShape(6.dp)

    if (blockedExternal != null) {
        Box(
            modifier
                .clip(shape)
                .background(colors.backgroundSubtle)
                .clickable { allowExternal = true }
                .padding(12.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = stringResource(R.string.chat_image_external, blockedExternal.host),
                color = colors.accent,
                fontSize = 12.sp,
                maxLines = 2,
            )
        }
    } else if (loader == null || model == null) {
        Box(
            modifier
                .clip(shape)
                .background(colors.backgroundSubtle)
                .padding(12.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = contentDescription ?: "Image",
                color = colors.textDim,
                fontSize = 12.sp,
                maxLines = 2,
            )
        }
    } else {
        SubcomposeAsyncImage(
            model = model,
            contentDescription = contentDescription,
            imageLoader = loader,
            modifier = modifier
                .clip(shape)
                .background(colors.backgroundSubtle)
                .clickable {
                    if (onOpen != null) onOpen() else lightbox = true
                },
            contentScale = ContentScale.Fit,
            loading = {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .padding(12.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = contentDescription ?: "…",
                        color = colors.textDim,
                        fontSize = 12.sp,
                        maxLines = 2,
                    )
                }
            },
            error = {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .padding(12.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = contentDescription ?: "Image unavailable",
                        color = colors.textDim,
                        fontSize = 12.sp,
                        maxLines = 2,
                    )
                }
            },
        )
    }

    if (lightbox) {
        ImageLightbox(source = source, onDismiss = { lightbox = false })
    }
}

@Composable
private fun rememberRenderImageLoader(): ImageLoader? {
    val context = LocalContext.current
    return remember(RenderEnvironment.generation()) {
        RenderEnvironment.loader(context)
    }
}

private fun imageModel(
    context: Context,
    source: ImageSource,
    thumbnail: Boolean,
    inlineBytes: ByteArray?,
): ImageRequest? {
    val data: Any = when (source) {
        is ImageSource.Url -> {
            val url = withThumbnail(resolveImageUrl(source.path, RenderEnvironment.baseUrl()), thumbnail)
            if (url.isBlank()) return null
            url
        }
        is ImageSource.Inline -> InlineImage(source.mimeType, inlineBytes ?: return null)
    }
    return ImageRequest.Builder(context)
        .data(data)
        .crossfade(true)
        .size(MAX_IMAGE_EDGE_PX, MAX_IMAGE_EDGE_PX)
        .build()
}

private fun decodeInline(source: ImageSource.Inline): ByteArray? {
    // The payload is base64 (~4/3 the bytes); refuse it before allocating.
    if (source.base64.length > MAX_INLINE_BASE64_CHARS) return null
    return try {
        Base64.decode(source.base64, Base64.DEFAULT)
    } catch (_: IllegalArgumentException) {
        null
    }
}

/**
 * Full-screen viewer with pinch/double-tap zoom, 1:1 and fit controls plus
 * share and save-as. Loads bytes with the authenticated client so private
 * media endpoints work.
 */
@Composable
fun ImageLightbox(source: ImageSource, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val loader = rememberRenderImageLoader()
    val model = remember(source, loader) {
        val bytes = if (source is ImageSource.Inline) decodeInline(source) else null
        imageModel(context, source, thumbnail = false, inlineBytes = bytes)
    }

    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    var boxSize by remember { mutableStateOf(IntSize.Zero) }
    var naturalSize by remember { mutableStateOf(IntSize.Zero) }
    var bytes by remember(source) { mutableStateOf<ByteArray?>(null) }

    val fitScale = remember(naturalSize, boxSize) {
        if (naturalSize.width <= 0 || naturalSize.height <= 0 || boxSize.width <= 0 || boxSize.height <= 0) {
            1f
        } else {
            min(
                1f,
                min(
                    boxSize.width.toFloat() / naturalSize.width,
                    boxSize.height.toFloat() / naturalSize.height,
                ),
            )
        }
    }

    fun reset() {
        scale = 1f
        offset = Offset.Zero
    }

    fun actualSize() {
        scale = (1f / fitScale.coerceAtLeast(0.01f)).coerceIn(0.1f, 8f)
        offset = Offset.Zero
    }

    val saveLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("image/png"),
    ) { uri ->
        val data = bytes ?: return@rememberLauncherForActivityResult
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            val ok = withContext(Dispatchers.IO) {
                try {
                    context.contentResolver.openOutputStream(uri, "wt")?.use { stream ->
                        stream.write(data)
                    } != null
                } catch (_: Exception) {
                    false
                }
            }
            Toast.makeText(context, if (ok) "Saved" else "Could not save", Toast.LENGTH_SHORT).show()
        }
    }

    LaunchedEffect(source) {
        bytes = loadImageBytes(source)
    }

    OmpDialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Box(
            Modifier
                .fillMaxSize()
                .background(Color.Black),
        ) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .onSizeChanged { boxSize = it }
                    .pointerInput(Unit) {
                        detectTransformGestures { _, pan, zoom, _ ->
                            scale = (scale * zoom).coerceIn(0.1f, 8f)
                            offset += pan
                        }
                    }
                    .pointerInput(Unit) {
                        detectTapGestures(
                            onDoubleTap = {
                                if (scale > 1.01f) reset() else actualSize()
                            },
                        )
                    },
                contentAlignment = Alignment.Center,
            ) {
                if (loader != null && model != null) {
                    AsyncImage(
                        model = model,
                        contentDescription = null,
                        imageLoader = loader,
                        modifier = Modifier
                            .fillMaxSize()
                            .graphicsLayer(
                                scaleX = scale,
                                scaleY = scale,
                                translationX = offset.x,
                                translationY = offset.y,
                            ),
                        contentScale = ContentScale.Fit,
                        onSuccess = { state ->
                            val image = state.result.image
                            naturalSize = IntSize(image.width, image.height)
                        },
                    )
                } else {
                    Text("Image unavailable", color = Color.White)
                }
            }

            Row(
                Modifier
                    .align(Alignment.TopEnd)
                    // The dialog draws edge-to-edge (decorFitsSystemWindows =
                    // false), so without this the action row sits under the
                    // status bar and its taps never reach the buttons.
                    .statusBarsPadding()
                    .padding(8.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                LightboxAction("Fit") { reset() }
                LightboxAction("1:1") { actualSize() }
                LightboxAction("Share") { shareImage(context, bytes) }
                LightboxAction("Save") { saveLauncher.launch("image.png") }
                LightboxAction("Close") { onDismiss() }
            }
        }
    }
}

@Composable
private fun LightboxAction(label: String, onClick: () -> Unit) {
    TextButton(onClick = onClick) {
        Text(text = label, color = Color.White, fontSize = 12.sp)
    }
}

private suspend fun loadImageBytes(source: ImageSource): ByteArray? =
    withContext(Dispatchers.IO) {
        when (source) {
            is ImageSource.Inline -> decodeInline(source)
            is ImageSource.Url -> {
                val url = resolveImageUrl(source.path, RenderEnvironment.baseUrl())
                if (!url.startsWith("http://") && !url.startsWith("https://")) return@withContext null
                val client = RenderEnvironment.httpClient() ?: return@withContext null
                try {
                    client.newCall(Request.Builder().url(url).build()).execute().use { response ->
                        if (!response.isSuccessful) return@withContext null
                        val body = response.body
                        // Bulky bodies are refused before any allocation.
                        if (body.contentLength() > MAX_IMAGE_BYTES) return@withContext null
                        body.byteStream().use { input -> readCapped(input, MAX_IMAGE_BYTES) }
                    }
                } catch (_: Exception) {
                    null
                }
            }
        }
    }

/** Reads at most [limit] bytes; a longer stream is rejected instead of buffered. */
private fun readCapped(input: InputStream, limit: Long): ByteArray? {
    val out = ByteArrayOutputStream()
    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
    var total = 0L
    while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        total += read
        if (total > limit) return null
        out.write(buffer, 0, read)
    }
    return out.toByteArray()
}

private fun shareImage(context: Context, bytes: ByteArray?) {
    if (bytes == null) {
        Toast.makeText(context, "Image not ready", Toast.LENGTH_SHORT).show()
        return
    }
    try {
        val directory = File(context.cacheDir, "exports").apply { mkdirs() }
        val file = File(directory, "image-${System.currentTimeMillis()}.png")
        file.writeBytes(bytes)
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "image/png"
            putExtra(Intent.EXTRA_STREAM, uri)
            clipData = ClipData.newRawUri("image", uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        context.startActivity(Intent.createChooser(intent, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: Exception) {
        Toast.makeText(context, "Could not share", Toast.LENGTH_SHORT).show()
    }
}
