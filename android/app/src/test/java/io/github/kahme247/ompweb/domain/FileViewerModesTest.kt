package io.github.kahme247.ompweb.domain

import io.github.kahme247.ompweb.ui.files.FileOpenMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The viewer's type/mode decisions (`lib/file-types` in the web) and the upload caps. */
class FileViewerModesTest {

    @Test
    fun extensionsClassifyTheViewerKind() {
        assertEquals(ViewerKind.Image, viewerKind("/w/logo.png"))
        assertEquals(ViewerKind.Image, viewerKind("C:\\w\\photo.JPEG"))
        assertEquals(ViewerKind.Pdf, viewerKind("/w/spec.pdf"))
        assertEquals(ViewerKind.Docx, viewerKind("/w/report.docx"))
        assertEquals(ViewerKind.Text, viewerKind("/w/src/Main.kt"))
        assertEquals(ViewerKind.Text, viewerKind("/w/Makefile"))
    }

    @Test
    fun theTypePredicatesFollowTheSameExtensionSets() {
        assertTrue(isImageFile("a.webp"))
        assertFalse(isImageFile("a.svgz"))
        assertTrue(isPdfFile("a.PDF"))
        assertTrue(isDocxFile("a.docx"))
        assertTrue(isMarkdownFile("notes.md"))
        assertTrue(isMarkdownFile("notes.markdown"))
        assertFalse(isMarkdownFile("notes.txt"))
    }

    @Test
    fun markdownOpensOnItsPreviewAndEverythingElseOnSource() {
        assertEquals(FileOpenMode.Preview, defaultViewerMode("/w/readme.md"))
        assertEquals(FileOpenMode.Source, defaultViewerMode("/w/Main.kt"))
        assertEquals(FileOpenMode.Source, defaultViewerMode("/w/logo.png"))
    }

    @Test
    fun textOffersSourceAndPreviewAndDiffOnlyWithAPatch() {
        val markdown = availableViewerModes(ViewerKind.Text, "markdown", hasDiff = false)
        assertTrue(FileOpenMode.Source in markdown)
        assertTrue(FileOpenMode.Preview in markdown)
        assertFalse(FileOpenMode.Diff in markdown)

        val changed = availableViewerModes(ViewerKind.Text, "kotlin", hasDiff = true)
        assertTrue(FileOpenMode.Diff in changed)
        assertFalse("only markdown/HTML has a rendered preview", FileOpenMode.Preview in changed)
    }

    @Test
    fun aBinaryFileHasNoModeSwitch() {
        assertTrue(availableViewerModes(ViewerKind.Image, null, hasDiff = false).isEmpty())
        assertTrue(availableViewerModes(ViewerKind.Pdf, null, hasDiff = true).isEmpty())
    }

    @Test
    fun aModeThatIsNotOfferedFallsBackToSource() {
        assertEquals(
            FileOpenMode.Source,
            effectiveViewerMode(FileOpenMode.Preview, listOf(FileOpenMode.Source, FileOpenMode.Diff)),
        )
        assertEquals(
            FileOpenMode.Preview,
            effectiveViewerMode(FileOpenMode.Preview, listOf(FileOpenMode.Source, FileOpenMode.Preview)),
        )
    }

    @Test
    fun fileSizesUseOneDecimalWithoutATrailingZero() {
        assertEquals("512 B", formatFileSize(512))
        assertEquals("1 KB", formatFileSize(1024))
        assertEquals("1.5 KB", formatFileSize(1536))
        assertEquals("2.3 MB", formatFileSize(2_411_724))
        // Shared with the token chips (`domain/Decimals.kt`).
        assertEquals("1", formatDecimal(1.0))
        assertEquals("1.5", formatDecimal(1.54))
        assertEquals("12", formatDecimal(11.6, decimals = 0))
    }

    @Test
    fun aPreflightWithNothingToAskReturnsNoDialog() {
        assertEquals(null, uploadConflictPlan(emptyList(), emptyList()))
        val plan = uploadConflictPlan(listOf("a.kt", "b.kt"), listOf("b.kt"))
        assertEquals(listOf("a.kt", "b.kt"), plan?.conflicts)
        assertEquals(listOf("b.kt"), plan?.nonReplaceable)
    }
}
