package io.github.kahme247.ompweb.ui.sessions

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import io.github.kahme247.ompweb.net.ArchiveEntry
import io.github.kahme247.ompweb.screenshot.ScreenshotMatrix
import io.github.kahme247.ompweb.ui.theme.OmpWebTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * B28/B34: the archive browser selects entries, offers restore and hands the
 * *entry's id* to the copy action (the screen then writes it through
 * `SessionExport.copyId`).
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w411dp-h890dp-mdpi", application = android.app.Application::class)
class ArchiveBrowserDialogTest {

    @get:Rule
    val composeRule = createComposeRule()

    private val entry = ArchiveEntry(
        key = "arch-key-1",
        id = "sess-archived-1",
        cwd = "/home/dev/projects/ompweb",
        name = "Old sidebar work",
        firstMessage = "The drawer clips",
        status = "archived",
        archivedAt = "2020-01-05T10:00:00Z",
        messageCount = 12,
        size = 2048,
    )

    @Test
    fun copyIdPassesTheSelectedEntrysSessionId() {
        var copied: String? = null
        composeRule.setContent {
            OmpWebTheme(themeId = ScreenshotMatrix.LIGHT_THEME_ID) {
                ArchiveBrowserDialog(
                    state = ArchiveUiState(
                        open = true,
                        entries = listOf(entry),
                        search = "",
                        selectedKey = entry.key,
                    ),
                    onClose = {},
                    onRefresh = {},
                    onSearch = {},
                    onSelect = {},
                    onRestore = {},
                    onCopyId = { copied = it },
                )
            }
        }

        composeRule.onNodeWithText("Copy ID").assertIsDisplayed()
        composeRule.onNodeWithText("Copy ID").performClick()

        assertEquals("the copy action receives the session id, not the archive key", entry.id, copied)
    }

    @Test
    fun selectingAnotherRowUpdatesTheSelection() {
        var selected: String? = null
        val second = entry.copy(key = "arch-key-2", id = "sess-archived-2", name = "Newer work")
        composeRule.setContent {
            OmpWebTheme(themeId = ScreenshotMatrix.LIGHT_THEME_ID) {
                ArchiveBrowserDialog(
                    state = ArchiveUiState(
                        open = true,
                        entries = listOf(entry, second),
                        search = "",
                        selectedKey = entry.key,
                    ),
                    onClose = {},
                    onRefresh = {},
                    onSearch = {},
                    onSelect = { selected = it },
                    onRestore = {},
                    onCopyId = {},
                )
            }
        }

        composeRule.onNodeWithText("Newer work").performClick()
        assertEquals("arch-key-2", selected)
    }

    @Test
    fun theSearchFilterHidesNonMatchingEntries() {
        var selected: String? = null
        val second = entry.copy(key = "arch-key-2", id = "sess-archived-2", name = "Newer work")
        composeRule.setContent {
            OmpWebTheme(themeId = ScreenshotMatrix.LIGHT_THEME_ID) {
                ArchiveBrowserDialog(
                    state = ArchiveUiState(
                        open = true,
                        entries = listOf(entry, second),
                        search = "newer",
                        selectedKey = null,
                    ),
                    onClose = {},
                    onRefresh = {},
                    onSearch = {},
                    onSelect = { selected = it },
                    onRestore = {},
                    onCopyId = {},
                )
            }
        }

        composeRule.onNodeWithText("Newer work").assertIsDisplayed()
        composeRule.onNodeWithText("Old sidebar work").assertDoesNotExist()
        assertEquals("the first visible entry is selected", "arch-key-2", selected)
    }
}
