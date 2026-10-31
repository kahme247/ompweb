package io.github.kahme247.ompweb.ui.files

import android.graphics.Bitmap
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import android.webkit.WebView
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.TextPreviewKind
import io.github.kahme247.ompweb.domain.ViewerKind
import io.github.kahme247.ompweb.domain.fileMentionText
import io.github.kahme247.ompweb.domain.fileDirectory
import io.github.kahme247.ompweb.domain.fileName
import io.github.kahme247.ompweb.domain.formatFileSize
import io.github.kahme247.ompweb.domain.relativeFilePath
import io.github.kahme247.ompweb.domain.textPreviewKind
import io.github.kahme247.ompweb.domain.viewerKind
import io.github.kahme247.ompweb.ui.render.CodeBlock
import io.github.kahme247.ompweb.ui.render.DiffView
import io.github.kahme247.ompweb.ui.render.GithubRepoRef
import io.github.kahme247.ompweb.ui.render.ImageSource
import io.github.kahme247.ompweb.ui.render.LinkTarget
import io.github.kahme247.ompweb.ui.render.LocalFileLinkBaseDir
import io.github.kahme247.ompweb.ui.render.MarkdownText
import io.github.kahme247.ompweb.ui.render.RemoteImage
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpDropdownMenu
import io.github.kahme247.ompweb.ui.theme.OmpMonoFontFamily
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * One open file (web `components/FileViewer.tsx`): the header with the mode
 * switch, wrap toggle and the file actions, then the body — source with
 * syntax colours, markdown/HTML preview, the git diff in Phase-5's [DiffView],
 * the zoomable image, the PDF through `PdfRenderer` and the server-rendered
 * docx document.
 *
 * Every byte comes from `FilesApi`; the images use the authenticated Coil
 * loader of the render layer, so a file outside the workspace works as long as
 * the tab carries its `sourceSessionId`.
 */
