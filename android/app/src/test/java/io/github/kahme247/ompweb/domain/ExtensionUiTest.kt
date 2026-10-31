package io.github.kahme247.ompweb.domain

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Port of the extension-dialog rules in `components/ExtensionDialog.tsx` and
 * `hooks/useAgentSession.ts`: the `ask` drafts/answers, the URL allowlist, the
 * frame parser and the replay/expiry bookkeeping.
 */
class ExtensionUiTest {

    private fun question(
        id: String = "q1",
        multi: Boolean = false,
        recommended: Int? = null,
        options: List<String> = listOf("A", "B"),
    ): AskQuestion = AskQuestion(
        id = id,
        question = "Pick",
        header = null,
        options = options.map { AskOption(it, null, null) },
        multi = multi,
        recommended = recommended,
    )

    private fun frame(method: String, vararg fields: Pair<String, kotlinx.serialization.json.JsonElement>): JsonObject =
        buildJsonObject {
            put("type", "extension_ui_request")
            put("method", method)
            put("id", "req-1")
            fields.forEach { (key, value) -> put(key, value) }
        }

    // ---------------------------------------------------------------- ask form

    @Test
    fun `single-select starts on its recommended option, multi-select starts empty`() {
        val single = question(recommended = 1)
        val multi = question(id = "q2", multi = true, recommended = 0)
        val form = initialAskForm(listOf(single, multi))
        assertEquals(listOf("B"), form.draftAt(0).selected)
        assertTrue(form.draftAt(1).selected.isEmpty())
    }

    @Test
    fun `single-select needs a choice or a non-empty Other, multi-select may stay empty`() {
        val single = question()
        val multi = question(id = "q2", multi = true)
        val questions = listOf(single, multi)
        assertFalse(AskForm(listOf(AskDraft(), AskDraft())).canSubmit(questions))

        var form = AskForm(listOf(AskDraft(), AskDraft())).toggleOption(questions, 0, "A")
        assertTrue(form.canSubmit(questions))

        form = AskForm(listOf(AskDraft(other = "   ", otherChosen = true), AskDraft()))
        assertFalse(form.canSubmit(questions))

        form = AskForm(listOf(AskDraft(other = "something", otherChosen = true), AskDraft()))
        assertTrue(form.canSubmit(questions))
    }

    @Test
    fun `typing Other clears a single-select choice but keeps multi-select choices`() {
        val single = question()
        val multi = question(id = "q2", multi = true)
        val questions = listOf(single, multi)

        var form = AskForm(listOf(AskDraft(selected = listOf("A")), AskDraft(selected = listOf("A"))))
        form = form.setOther(questions, 0, "custom")
        assertEquals(emptyList<String>(), form.draftAt(0).selected)
        assertTrue(form.draftAt(0).otherChosen)

        form = form.setOther(questions, 1, "custom")
        assertEquals(listOf("A"), form.draftAt(1).selected)
        assertTrue(form.draftAt(1).otherChosen)
    }

    @Test
    fun `clearing Other unchooses it so a blank answer never blocks Submit`() {
        val questions = listOf(question())
        var form = AskForm(listOf(AskDraft(other = "abc", otherChosen = true)))
        form = form.setOther(questions, 0, "   ")
        assertFalse(form.draftAt(0).otherChosen)
        assertFalse(form.canSubmit(questions))
    }

    @Test
    fun `choosing an option unchooses Other but keeps its text`() {
        val questions = listOf(question())
        var form = AskForm(listOf(AskDraft(other = "kept", otherChosen = true)))
        form = form.toggleOption(questions, 0, "B")
        assertEquals(listOf("B"), form.draftAt(0).selected)
        assertFalse(form.draftAt(0).otherChosen)
        assertEquals("kept", form.draftAt(0).other)
    }

