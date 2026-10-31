package io.github.kahme247.ompweb.domain

import io.github.kahme247.ompweb.ui.files.FileOpenMode

/**
 * How the file viewer renders a path, and which modes it offers.
 *
 * Port of the client halves of `lib/file-types.ts` and
 * `components/FileViewer.tsx`: the extension table decides image/audio/PDF/
 * docx, everything else is text until the server answers with a binary body.
 * PDF and docx are documents the app renders itself; audio is not a preview
 * type of the phone panel (the inventory's file-viewer row lists markdown,
 * docx, image and binary only), so it is offered as a download like any other
 * binary.
 */
enum class ViewerKind { Image, Pdf, Docx, Text }

/** The two response languages the viewer can render instead of raw source. */
enum class TextPreviewKind { Markdown, Html }

private val IMAGE_EXTENSIONS = setOf("png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif")

private val PDF_EXTENSIONS = setOf("pdf")
private val DOCX_EXTENSIONS = setOf("docx")

/** The one definition of "Markdown" for the viewer and the composer. */
private val MARKDOWN_EXTENSIONS = setOf("md", "markdown", "mdx")

/** `getFileExt` (web) is [fileExtension] in `domain/Attachments.kt`. */

fun isImageFile(filePath: String): Boolean = fileExtension(filePath) in IMAGE_EXTENSIONS

fun isPdfFile(filePath: String): Boolean = fileExtension(filePath) in PDF_EXTENSIONS

fun isDocxFile(filePath: String): Boolean = fileExtension(filePath) in DOCX_EXTENSIONS

/** The extension-first classification; an unknown extension is treated as text. */
fun viewerKind(filePath: String): ViewerKind = when {
    isImageFile(filePath) -> ViewerKind.Image
    isPdfFile(filePath) -> ViewerKind.Pdf
    isDocxFile(filePath) -> ViewerKind.Docx
    else -> ViewerKind.Text
}

/** Preview is offered exactly for the two languages the viewer can render. */
fun textPreviewKind(language: String?): TextPreviewKind? = when (language?.lowercase()) {
    "markdown", "md" -> TextPreviewKind.Markdown
    "html", "htm" -> TextPreviewKind.Html
    else -> null
}

/** Markdown opens on its rendered preview like the web; everything else on source. */
fun defaultViewerMode(filePath: String, language: String? = null): FileOpenMode {
    if (viewerKind(filePath) != ViewerKind.Text) return FileOpenMode.Source
    return when {
        textPreviewKind(language) != null -> FileOpenMode.Preview
        isMarkdownFile(filePath) -> FileOpenMode.Preview
        else -> FileOpenMode.Source
    }
}

fun isMarkdownFile(filePath: String): Boolean =
    fileExtension(filePath) in MARKDOWN_EXTENSIONS

/**
 * The mode buttons the toolbar shows, in order. Source is always available for
 * text; Preview only for markdown/HTML; Diff only when git reported a textual
 * patch. A non-text file has no mode switch at all.
 */
fun availableViewerModes(kind: ViewerKind, language: String?, hasDiff: Boolean): List<FileOpenMode> {
    if (kind != ViewerKind.Text) return emptyList()
    return buildList {
        add(FileOpenMode.Source)
        if (textPreviewKind(language) != null) add(FileOpenMode.Preview)
        if (hasDiff) add(FileOpenMode.Diff)
    }
}

/** Falls back to Source when the requested mode is not offered (web's guard effect). */
fun effectiveViewerMode(requested: FileOpenMode, available: List<FileOpenMode>): FileOpenMode =
    if (requested in available || available.isEmpty()) requested else FileOpenMode.Source

// --- Upload conflicts -------------------------------------------------------

/** The strategies the web sends as `?conflict=`; `error` is the pre-flight-free first try. */
enum class UploadConflictStrategy(val wire: String) {
    Error("error"),
    Overwrite("overwrite"),
    Skip("skip"),
}

/** The pre-flight answer: names already present, and the subset replace cannot touch. */
data class UploadConflictPlan(
    val conflicts: List<String>,
    val nonReplaceable: List<String>,
) {
    /** Files "Replace all" can actually overwrite. */
    val replaceable: List<String> get() = conflicts.filterNot { it in nonReplaceable.toSet() }

    /** At least one file can be overwritten, so the Replace button is meaningful. */
    val canReplace: Boolean get() = replaceable.isNotEmpty()
}

/**
 * The conflict dialog's data, or null when the pre-flight found nothing to ask
 * about. `nonReplaceable` entries are still listed: the web names them above
 * the buttons instead of letting "Replace all" fail per file.
 */
fun uploadConflictPlan(conflicts: List<String>, nonReplaceable: List<String>): UploadConflictPlan? {
    if (conflicts.isEmpty()) return null
    val known = conflicts.toSet()
    return UploadConflictPlan(
        conflicts = conflicts.distinct(),
        nonReplaceable = nonReplaceable.filter { it in known }.distinct(),
    )
}

/**
 * Upload caps shared with the server (`lib/upload-limits.ts`): 25 MiB per
 * file, 100 MiB per selection. Every file travels in its own request, so one
 * request stays below the server's 26 MiB pre-auth proxy cap.
 */
const val MAX_UPLOAD_BYTES_PER_FILE: Long = 25L * 1024 * 1024
const val MAX_UPLOAD_BYTES_TOTAL: Long = 100L * 1024 * 1024

/** `formatSize` in the web explorer: bytes under 1 KiB, one decimal for KiB/MiB. */
fun formatFileSize(bytes: Long): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> formatDecimal(bytes / 1024.0) + " KB"
    else -> formatDecimal(bytes / (1024.0 * 1024.0)) + " MB"
}
