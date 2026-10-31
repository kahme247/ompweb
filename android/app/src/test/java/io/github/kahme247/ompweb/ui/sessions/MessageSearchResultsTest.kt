package io.github.kahme247.ompweb.ui.sessions

import android.content.Context
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.net.SessionSearchHit
import io.github.kahme247.ompweb.ui.theme.OmpWebTheme
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * A page of "Search in messages" that stopped on the server's time/byte budget
 * is not an empty result: the scan simply had not reached a hit yet (one large
 * session file can fill the first pages on its own). The next page therefore has
 * to stay reachable when the page holds no row, and "No matches" may only
 * appear once the server reports the scan as complete.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w411dp-h891dp-mdpi", application = android.app.Application::class)
class MessageSearchResultsTest {

    @get:Rule
    val composeRule = createComposeRule()

    private val context: Context = ApplicationProvider.getApplicationContext()

    private fun render(state: MessageSearchState, onLoadMore: () -> Unit = {}) {
        composeRule.setContent {
            OmpWebTheme {
                MessageSearchResults(
                    search = state,
                    sessions = emptyList(),
                    now = Instant.parse("2026-10-25T12:00:00Z"),
                    onOpenHit = {},
                    onLoadMore = onLoadMore,
                    onRetry = {},
                )
            }
        }
    }

    @Test
    fun anEmptyPageWithCursorOffersTheNextPageInsteadOfReportingNoMatches() {
        var loads = 0
        render(
            MessageSearchState(query = "questn", partial = true, cursor = "cursor-1"),
            onLoadMore = { loads++ },
        )

        composeRule.onNodeWithText(context.getString(R.string.sessions_search_messages_partial))
            .assertIsDisplayed()
        composeRule.onNodeWithText(context.getString(R.string.sessions_search_messages_load_more))
            .assertIsDisplayed()
            .performClick()
        composeRule.waitForIdle()
        assertEquals(1, loads)
        composeRule.onNodeWithText(context.getString(R.string.sessions_search_messages_empty))
            .assertDoesNotExist()
    }

    @Test
    fun aCompleteEmptyPageReportsNoMatchesWithoutAPageButton() {
        var loads = 0
        render(MessageSearchState(query = "questn"), onLoadMore = { loads++ })

        composeRule.onNodeWithText(context.getString(R.string.sessions_search_messages_empty))
            .assertIsDisplayed()
        composeRule.onNodeWithText(context.getString(R.string.sessions_search_messages_load_more))
            .assertDoesNotExist()
        composeRule.onNodeWithText(context.getString(R.string.sessions_search_messages_partial))
            .assertDoesNotExist()
        assertEquals(0, loads)
    }

    @Test
    fun aPartialPageWithoutCursorExplainsTheStopAndOffersNoDeadButton() {
        render(MessageSearchState(query = "questn", partial = true))

        composeRule.onNodeWithText(context.getString(R.string.sessions_search_messages_partial))
            .assertIsDisplayed()
        composeRule.onNodeWithText(context.getString(R.string.sessions_search_messages_load_more))
            .assertDoesNotExist()
        composeRule.onNodeWithText(context.getString(R.string.sessions_search_messages_empty))
            .assertDoesNotExist()
    }

    @Test
    fun aPageThatSkippedOversizedSessionFilesSaysSoAboveTheResults() {
        render(
            MessageSearchState(
                query = "needle",
                results = listOf(hit("s1", "e1")),
                skippedFiles = 2,
            ),
        )

        composeRule.onNodeWithText(skippedText(2)).assertIsDisplayed()
        composeRule.onNodeWithText("a needle here").assertIsDisplayed()
    }

    @Test
    fun aSkippedFileQualifiesTheNoMatchesAnswer() {
        render(MessageSearchState(query = "needle", skippedFiles = 1))

        composeRule.onNodeWithText(context.getString(R.string.sessions_search_messages_empty))
            .assertIsDisplayed()
        composeRule.onNodeWithText(skippedText(1)).assertIsDisplayed()
    }

    @Test
    fun withoutASkippedFileTheResultsCarryNoNotice() {
        render(MessageSearchState(query = "needle", results = listOf(hit("s1", "e1"))))

        composeRule.onNodeWithText(skippedText(1)).assertDoesNotExist()
        composeRule.onNodeWithText(skippedText(2)).assertDoesNotExist()
    }

    private fun hit(sessionId: String, entryId: String) = SessionSearchHit(
        sessionId = sessionId,
        title = "T",
        entryId = entryId,
        role = "user",
        timestamp = "2026-10-25T11:00:00.000Z",
        snippet = "a needle here",
        matchStart = 2,
        matchEnd = 8,
    )

    private fun skippedText(count: Int): String =
        context.resources.getQuantityString(R.plurals.sessions_search_messages_skipped, count, count)
}