@Composable
fun FileViewerPane(
    tab: FileTab,
    cwd: String?,
    githubRepo: GithubRepoRef?,
    vm: FilesViewModel,
    onLink: (LinkTarget) -> Unit,
    onMention: (String) -> Unit,
    onCopyPath: () -> Unit,
    onDownload: (String) -> Unit,
    onShare: (String) -> Unit,
    onReveal: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalOmpColors.current
    val kind = viewerKind(tab.path)
    val relative = relativeFilePath(tab.path, cwd)
    Column(modifier.fillMaxSize()) {
        ViewerHeader(
            tab = tab,
            relativePath = relative,
            onMention = { onMention(fileMentionText(relative, tab.line)) },
            onCopyPath = onCopyPath,
            onDownload = { onDownload(tab.path) },
            onShare = { onShare(tab.path) },
            onReveal = onReveal,
        )
        if (tab.availableModes.isNotEmpty()) {
            ViewerModeBar(
                modes = tab.availableModes,
                current = tab.mode,
                wrap = tab.wrap,
                onMode = vm::setMode,
                onToggleWrap = vm::toggleWrap,
            )
        }
        val error = tab.error
        when {
            // A diff tab reads no bytes: its body must not be masked by a
            // read error of a mode the user is not looking at.
            kind == ViewerKind.Text && tab.mode == FileOpenMode.Diff -> TextBody(
                tab = tab,
                githubRepo = githubRepo,
                onLink = onLink,
                onRetryDiff = vm::retryDiff,
            )

            error != null -> ViewerMessage(
                message = error,
                action = stringResource(R.string.files_retry) to vm::retryTab,
            )

            tab.loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(strokeWidth = 2.dp, color = colors.accent, modifier = Modifier.size(20.dp))
            }

            kind == ViewerKind.Image -> {
                val source = remember(tab.path, tab.sourceSessionId, tab.imageVersion) {
                    ImageSource.Url(FileTransfer.readUrl(tab.path, tab.sourceSessionId, tab.imageVersion))
                }
                Box(Modifier.fillMaxSize().padding(8.dp), contentAlignment = Alignment.Center) {
                    RemoteImage(
                        source = source,
                        contentDescription = fileName(tab.path),
                        thumbnail = false,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }

            kind == ViewerKind.Pdf -> PdfPages(tab = tab)

            kind == ViewerKind.Docx -> {
                val html = tab.docxHtml
                if (html == null) {
                    ViewerMessage(message = stringResource(R.string.files_docx_failed), action = null)
                } else {
                    HtmlDocument(html = html, modifier = Modifier.fillMaxSize())
                }
            }

            tab.binaryMime != null -> BinaryNotice(
                mime = tab.binaryMime,
                size = tab.size,
                onDownload = { onDownload(tab.path) },
                onShare = { onShare(tab.path) },
            )

            else -> TextBody(
                tab = tab,
                githubRepo = githubRepo,
                onLink = onLink,
                onRetryDiff = vm::retryDiff,
            )
        }
    }
}

@Composable
private fun ViewerHeader(
    tab: FileTab,
    relativePath: String,
    onMention: () -> Unit,
    onCopyPath: () -> Unit,
    onDownload: () -> Unit,
    onShare: () -> Unit,
    onReveal: () -> Unit,
) {
    val colors = LocalOmpColors.current
    var menuOpen by remember(tab.path) { mutableStateOf(false) }
    Column(
        Modifier
            .fillMaxWidth()
            .background(colors.panel)
            .padding(start = 10.dp, end = 2.dp, top = 4.dp, bottom = 2.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = fileName(tab.path),
                modifier = Modifier.weight(1f, fill = false),
                color = colors.text,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (tab.watching) {
                Spacer(Modifier.width(6.dp))
                Box(
                    Modifier
                        .size(6.dp)
                        .background(colors.statusSuccess, RoundedCornerShape(50)),
                )
                Spacer(Modifier.width(4.dp))
                Text(
                    text = stringResource(R.string.files_watching),
                    color = colors.statusSuccess,
                    fontSize = 9.5.sp,
                )
            }
            Spacer(Modifier.weight(1f))
            Box {
                IconButton(onClick = { menuOpen = true }) {
                    Icon(
                        imageVector = Icons.Filled.MoreVert,
                        contentDescription = stringResource(R.string.files_row_actions),
                        tint = colors.textMuted,
                        modifier = Modifier.size(16.dp),
                    )
                }
                OmpDropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    ViewerMenuItem(R.string.files_mention) {
                        menuOpen = false
                        onMention()
                    }
                    ViewerMenuItem(R.string.files_copy_path) {
                        menuOpen = false
                        onCopyPath()
                    }
                    ViewerMenuItem(R.string.files_reveal) {
                        menuOpen = false
                        onReveal()
                    }
                    ViewerMenuItem(R.string.files_download) {
                        menuOpen = false
                        onDownload()
                    }
                    ViewerMenuItem(R.string.files_share) {
                        menuOpen = false
                        onShare()
                    }
                }
            }
        }
        Text(
            text = buildString {
                append(relativePath)
                tab.line?.let { append(" · ").append(stringResource(R.string.files_line, it)) }
            },
            color = colors.textDim,
            fontSize = 10.sp,
            fontFamily = OmpMonoFontFamily,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun ViewerModeBar(
    modes: List<FileOpenMode>,
    current: FileOpenMode,
    wrap: Boolean,
    onMode: (FileOpenMode) -> Unit,
    onToggleWrap: () -> Unit,
) {
    val colors = LocalOmpColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        modes.forEach { mode ->
            val label = when (mode) {
                FileOpenMode.Source -> stringResource(R.string.files_mode_source)
                FileOpenMode.Preview -> stringResource(R.string.files_mode_preview)
                FileOpenMode.Diff -> stringResource(R.string.files_mode_diff)
            }
            Text(
                text = label,
                modifier = Modifier
                    .background(
                        if (mode == current) colors.selected else colors.backgroundSubtle,
                        RoundedCornerShape(6.dp),
                    )
                    .clickable { onMode(mode) }
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                color = if (mode == current) colors.text else colors.textMuted,
                fontSize = 11.sp,
                fontWeight = if (mode == current) FontWeight.Medium else FontWeight.Normal,
            )
        }
        Spacer(Modifier.weight(1f))
        if (current == FileOpenMode.Source) {
            Text(
                text = stringResource(if (wrap) R.string.files_wrap_off else R.string.files_wrap_on),
                modifier = Modifier
                    .clickable(onClick = onToggleWrap)
                    .padding(horizontal = 6.dp, vertical = 4.dp),
                color = colors.textDim,
                fontSize = 10.5.sp,
            )
        }
    }
}

@Composable
private fun TextBody(
    tab: FileTab,
    githubRepo: GithubRepoRef?,
    onLink: (LinkTarget) -> Unit,
    onRetryDiff: () -> Unit,
) {
    val colors = LocalOmpColors.current
    when (tab.mode) {
        FileOpenMode.Diff -> {
            val diffError = tab.diffError
            if (diffError != null) {
                // Before the empty state: "no diff" is not true when the fetch
                // failed, and the retry is the only way out of a flaky answer.
                ViewerMessage(
                    message = stringResource(R.string.files_diff_failed, diffError),
                    action = stringResource(R.string.files_retry) to onRetryDiff,
                )
            } else if (tab.diffLoading) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(strokeWidth = 2.dp, color = colors.accent, modifier = Modifier.size(18.dp))
                }
            } else {
                val diff = tab.diff
                if (diff == null) {
                    ViewerMessage(message = stringResource(R.string.files_diff_empty), action = null)
                } else {
                    Column(
                        Modifier
                            .fillMaxSize()
                            .verticalScroll(rememberScrollState())
                            .padding(8.dp),
                    ) {
                        DiffView(path = tab.path, oldText = null, newText = null, unifiedPatch = diff)
                    }
                }
            }
        }

        FileOpenMode.Preview -> {
            val preview = textPreviewKind(tab.language)
            val content = tab.content
            when {
                content == null -> ViewerMessage(message = stringResource(R.string.files_no_preview), action = null)

                preview == TextPreviewKind.Markdown -> Column(
                    Modifier
                        .fillMaxSize()
                        .verticalScroll(rememberScrollState())
                        .padding(10.dp),
                ) {
                    val baseDir = fileDirectory(tab.path)
                    CompositionLocalProvider(LocalFileLinkBaseDir provides baseDir) {
                        MarkdownText(
                            markdown = content,
                            githubRepo = githubRepo,
                            onLink = onLink,
                        )
                    }
                }

                preview == TextPreviewKind.Html -> HtmlDocument(html = content, modifier = Modifier.fillMaxSize())

                else -> ViewerMessage(message = stringResource(R.string.files_no_preview), action = null)
            }
        }

        FileOpenMode.Source -> {
            val scrollState = rememberScrollState()
            val scope = rememberCoroutineScope()
            // The viewport's top in the window, so a reported line position
            // can be translated into a scroll offset.
            var viewportTop by remember(tab.path) { mutableFloatStateOf(0f) }
            var revealedFor by remember(tab.path) { mutableStateOf<String?>(null) }
            val revealKey = tab.line?.let { "${tab.path}:$it:${tab.wrap}" }
            Box(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(scrollState)
                    .onGloballyPositioned { viewportTop = it.positionInRoot().y },
            ) {
                Column(Modifier.padding(8.dp)) {
                    CodeBlock(
                        code = tab.content.orEmpty(),
                        language = tab.language,
                        wrap = tab.wrap,
                        modifier = Modifier.fillMaxWidth(),
                        revealLine = tab.line,
                        onRevealLine = { lineTop ->
                            if (revealKey != null && revealedFor != revealKey) {
                                revealedFor = revealKey
                                scope.launch {
                                    val target = scrollState.value + lineTop - viewportTop
                                    scrollState.scrollTo(target.toInt().coerceAtLeast(0))
                                }
                            }
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun BinaryNotice(
    mime: String,
    size: Long,
    onDownload: () -> Unit,
    onShare: () -> Unit,
) {
    val colors = LocalOmpColors.current
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(
            imageVector = Icons.Filled.Warning,
            contentDescription = null,
            tint = colors.textDim,
            modifier = Modifier.size(22.dp),
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = stringResource(R.string.files_binary_title),
            color = colors.text,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            text = stringResource(
                R.string.files_binary_body,
                mime.ifBlank { stringResource(R.string.files_binary_unknown_type) },
                formatFileSize(size),
            ),
            color = colors.textMuted,
            fontSize = 11.5.sp,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = onDownload) { Text(stringResource(R.string.files_download)) }
            TextButton(onClick = onShare) { Text(stringResource(R.string.files_share)) }
        }
    }
}

@Composable
private fun ViewerMessage(message: String, action: Pair<String, () -> Unit>?) {
    val colors = LocalOmpColors.current
    Column(
        modifier = Modifier.fillMaxSize().padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = message,
            color = colors.textMuted,
            fontSize = 12.sp,
            textAlign = TextAlign.Center,
        )
        if (action != null) {
            Spacer(Modifier.height(8.dp))
            TextButton(onClick = action.second) {
                Text(action.first, color = colors.accent, fontSize = 12.sp)
            }
        }
    }
}

/** The server-rendered document (docx) and an HTML source preview. */
@Composable
private fun HtmlDocument(html: String, modifier: Modifier = Modifier) {
    // `update` runs on every recomposition; `loadDataWithBaseURL` would reset
    // the scroll position each time, so only a changed document is loaded.
    val loaded = remember { arrayOfNulls<String>(1) }
    AndroidView(
        modifier = modifier,
        factory = { context ->
            WebView(context).apply { configureHtmlPreview(this) }
        },
        update = { view ->
            if (loaded[0] != html) {
                loaded[0] = html
                loadHtmlPreview(view, html)
            }
        },
    )
}

/**
 * PDF pages through the platform `PdfRenderer`: the file was downloaded into
 * the app cache by `FilesViewModel`, so no byte ever leaves the device again.
 * The bitmaps are rendered off the main thread, one page at a time.
 */
@Composable
private fun PdfPages(tab: FileTab) {
    val colors = LocalOmpColors.current
    val path = tab.pdfPath
    if (path == null) {
        ViewerMessage(message = stringResource(R.string.files_pdf_failed), action = null)
        return
    }
    val file = remember(path) { File(path) }
    var pageIndex by remember(path) { mutableIntStateOf(0) }
    val measured by produceState<Int?>(initialValue = null, path) {
        value = withContext(Dispatchers.IO) { pdfPageCount(file) }
    }
    val pageCount = measured
    if (pageCount == null) {
        // Counting a large PDF takes a moment; claiming a failure here would
        // flash "could not render" for every file that opens fine.
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(strokeWidth = 2.dp, color = colors.accent, modifier = Modifier.size(20.dp))
        }
        return
    }
    if (pageCount <= 0) {
        ViewerMessage(message = stringResource(R.string.files_pdf_failed), action = null)
        return
    }
    val index = pageIndex.coerceIn(0, pageCount - 1)
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val widthPx = with(LocalDensity.current) { maxWidth.roundToPx() }
        val page by produceState<Result<androidx.compose.ui.graphics.ImageBitmap>?>(null, path, index, widthPx) {
            value = withContext(Dispatchers.IO) { renderPdfPage(file, index, widthPx) }
        }
        Column(Modifier.fillMaxSize()) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(
                    onClick = { if (index > 0) pageIndex = index - 1 },
                    enabled = index > 0,
                    modifier = Modifier.size(30.dp),
                ) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowLeft,
                        contentDescription = stringResource(R.string.files_pdf_previous),
                        tint = if (index > 0) colors.textMuted else colors.textDim,
                        modifier = Modifier.size(18.dp),
                    )
                }
                Text(
                    text = stringResource(R.string.files_pdf_page, index + 1, pageCount),
                    modifier = Modifier.weight(1f),
                    color = colors.textMuted,
                    fontSize = 11.sp,
                    textAlign = TextAlign.Center,
                )
                IconButton(
                    onClick = { if (index < pageCount - 1) pageIndex = index + 1 },
                    enabled = index < pageCount - 1,
                    modifier = Modifier.size(30.dp),
                ) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                        contentDescription = stringResource(R.string.files_pdf_next),
                        tint = if (index < pageCount - 1) colors.textMuted else colors.textDim,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
            val current = page
            Box(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .background(colors.backgroundSubtle),
                contentAlignment = Alignment.TopCenter,
            ) {
                when {
                    current == null -> CircularProgressIndicator(
                        strokeWidth = 2.dp,
                        color = colors.accent,
                        modifier = Modifier.padding(top = 24.dp).size(20.dp),
                    )

                    current.isFailure -> Text(
                        text = stringResource(R.string.files_pdf_failed),
                        modifier = Modifier.padding(24.dp),
                        color = colors.statusError,
                        fontSize = 12.sp,
                    )

                    else -> Image(
                        bitmap = current.getOrThrow(),
                        contentDescription = stringResource(R.string.files_pdf_page, index + 1, pageCount),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}

private fun pdfPageCount(file: File): Int = runCatching {
    ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
        PdfRenderer(descriptor).use { renderer -> renderer.pageCount }
    }
}.getOrDefault(0)

private fun renderPdfPage(
    file: File,
    index: Int,
    widthPx: Int,
): Result<androidx.compose.ui.graphics.ImageBitmap> = runCatching {
    ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
        PdfRenderer(descriptor).use { renderer ->
            val target = index.coerceIn(0, renderer.pageCount - 1)
            renderer.openPage(target).use { page ->
                // Long pages stay readable: the width is the pane, the height follows the ratio.
                val width = maxOf(1, widthPx)
                val height = maxOf(1, (page.height.toFloat() * width / page.width).toInt())
                val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                bitmap.eraseColor(android.graphics.Color.WHITE)
                page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                bitmap.asImageBitmap()
            }
        }
    }
}

@Composable
private fun ViewerMenuItem(label: Int, onClick: () -> Unit) {
    DropdownMenuItem(
        text = { Text(stringResource(label), fontSize = 12.sp) },
        onClick = onClick,
    )
}