    @Test
    fun `tapping back into kept Other text answers with it again`() {
        val questions = listOf(question())
        val form = AskForm(listOf(AskDraft(selected = listOf("A"), other = "kept")))
        val focused = form.focusOther(questions, 0)
        assertTrue(focused.draftAt(0).otherChosen)
        assertEquals(emptyList<String>(), focused.draftAt(0).selected)

        val blank = AskForm(listOf(AskDraft(other = "  ")))
        assertTrue(blank.focusOther(questions, 0).draftAt(0).otherChosen.not())
    }

    @Test
    fun `answers keep option ids, option order and only send a non-empty custom input`() {
        val single = question(recommended = 0)
        val multi = question(id = "q2", multi = true)
        val questions = listOf(single, multi)
        var form = initialAskForm(questions)
        form = form.toggleOption(questions, 1, "B")
        form = form.toggleOption(questions, 1, "A")
        form = form.setOther(questions, 0, "  free text  ")

        val answers = form.answers(questions)
        assertEquals(listOf("q1", "q2"), answers.map { it.id })
        assertEquals(emptyList<String>(), answers[0].selectedOptions)
        assertEquals("free text", answers[0].customInput)
        assertEquals(listOf("A", "B"), answers[1].selectedOptions)
        assertNull(answers[1].customInput)
    }

    // ------------------------------------------------------------ URL allowlist

    @Test
    fun `only http, https and mailto survive the open-url allowlist`() {
        assertTrue(isSafeOpenUrl("https://example.com/path?q=1"))
        assertTrue(isSafeOpenUrl("http://example.com"))
        assertTrue(isSafeOpenUrl("mailto:user@example.com"))
        assertTrue(isSafeOpenUrl("  HTTPS://EXAMPLE.COM  "))
        assertTrue(isSafeOpenUrl("HtTp://example.com"))

        assertFalse(isSafeOpenUrl(null))
        assertFalse(isSafeOpenUrl(""))
        assertFalse(isSafeOpenUrl("   "))
        assertFalse(isSafeOpenUrl("//example.com"))
        assertFalse(isSafeOpenUrl("javascript:alert(1)"))
        assertFalse(isSafeOpenUrl("data:text/html,<script>"))
        assertFalse(isSafeOpenUrl("file:///etc/passwd"))
        assertFalse(isSafeOpenUrl("vbscript:x"))
        assertFalse(isSafeOpenUrl("example.com"))
        assertFalse(isSafeOpenUrl("http//example.com"))
    }

    @Test
    fun `pi-web urls resolve to their resource`() {
        assertEquals("clipboard", hostUriResource("pi-web://clipboard"))
        assertEquals("clipboard", hostUriResource("PI-WEB://clipboard"))
        assertEquals("clipboard/extra", hostUriResource("pi-web://clipboard/extra"))
    }

    // ------------------------------------------------------------- frame parser

    @Test
    fun `select confirm input and editor frames parse their payload`() {
        val select = parseExtensionUiFrame(
            frame("select", "title" to JsonPrimitive("Pick one"), "options" to JsonArray(listOf(JsonPrimitive("A"), JsonPrimitive("B")))),
            10_000,
        ) as ExtensionUiFrame.Dialog
        val selectState = select.request as ExtensionDialogState.Select
        assertEquals("Pick one", selectState.title)
        assertEquals(listOf("A", "B"), selectState.options)
        assertNull(selectState.expiresAt)

        val confirm = parseExtensionUiFrame(
            frame("confirm", "title" to JsonPrimitive("Sure?"), "message" to JsonPrimitive("Do it")),
            10_000,
        ) as ExtensionUiFrame.Dialog
        assertEquals("Sure?", (confirm.request as ExtensionDialogState.Confirm).title)
        assertEquals("Do it", (confirm.request as ExtensionDialogState.Confirm).message)

        val input = parseExtensionUiFrame(
            frame("input", "title" to JsonPrimitive("Name"), "placeholder" to JsonPrimitive("type here")),
            10_000,
        ) as ExtensionUiFrame.Dialog
        assertEquals("type here", (input.request as ExtensionDialogState.Input).placeholder)

        val editor = parseExtensionUiFrame(
            frame(
                "editor",
                "title" to JsonPrimitive("Edit"),
                "prefill" to JsonPrimitive("old"),
                "promptStyle" to JsonPrimitive(true),
            ),
            10_000,
        ) as ExtensionUiFrame.Dialog
        val editorState = editor.request as ExtensionDialogState.Editor
        assertEquals("old", editorState.prefill)
        assertTrue(editorState.promptStyle)
    }

