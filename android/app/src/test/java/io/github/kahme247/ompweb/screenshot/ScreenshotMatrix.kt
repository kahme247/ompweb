package io.github.kahme247.ompweb.screenshot

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import io.github.kahme247.ompweb.ui.chat.LocalChatClock
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpWebTheme
import java.awt.image.BufferedImage
import java.io.File
import java.util.Locale
import java.util.TimeZone
import javax.imageio.ImageIO
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The hardening matrix: the five phone /
 * foldable / tablet widths against the three supported font scales, each in the
 * light theme plus one dark theme.
 */
data class ScreenshotCell(
    val widthDp: Int,
    val fontScale: Float,
    val themeId: String,
) {
    val dark: Boolean get() = themeId != ScreenshotMatrix.LIGHT_THEME_ID

    /** Stable golden file name and failure label, e.g. `w411-f1.5-dark`. */
    val id: String
        get() = "w$widthDp-f" + String.format(Locale.US, "%.1f", fontScale) + "-" +
            (if (dark) "dark" else "light")
}

object ScreenshotMatrix {

    /** `light`: the app's light palette (the default `omp` theme is OMP Midnight, a dark one). */
    const val LIGHT_THEME_ID = "light"

    /** The app's default dark palette (`OmpTheme.tokyo_night`). */
    const val DARK_THEME_ID = "tokyo-night"

    val widthsDp: List<Int> = listOf(320, 360, 411, 600, 840)

    val fontScales: List<Float> = listOf(1.0f, 1.5f, 2.0f)

    /** 5 widths × 3 font scales × 2 themes = 30 cells. */
    val cells: List<ScreenshotCell> = buildList {
        for (widthDp in widthsDp) {
            for (fontScale in fontScales) add(ScreenshotCell(widthDp, fontScale, LIGHT_THEME_ID))
        }
        for (widthDp in widthsDp) {
            for (fontScale in fontScales) add(ScreenshotCell(widthDp, fontScale, DARK_THEME_ID))
        }
    }
}

private const val ROOT_TAG = "ompweb-screenshot-root"
private const val GOLDEN_DIR = "src/test/screenshots"
private const val FAILURE_DIR = "build/screenshot-failures"

/**
 * The fixed wall clock of the whole screenshot matrix (2026-10-26 12:00 UTC,
 * the test time zone). Fixture timestamps are relative to it, so "today",
 * "yesterday" and the ticking elapsed times render identically on any host and
 * on any real day.
 */
internal const val SCREENSHOT_NOW = 1_793_016_000_000L

/**
 * Base class for every screenshot test. The annotations pin the rendering
 * environment so the golden pixels do not depend on the host:
 * API 36 (the Robolectric test runtime; the app compiles against 37), mdpi and
 * a large window (the matrix box sets the real width), native Skia graphics
 * rendered to ImageIO PNGs. [verifyScreenshotMatrix] additionally pins density
 * to 1 and the font scale per cell, so no device setup leaks in.
 *
 * Subclasses only add `@Test` methods:
 * ```
 * class ChatTranscriptScreenshotsTest : ScreenshotTest() {
 *     @Test fun transcript() = composeRule.verifyScreenshotMatrix("chat-transcript") { … }
 * }
 * ```
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(
    sdk = [36],
    qualifiers = "w1200dp-h1600dp-mdpi",
    application = android.app.Application::class,
)
abstract class ScreenshotTest {

    @get:Rule
    val composeRule = createComposeRule()

    init {
        // Timestamps, dates and number formats in the rendered rows must not
        // depend on the build host's locale or time zone.
        Locale.setDefault(Locale.US)
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
    }
}

/**
 * Renders [content] for every cell of the hardening matrix and verifies
 * (default) or records the golden PNG. The content is composed afresh per
 * cell, inside `OmpWebTheme`, below a fixed [heightDp] × cell-width surface
 * that is also the captured node.
 */
