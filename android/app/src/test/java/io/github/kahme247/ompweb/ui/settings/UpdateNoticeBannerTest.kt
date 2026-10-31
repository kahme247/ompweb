package io.github.kahme247.ompweb.ui.settings

import android.content.Context
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.UpdateKind
import io.github.kahme247.ompweb.domain.UpdateNoticeState
import io.github.kahme247.ompweb.screenshot.ScreenshotMatrix
import io.github.kahme247.ompweb.ui.theme.OmpWebTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The 1.0.7 review found the banner's single line cut from the back: on 320 dp
 * the ellipsis removed the target version and kept only the constant title.
 * The version now leads the summary, so these tests measure the *rendered*
 * line — semantics would happily report the full string even while it is
 * clipped — and pin that the version survives 320 dp/100 % and 200 % text.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w320dp-h640dp-mdpi", application = android.app.Application::class)
class UpdateNoticeBannerTest {

    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun theTargetVersionIsVisibleOnTheNarrowestPhone() {
        val layout = render(fontScale = 1f)
        assertEquals("100 % text stays on one line", 1, layout.lineCount)
        assertVersionVisible(layout)
        assertTrue(
            "the row must really be too narrow for the whole summary, or this test proves nothing",
            layout.isLineEllipsized(0),
        )
    }

    @Test
    fun aLargeFontScaleUsesTwoLinesInsteadOfClippingTheVersion() {
        val layout = render(fontScale = 2f)
        assertEquals("200 % text may use a second line", 2, layout.lineCount)
        assertVersionVisible(layout)
    }

    /**
     * The banner on a 320 dp phone: the call site pads 10 dp per side
     * (`OmpWebRoot`), so the row is 300 dp wide. The theme is the light one
     * the matrix uses; only the font scale changes.
     */
    private fun render(fontScale: Float): TextLayoutResult {
        composeRule.setContent {
            CompositionLocalProvider(LocalDensity provides Density(density = 1f, fontScale = fontScale)) {
                OmpWebTheme(themeId = ScreenshotMatrix.LIGHT_THEME_ID) {
                    Box(modifier = Modifier.size(320.dp, 240.dp).padding(horizontal = 10.dp)) {
                        UpdateNoticeBanner(
                            state = UpdateNoticeState(
                                kind = UpdateKind.APP,
                                currentVersion = "0.5.2",
                                availableVersion = "0.6.0",
                            ),
                            onOpenSettings = {},
                            onDismiss = {},
                        )
                    }
                }
            }
        }
        composeRule.waitForIdle()

        val layouts = mutableListOf<TextLayoutResult>()
        composeRule.onNodeWithTag("update-notice-summary", useUnmergedTree = true)
            .fetchSemanticsNode()
            .config[SemanticsActions.GetTextLayoutResult]
            .action
            ?.invoke(layouts)
        return layouts.single()
    }

    private fun assertVersionVisible(layout: TextLayoutResult) {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val version = context.getString(R.string.update_banner_version, "0.5.2", "0.6.0")
        val text = layout.layoutInput.text.text
        assertEquals(
            "the summary must carry the version and the title",
            version,
            text.substring(0, version.length),
        )

        // Offsets refer to the whole string; `visibleEnd` stops before an
        // ellipsis, so this is the last character the reader can see.
        val versionEnd = version.length
        val visibleEnd = layout.getLineEnd(layout.lineCount - 1, visibleEnd = true)
        assertTrue(
            "the target version must be visible (visible end=$visibleEnd, version end=$versionEnd, " +
                "lines=${layout.lineCount}, text=\"$text\")",
            visibleEnd >= versionEnd,
        )
        assertTrue(
            "v0.6.0 is the news and must be on screen",
            text.substring(0, minOf(visibleEnd, text.length)).contains("v0.6.0"),
        )
    }
}