    @Test
    fun `ask frames parse questions, options and the recommended index`() {
        val askFrame = frame(
            "ask",
            "questions" to buildJsonArray {
                add(
                    buildJsonObject {
                        put("id", "q1")
                        put("question", "Which?")
                        put("header", "Choice")
                        put("multi", false)
                        put("recommended", 1)
                        put(
                            "options",
                            buildJsonArray {
                                add(buildJsonObject { put("label", "A") })
                                add(
                                    buildJsonObject {
                                        put("label", "B")
                                        put("description", "second")
                                        put("preview", "code()")
                                    },
                                )
                            },
                        )
                    },
                )
                add(
                    buildJsonObject {
                        put("id", "q2")
                        put("question", "More?")
                        put("multi", true)
                        put("recommended", 7)
                        put("options", buildJsonArray { add(buildJsonObject { put("label", "C") }) })
                    },
                )
            },
        )
        val dialog = (parseExtensionUiFrame(askFrame, 0) as ExtensionUiFrame.Dialog).request
        val ask = dialog as ExtensionDialogState.Ask
        assertEquals(2, ask.questions.size)
        assertEquals("Choice", ask.questions[0].header)
        assertEquals(1, ask.questions[0].recommended)
        assertEquals("second", ask.questions[0].options[1].description)
        assertEquals("code()", ask.questions[0].options[1].preview)
        assertTrue(ask.questions[1].multi)
        assertNull(ask.questions[1].recommended)
    }

    @Test
    fun `timeouts become absolute expiry from the frame time`() {
        val withTimeout = frame("input", "timeout" to JsonPrimitive(5_000))
        val state = (parseExtensionUiFrame(withTimeout, 1_000) as ExtensionUiFrame.Dialog).request
        assertEquals(6_000L, state.expiresAt ?: -1L)

        val absolute = frame("input", "expiresAt" to JsonPrimitive(42_000))
        val absoluteState = (parseExtensionUiFrame(absolute, 1_000) as ExtensionUiFrame.Dialog).request
        assertEquals(42_000L, absoluteState.expiresAt ?: -1L)
    }

    @Test
    fun `cancel only carries a target and unknown methods degrade to ignored`() {
        val cancel = parseExtensionUiFrame(frame("cancel", "targetId" to JsonPrimitive("req-9")), 0)
        assertEquals(ExtensionUiFrame.Cancel("req-9"), cancel)

        assertNull(parseExtensionUiFrame(buildJsonObject { put("type", "message_update") }, 0))
        assertEquals(ExtensionUiFrame.Ignored, parseExtensionUiFrame(frame("setTitle", "title" to JsonPrimitive("x")), 0))
        assertEquals(ExtensionUiFrame.Ignored, parseExtensionUiFrame(frame("cancel"), 0))
        assertEquals(
            ExtensionUiFrame.Ignored,
            parseExtensionUiFrame(
                buildJsonObject {
                    put("type", "extension_ui_request")
                    put("method", "select")
                },
                0,
            ),
        )
    }