fun ComposeContentTestRule.verifyScreenshotMatrix(
    name: String,
    heightDp: Int = 800,
    interact: (() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val cells = ScreenshotMatrix.cells
    require(cells.isNotEmpty()) { "screenshot matrix '$name' has no cells" }
    val current = mutableStateOf(cells.first())
    setContent {
        val cell = current.value
        CompositionLocalProvider(
            LocalDensity provides Density(density = 1f, fontScale = cell.fontScale),
            // Transcript timestamps, day buckets and ticking elapsed times are
            // wall-clock reads; a fixed clock keeps every golden reproducible.
            LocalChatClock provides { SCREENSHOT_NOW },
        ) {
            OmpWebTheme(themeId = cell.themeId) {
                Box(
                    modifier = Modifier
                        .size(cell.widthDp.dp, heightDp.dp)
                        .background(LocalOmpColors.current.background)
                        .testTag(ROOT_TAG),
                ) {
                    key(cell.id) { content() }
                }
            }
        }
    }
    for (cell in cells) {
        runOnIdle { current.value = cell }
        waitForIdle()
        interact?.invoke()
        waitForIdle()
        verifyCell(
            name = name,
            cell = cell,
            heightDp = heightDp,
            image = onNodeWithTag(ROOT_TAG, useUnmergedTree = true).captureToImage(),
        )
    }
}

private fun ComposeContentTestRule.verifyCell(
    name: String,
    cell: ScreenshotCell,
    heightDp: Int,
    image: androidx.compose.ui.graphics.ImageBitmap,
) {
    val bitmap = image.asAndroidBitmap()
    val actual = BitmapPixels(
        width = bitmap.width,
        height = bitmap.height,
        pixels = IntArray(bitmap.width * bitmap.height).also { pixels ->
            bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        },
    )
    val golden = goldenFile(name, cell)
    if (recording()) {
        golden.parentFile?.mkdirs()
        writePng(golden, actual)
        return
    }
    if (!golden.isFile) {
        fail(
            "missing golden ${relative(golden)} for '$name/${cell.id}' " +
                "(${cell.widthDp}dp, font scale ${cell.fontScale}, ${cell.themeId}, height ${heightDp}dp). " +
                "Record it with: ./gradlew recordScreenshots",
        )
    }
    val expected = readPng(golden)
    val problem = expected.compare(actual)
    if (problem != null) {
        val failureDir = File(System.getProperty("user.dir"), FAILURE_DIR).resolve(name)
        failureDir.mkdirs()
        writePng(File(failureDir, "${cell.id}-actual.png"), actual)
        writePng(File(failureDir, "${cell.id}-diff.png"), expected.diff(actual))
        fail(
            "screenshot '$name/${cell.id}' differs from ${relative(golden)}: $problem. " +
                "Actual and diff written to ${relative(failureDir)}. " +
                "If the change is intended, record with: ./gradlew recordScreenshots",
        )
    }
}

internal class BitmapPixels(val width: Int, val height: Int, val pixels: IntArray) {

    fun compare(other: BitmapPixels): String? {
        if (width != other.width || height != other.height) {
            return "expected ${width}x$height, rendered ${other.width}x${other.height}"
        }
        var differing = 0
        var firstX = -1
        var firstY = -1
        for (index in pixels.indices) {
            if (pixels[index] != other.pixels[index]) {
                if (differing == 0) {
                    firstX = index % width
                    firstY = index / width
                }
                differing++
            }
        }
        if (differing == 0) return null
        return "$differing of ${pixels.size} pixel(s) differ (first at ${firstX},${firstY})"
    }

    fun diff(other: BitmapPixels): BitmapPixels {
        val size = width * height
        val out = IntArray(size)
        for (index in 0 until size) {
            out[index] = if (
                index < other.pixels.size &&
                width == other.width &&
                height == other.height &&
                pixels[index] == other.pixels[index]
            ) {
                // Unchanged pixels stay as a faint backdrop; changes pop.
                (pixels[index] and 0x00FFFFFF) or 0x40000000
            } else {
                0xFFFF00FF.toInt()
            }
        }
        return BitmapPixels(width, height, out)
    }
}

private fun recording(): Boolean =
    System.getProperty("ompweb.screenshot.record") == "true" ||
        System.getenv("OMPWEB_SCREENSHOT_RECORD") == "1"

private fun goldenFile(name: String, cell: ScreenshotCell): File =
    File(System.getProperty("user.dir"), GOLDEN_DIR).resolve(name).resolve("${cell.id}.png")

private fun relative(file: File): String =
    file.absoluteFile.toRelativeString(File(System.getProperty("user.dir")).absoluteFile)

private fun writePng(file: File, pixels: BitmapPixels) {
    val image = BufferedImage(pixels.width, pixels.height, BufferedImage.TYPE_INT_ARGB)
    image.setRGB(0, 0, pixels.width, pixels.height, pixels.pixels, 0, pixels.width)
    ImageIO.write(image, "png", file)
}

private fun readPng(file: File): BitmapPixels {
    val image = ImageIO.read(file)
    val width = image.width
    val height = image.height
    val pixels = IntArray(width * height)
    image.getRGB(0, 0, width, height, pixels, 0, width)
    return BitmapPixels(width, height, pixels)
}
