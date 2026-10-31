package io.github.kahme247.ompweb.a11y

import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.performClick
import io.github.kahme247.ompweb.chat.ChatState
import io.github.kahme247.ompweb.screenshot.ChatTranscriptFixture
import io.github.kahme247.ompweb.screenshot.ComposerFixture
import io.github.kahme247.ompweb.screenshot.ComposerPanelsFixture
import io.github.kahme247.ompweb.screenshot.composerScreenshotControllers
import io.github.kahme247.ompweb.ui.chat.ChatFooter
import io.github.kahme247.ompweb.ui.chat.ChatUiState
import io.github.kahme247.ompweb.ui.panels.extension.ExtensionDialogHost
import io.github.kahme247.ompweb.ui.panels.extension.ExtensionUiController
import io.github.kahme247.ompweb.ui.theme.OmpWebTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import io.github.kahme247.ompweb.net.ExtensionApi
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * TalkBack contract for the U1 surfaces, asserted on the Compose semantics
 * tree (not on pixels): every icon-only control is labeled, tool rows are one
 * button, panels expose a heading + button role, and run status changes are
 * announced through a polite live region.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w411dp-h890dp-mdpi", application = android.app.Application::class)
class AccessibilitySemanticsTest {

    @get:Rule
    val composeRule: ComposeContentTestRule = createComposeRule()

    @Test
    fun composerAttachButtonIsLabeledAndTappable() {
        val controllers = composerScreenshotControllers(CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate))
        composeRule.setContent {
            OmpWebTheme {
                ComposerFixture(
                    controllers = controllers,
                    queue = io.github.kahme247.ompweb.chat.QueueSnapshot(),
                    autoRetry = null,
                )
            }
        }
        composeRule.onNodeWithContentDescription("Add attachment").assertHasClickAction()
    }

    @Test
    fun panelHeaderIsAHeadingButton() {
        composeRule.setContent { OmpWebTheme { ComposerPanelsFixture() } }
        val header = composeRule.onNode(
            hasText("Tasks") and hasClickAction() and
                SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading),
        )
        header.assertExists()
        composeRule.onNodeWithText("Add the Robolectric render harness").assertExists()
        header.performClick()
        composeRule.onNodeWithText("Add the Robolectric render harness").assertDoesNotExist()
    }

    @Test
    fun toolRowIsOneButtonWithMergedContent() {
        composeRule.setContent { OmpWebTheme { ChatTranscriptFixture() } }
        composeRule.onAllNodesWithTag("chat-tool-card-header").onFirst()
            .assertHasClickAction()
            .assert(hasText("edit", substring = true))
    }

    @Test
    fun footerRunStatusIsAPoliteLiveRegion() {
        composeRule.setContent {
            OmpWebTheme {
                ChatFooter(ChatUiState(engine = ChatState(agentRunning = true)))
            }
        }
        composeRule.onNode(
            hasAnyDescendant(hasText("working")) and SemanticsMatcher.expectValue(
                SemanticsProperties.LiveRegion,
                LiveRegionMode.Polite,
            ),
        ).assertExists()
    }

    @Test
    fun extensionDialogTitleIsAHeading() {
        val controller = ExtensionUiController(
            api = object : ExtensionApi {
                override suspend fun command(sessionId: String, command: JsonObject): JsonElement? = null
            },
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
        )
        controller.bind("session-1")
        controller.onFrame(
            buildJsonObject {
                put("type", "extension_ui_request")
                put("id", "ask-a11y")
                put("method", "ask")
                putJsonArray("questions") {
                    add(
                        buildJsonObject {
                            put("id", "q1")
                            put("question", "Continue?")
                            putJsonArray("options") { add(buildJsonObject { put("label", "Yes") }) }
                        },
                    )
                }
            },
        )
        composeRule.setContent { OmpWebTheme { ExtensionDialogHost(controller) } }
        composeRule.onNode(
            hasText("Questions from the agent") and
                SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading),
        ).assertExists()
    }
}