    @Test
    fun `notify open_url status widget and custom frames match the web mapping`() {
        val notify = parseExtensionUiFrame(
            buildJsonObject {
                put("type", "extension_ui_request")
                put("method", "notify")
                put("message", "hello")
                put("notifyType", "warning")
            },
            0,
        )
        assertEquals(ExtensionUiFrame.Notify("hello", ExtensionNoticeLevel.Warning), notify)

        val openUrl = parseExtensionUiFrame(
            buildJsonObject {
                put("type", "extension_ui_request")
                put("method", "open_url")
                put("url", "https://example.com")
                put("launchUrl", "https://launch.example.com")
                put("instructions", "Sign in")
            },
            0,
        )
        assertEquals(ExtensionUiFrame.OpenUrl("https://launch.example.com", "Sign in"), openUrl)

        val status = parseExtensionUiFrame(
            buildJsonObject {
                put("type", "extension_ui_request")
                put("method", "setStatus")
                put("statusKey", "build")
                put("statusText", "running")
            },
            0,
        )
        assertEquals(ExtensionUiFrame.Status("build", "running"), status)

        val widget = parseExtensionUiFrame(
            buildJsonObject {
                put("type", "extension_ui_request")
                put("method", "setWidget")
                put("widgetKey", "w")
                put("widgetLines", JsonArray(listOf(JsonPrimitive("one"), JsonPrimitive("two"))))
                put("widgetPlacement", "belowEditor")
            },
            0,
        )
        assertEquals(
            ExtensionUiFrame.Widget("w", listOf("one", "two"), ExtensionWidgetPlacement.BelowEditor),
            widget,
        )

        val custom = parseExtensionUiFrame(
            buildJsonObject {
                put("type", "extension_ui_request")
                put("method", "custom")
                put("id", "term-1")
                put("lines", JsonArray(listOf(JsonPrimitive("\u001b[36mhi\u001b[0m"))))
            },
            0,
        )
        assertEquals(ExtensionUiFrame.Terminal("term-1", listOf("\u001b[36mhi\u001b[0m")), custom)

        val closed = parseExtensionUiFrame(
            buildJsonObject {
                put("type", "extension_ui_request")
                put("method", "custom")
                put("id", "term-1")
                put("closed", true)
            },
            0,
        )
        assertEquals(ExtensionUiFrame.TerminalClosed("term-1"), closed)
    }

    // ------------------------------------------------------- replay/dedupe state

    @Test
    fun `a replayed answered request never reopens and a replay of an open one replaces it`() {
        val state = ExtensionUiState()
        val select = ExtensionDialogState.Select("req-1", "Pick", listOf("A"))
        assertTrue(state.request(select))
        assertTrue(state.claimAnswer(select))
        assertNull(state.dialog)

        assertFalse(state.request(select))
        assertNull(state.dialog)
        assertFalse(state.claimAnswer(select))

        val other = ExtensionDialogState.Confirm("req-2", "Sure?", "Do it")
        assertTrue(state.request(other))
        assertTrue(state.request(other))
        assertEquals("req-2", state.dialog?.id)
    }

    @Test
    fun `a failed answer restores its dialog but never over a newer one`() {
        val state = ExtensionUiState()
        val first = ExtensionDialogState.Input("req-1", "Name", null)
        state.request(first)
        assertTrue(state.claimAnswer(first))
        assertTrue(state.restore(first, 0))
        assertEquals("req-1", state.dialog?.id)
        // The id is usable again: a replay shows it and the user may answer.
        assertTrue(state.request(first))

        // A newer question arrived while the failed answer was in flight: its
        // panel keeps the screen, and only the answered mark is dropped.
        assertTrue(state.claimAnswer(first))
        val second = ExtensionDialogState.Confirm("req-2", "Sure?", "Do it")
        assertTrue(state.request(second))
        assertFalse(state.restore(first, 0))
        assertEquals("req-2", state.dialog?.id)
        // req-1 is not burnt: its late replay may still reopen it.
        assertTrue(state.request(first))
    }

    @Test
    fun `a failed answer past its own deadline is not restored`() {
        val state = ExtensionUiState()
        val expired = ExtensionDialogState.Input("req-1", "Name", null, expiresAt = 5_000)
        state.request(expired)
        assertTrue(state.claimAnswer(expired))
        // The round trip outlasted the request's timeout: the server settled it
        // already, so its panel must stay gone (no dead card the user cannot
        // answer) and the stale id stays marked.
        assertFalse(state.restore(expired, 5_000))
        assertNull(state.dialog)
        assertFalse(state.restore(expired, 5_001))
        assertNull(state.dialog)
        assertFalse(state.request(expired))

        // One millisecond before the deadline it still comes back.
        val alive = ExtensionDialogState.Input("req-2", "Name", null, expiresAt = 5_000)
        state.request(alive)
        assertTrue(state.claimAnswer(alive))
        assertTrue(state.restore(alive, 4_999))
        assertEquals("req-2", state.dialog?.id)
    }

