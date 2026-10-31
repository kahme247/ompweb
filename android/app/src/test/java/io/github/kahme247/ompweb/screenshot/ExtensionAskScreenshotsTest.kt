package io.github.kahme247.ompweb.screenshot

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.kahme247.ompweb.net.ExtensionApi
import io.github.kahme247.ompweb.ui.panels.extension.ExtensionDialogHost
import io.github.kahme247.ompweb.ui.panels.extension.ExtensionUiController
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import org.junit.Test

/**
 * The attached extension `ask` dialog: two questions (single choice with a
 * recommended option, multi choice with a preview) and the Cancel/Submit row.
 * This is the widest dialog content the panel stack renders at 320 dp and
 * 200 % font.
 */
class ExtensionAskScreenshotsTest : ScreenshotTest() {

    @Test
    fun askDialog() {
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
                put("id", "ask-1")
                put("method", "ask")
                putJsonArray("questions") {
                    add(
                        buildJsonObject {
                            put("id", "q1")
                            put("header", "Target")
                            put("question", "Which layout should the screenshot matrix pin?")
                            put("multi", false)
                            put("recommended", 1)
                            putJsonArray("options") {
                                add(
                                    buildJsonObject {
                                        put("label", "Phone only")
                                        put("description", "320–411 dp")
                                    },
                                )
                                add(
                                    buildJsonObject {
                                        put("label", "All five widths")
                                        put("description", "320, 360, 411, 600, 840 dp")
                                    },
                                )
                            }
                        },
                    )
                    add(
                        buildJsonObject {
                            put("id", "q2")
                            put("header", "Checks")
                            put("question", "Which checks must run in the gate?")
                            put("multi", true)
                            putJsonArray("options") {
                                add(buildJsonObject { put("label", "Unit tests") })
                                add(buildJsonObject { put("label", "Lint") })
                                add(
                                    buildJsonObject {
                                        put("label", "Screenshot verify")
                                        put("preview", "./gradlew verifyScreenshots")
                                    },
                                )
                            }
                        },
                    )
                }
            },
        )
        composeRule.verifyScreenshotMatrix(name = "extension-ask", heightDp = 640) {
            Column(Modifier.fillMaxWidth().padding(8.dp)) {
                ExtensionDialogHost(controller)
            }
        }
    }
}