    @Test
    fun `a session switch drops the panels but remembers answered ids`() {
        val state = ExtensionUiState()
        state.request(ExtensionDialogState.Input("req-1", "Name", null))
        state.setStatus("build", "running")
        state.setWidget("w", listOf("x"), ExtensionWidgetPlacement.AboveEditor)
        state.setTerminal("term-1", listOf("line"))
        state.markAnswered("req-1")

        state.bindSession()
        assertNull(state.dialog)
        assertTrue(state.statusItems.isEmpty())
        assertTrue(state.widgets.isEmpty())
        assertNull(state.terminal)
        assertFalse(state.request(ExtensionDialogState.Input("req-1", "Name", null)))
    }

    @Test
    fun `reset drops the panels and the answered ids`() {
        val state = ExtensionUiState()
        val answered = ExtensionDialogState.Input("req-1", "Name", null)
        state.request(answered)
        state.setStatus("build", "running")
        state.setWidget("w", listOf("x"), ExtensionWidgetPlacement.AboveEditor)
        state.setTerminal("term-1", listOf("line"))
        state.claimAnswer(answered)
        // The id is burnt for a replay now, but not for the next signed-in user.
        assertFalse(state.request(answered))

        state.reset()
        assertNull(state.dialog)
        assertTrue(state.statusItems.isEmpty())
        assertTrue(state.widgets.isEmpty())
        assertNull(state.terminal)
        assertTrue("a replayed request is answerable again", state.request(answered))
        assertEquals("req-1", state.dialog?.id)
    }

    @Test
    fun `cancel clears only the matching dialog`() {
        val state = ExtensionUiState()
        state.request(ExtensionDialogState.Confirm("req-1", "Sure?", "Do it"))
        assertFalse(state.cancel("req-2"))
        assertEquals("req-1", state.dialog?.id)
        assertTrue(state.cancel("req-1"))
        assertNull(state.dialog)
    }

    @Test
    fun `an expired dialog is dropped and its replay ignored`() {
        val state = ExtensionUiState()
        state.request(ExtensionDialogState.Input("req-1", "Name", null, expiresAt = 5_000))
        assertFalse(state.expire(4_999))
        assertTrue(state.expire(5_000))
        assertNull(state.dialog)
        assertFalse(state.request(ExtensionDialogState.Input("req-1", "Name", null)))
    }

    @Test
    fun `status and widget entries replace by key and clear on empty text or null lines`() {
        val state = ExtensionUiState()
        state.setStatus("a", "one")
        state.setStatus("b", "two")
        state.setStatus("a", "three")
        assertEquals(listOf(ExtensionStatusItem("b", "two"), ExtensionStatusItem("a", "three")), state.statusItems)
        state.setStatus("a", null)
        assertEquals(listOf(ExtensionStatusItem("b", "two")), state.statusItems)

        state.setWidget("w", emptyList(), ExtensionWidgetPlacement.AboveEditor)
        assertEquals(1, state.widgets.size)
        state.setWidget("w", null, ExtensionWidgetPlacement.AboveEditor)
        assertTrue(state.widgets.isEmpty())
    }

    @Test
    fun `terminal frames replace and close only their own id`() {
        val state = ExtensionUiState()
        state.setTerminal("term-1", listOf("a"))
        state.setTerminal("term-1", listOf("b"))
        assertEquals(listOf("b"), state.terminal?.lines)
        assertFalse(state.closeTerminal("term-2"))
        assertTrue(state.closeTerminal("term-1"))
        assertNull(state.terminal)
    }

    // --------------------------------------------------------- response builders

    @Test
    fun `responses carry exactly one answer variant`() {
        val value = extensionResponseCommand(ExtensionResponse.Value("id-1", "A"))
        assertEquals("extension_ui_response", value["type"]?.jsonPrimitive?.content)
        assertEquals("id-1", value["id"]?.jsonPrimitive?.content)
        assertEquals("A", value["value"]?.jsonPrimitive?.content)
        assertFalse(value.containsKey("confirmed"))

        val confirmed = extensionResponseCommand(ExtensionResponse.Confirmed("id-2", true))
        assertEquals(true, confirmed["confirmed"]?.jsonPrimitive?.content?.toBoolean())

        val cancelled = extensionResponseCommand(ExtensionResponse.Cancelled("id-3"))
        assertEquals("true", cancelled["cancelled"]?.jsonPrimitive?.content)

        val answers = extensionResponseCommand(
            ExtensionResponse.Answers(
                "id-4",
                listOf(
                    AskAnswer("q1", listOf("A", "B"), "own"),
                    AskAnswer("q2", emptyList(), null),
                ),
            ),
        )
        val encoded = answers["answers"]!!.jsonArray.map { it.jsonObject }
        assertEquals(listOf("q1", "q2"), encoded.map { it["id"]?.jsonPrimitive?.content })
        assertEquals(
            listOf("A", "B"),
            encoded[0]["selectedOptions"]!!.jsonArray.map { it.jsonPrimitive.content },
        )
        assertEquals("own", encoded[0]["customInput"]?.jsonPrimitive?.content)
        assertFalse(encoded[1].containsKey("customInput"))
    }

    @Test
    fun `custom ui input carries id and raw data`() {
        val command = extensionInputCommand("term-1", JsonPrimitive("\u0003"))
        assertEquals("extension_ui_input", command["type"]?.jsonPrimitive?.content)
        assertEquals("term-1", command["id"]?.jsonPrimitive?.content)
        assertEquals("\u0003", command["data"]?.jsonPrimitive?.content)
    }

    @Test
    fun `terminal keys map like the web terminal-input table`() {
        assertEquals("\r", terminalKeyData("Enter", ctrl = false, alt = false, shift = false))
        assertEquals("\n", terminalKeyData("Enter", ctrl = false, alt = false, shift = true))
        assertEquals("\t", terminalKeyData("Tab", ctrl = false, alt = false, shift = false))
        assertEquals("\u001b[Z", terminalKeyData("Tab", ctrl = false, alt = false, shift = true))
        assertEquals("\u001b[A", terminalKeyData("ArrowUp", ctrl = false, alt = false, shift = false))
        assertEquals("\u001bb", terminalKeyData("ArrowLeft", ctrl = false, alt = true, shift = false))
        assertEquals("\u007f", terminalKeyData("Backspace", ctrl = false, alt = false, shift = false))
        assertEquals("\u001b", terminalKeyData("Escape", ctrl = false, alt = false, shift = false))
        assertEquals("\u0003", terminalKeyData("c", ctrl = true, alt = false, shift = false))
        assertEquals("\u001d", terminalKeyData("]", ctrl = true, alt = false, shift = false))
        assertEquals("\u001bx", terminalKeyData("x", ctrl = false, alt = true, shift = false))
        assertNull(terminalKeyData("v", ctrl = true, alt = false, shift = false))
        assertNull(terminalKeyData("a", ctrl = false, alt = false, shift = false))
        assertNull(terminalKeyData(" ", ctrl = false, alt = false, shift = false))
        assertNull(terminalKeyData("F5", ctrl = false, alt = false, shift = false))
    }

    @Test
    fun `unchecking a multi-select Other keeps its text`() {
        val questions = listOf(question(multi = true))
        var form = AskForm(listOf(AskDraft(selected = listOf("A"), other = "kept", otherChosen = true)))
        form = form.chooseOther(questions, 0, false)
        assertFalse(form.draftAt(0).otherChosen)
        assertEquals("kept", form.draftAt(0).other)
        assertEquals(listOf("A"), form.draftAt(0).selected)
    }
}
