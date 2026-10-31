package io.github.kahme247.ompweb.domain

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Mirror of `lib/notification-events.ts` and its web tests: prefs fallback,
 * text clipping, tag/channel mapping, dialog parsing, the action per dialog
 * shape, presence decisions and the running-count frame.
 */
class NotificationsTest {

    private fun json(value: String): JsonElement = Json.parseToJsonElement(value)

    private fun event(
        type: NotifyType,
        sessionId: String = "sess-1",
        sessionName: String? = "Fix the tests",
        detail: String? = null,
        dialog: NotifyDialog? = null,
        requestId: String? = null,
    ) = NotifyEvent(
        type = type,
        sessionId = sessionId,
        sessionName = sessionName,
        detail = detail,
        dialog = dialog,
        requestId = requestId,
    )

    private fun dialog(
        method: String,
        options: List<String> = emptyList(),
        questions: List<NotifyQuestion> = emptyList(),
        requestId: String = "req-1",
    ) = NotifyDialog(
        requestId = requestId,
        method = method,
        options = options,
        questions = questions,
    )

    // ----------------------------------------------------------------- prefs

    /** The reply label comes from a string resource; the plan must carry it verbatim. */
    private fun actions(event: NotifyEvent, replyLabel: String = "Reply"): NotifyActionPlan =
        notificationActions(event, replyLabel)

    @Test
    fun `native defaults are enabled with system while-active`() {
        val prefs = NotifyPrefs.DEFAULT
        assertTrue(prefs.enabled)
        assertTrue(prefs.completed)
        assertTrue(prefs.input)
        assertTrue(prefs.error)
        assertFalse(prefs.modelSwitch)
        assertEquals(NotifyWhenActive.System, prefs.whenActive)
        assertEquals("en", prefs.locale)
    }

    @Test
    fun `prefs parsing falls back field by field`() {
        val parsed = NotifyPrefs.parse(
            json(
                """{"enabled":"yes","types":{"completed":"false","input":true,"modelSwitch":true},
                   "whenActive":"bogus","locale":"not a locale!"}""",
            ),
        )
        assertFalse(parsed.enabled)
        assertTrue(parsed.completed)
        assertTrue(parsed.input)
        assertTrue(parsed.modelSwitch)
        assertTrue(parsed.error)
        assertEquals(NotifyWhenActive.System, parsed.whenActive)
        assertEquals("en", parsed.locale)
    }

    @Test
    fun `prefs parsing accepts the wire shape and survives a round trip`() {
        val prefs = NotifyPrefs(
            enabled = true,
            completed = false,
            input = true,
            error = false,
            modelSwitch = true,
            whenActive = NotifyWhenActive.Toast,
            locale = "de",
        )
        val parsed = NotifyPrefs.parse(json(prefs.toJson().toString()))
        assertEquals(prefs, parsed)
        val raw = prefs.toJson()
        assertEquals(false, (raw["types"] as JsonObject)["completed"]?.let { (it as JsonPrimitive).content }?.toBoolean())
        assertEquals("toast", (raw["whenActive"] as JsonPrimitive).content)
    }

    @Test
    fun `withType toggles exactly one preference`() {
        val next = NotifyPrefs.DEFAULT.withType(NotifyType.ModelSwitch, true)
        assertTrue(next.modelSwitch)
        assertTrue(next.completed)
        assertEquals(NotifyPrefs.DEFAULT.copy(modelSwitch = true), next)
    }

    // ---------------------------------------------------------- render/map

    @Test
    fun `type maps to its channel and tag`() {
        assertEquals(NotifyChannel.NeedsInput, NotifyType.Input.channel())
        assertEquals(NotifyChannel.Errors, NotifyType.Error.channel())
        assertEquals(NotifyChannel.Completed, NotifyType.Completed.channel())
        assertEquals(NotifyChannel.ModelSwitch, NotifyType.ModelSwitch.channel())
        assertEquals("sess-1:modelSwitch", event(NotifyType.ModelSwitch).tag)
    }

    @Test
    fun `completed and failed bodies match the web wording`() {
        val completed = renderNotification(event(NotifyType.Completed))
        assertEquals("Fix the tests", completed.title)
        assertEquals("Task finished.", completed.body)
        assertEquals(NotifyChannel.Completed, completed.channel)

        val failed = renderNotification(event(NotifyType.Error))
        assertEquals("Run failed.", failed.body)
        assertEquals("Run failed: exit 1", renderNotification(event(NotifyType.Error, detail = "exit 1")).body)

        val waiting = renderNotification(event(NotifyType.Input))
        assertEquals("Waiting for your answer.", waiting.body)
        assertEquals(
            "Waiting for your answer: pick one",
            renderNotification(event(NotifyType.Input, detail = "  pick\n one ")).body,
        )
    }

    @Test
    fun `model switch body has all three levels`() {
        val full = NotifyEvent(
            type = NotifyType.ModelSwitch,
            sessionId = "s",
            from = "a/one",
            to = "b/two",
            detail = "rate limit",
        )
        assertEquals("Switched a/one → b/two: rate limit", renderNotification(full).body)
        assertEquals(
            "Switched a/one → b/two.",
            renderNotification(full.copy(detail = null)).body,
        )
    }

    @Test
    fun `long detail and title are clipped`() {
        val longDetail = "x".repeat(500)
        val rendered = renderNotification(
            event(NotifyType.Error, sessionName = "T".repeat(300), detail = longDetail),
        )
        assertEquals(100, rendered.title.length)
        assertTrue(rendered.title.endsWith("…"))
        assertTrue(rendered.body.startsWith("Run failed: "))
        assertTrue(rendered.body.endsWith("…"))
        assertEquals(180, rendered.body.removePrefix("Run failed: ").length)
    }

    @Test
    fun `missing session name uses the web fallback`() {
        val rendered = renderNotification(event(NotifyType.Completed, sessionName = "  "))
        assertEquals("omp session", rendered.title)
    }

    @Test
    fun `test notification uses the agent message channel`() {
        val rendered = renderTestNotification("ompweb", "Test body")
        assertEquals("ompweb", rendered.title)
        assertEquals("Test body", rendered.body)
        assertEquals(NotifyChannel.AgentMessages, rendered.channel)
        assertEquals("ompweb:test", rendered.tag)
    }

    // ------------------------------------------------------------- parsing

    @Test
    fun `event parser keeps the dialog and request id`() {
        val parsed = parseNotifyEvent(
            json(
                """{"type":"input","sessionId":"s1","sessionName":"Name","detail":"why",
                   "dialog":{"requestId":"r1","method":"select","options":["A","B"]}}""",
            ),
        )
        requireNotNull(parsed)
        assertEquals(NotifyType.Input, parsed.type)
        assertEquals("s1", parsed.sessionId)
        assertEquals("Name", parsed.sessionName)
        assertEquals("r1", parsed.dialog?.requestId)
        assertEquals(listOf("A", "B"), parsed.dialog?.options)
        assertEquals("r1", parsed.answerRequestId)
    }

    @Test
    fun `event parser rejects unknown types and missing session`() {
        assertNull(parseNotifyEvent(json("""{"type":"bogus","sessionId":"s"}""")))
        assertNull(parseNotifyEvent(json("""{"type":"completed"}""")))
        assertNull(parseNotifyEvent(JsonPrimitive("text")))
    }

    @Test
    fun `dialog options must be strings`() {
        val parsed = parseNotifyDialog(
            json("""{"requestId":"r","method":"select","options":["A",2]}"""),
        )
        requireNotNull(parsed)
        assertTrue(parsed.options.isEmpty())
    }

    @Test
    fun `dialog parser reads ask metadata with web default for allowCustom`() {
        val parsed = parseNotifyDialog(
            json(
                """{"requestId":"r","method":"ask","questions":[
                     {"id":"q1","question":"Which?","options":["A"],"multi":true},
                     {"id":"q2","question":"Free?","allowCustom":false}]}""",
            ),
        )
        requireNotNull(parsed)
        assertEquals(2, parsed.questions.size)
        assertEquals(listOf("A"), parsed.questions[0].options)
        assertTrue(parsed.questions[0].allowCustom)
        assertFalse(parsed.questions[1].allowCustom)
    }

    @Test
    fun `dismiss parser requires all ids`() {
        assertEquals(
            NotifyDismiss("s:completed", "r"),
            parseNotifyDismiss(json("""{"tag":"s:completed","sessionId":"s","requestId":"r"}""")),
        )
        assertNull(parseNotifyDismiss(json("""{"tag":"s:completed","sessionId":"s"}""")))
    }

    // ------------------------------------------------------------- actions

    @Test
    fun `confirm dialog offers yes and no`() {
        val plan = actions(
            event(NotifyType.Input, dialog = dialog("confirm"), requestId = "r"),
        )
        assertEquals(listOf("Yes", "No"), plan.buttons.map { it.label })
        assertEquals(NotifyAnswer.Confirmed(true), plan.buttons[0].answer)
        assertEquals(NotifyAnswer.Confirmed(false), plan.buttons[1].answer)
        assertNull(plan.reply)
    }

    @Test
    fun `select dialog offers at most three option buttons`() {
        val one = actions(
            event(NotifyType.Input, dialog = dialog("select", options = listOf("Only")), requestId = "r"),
        )
        assertEquals(listOf("Only"), one.buttons.map { it.label })

        val three = actions(
            event(NotifyType.Input, dialog = dialog("select", options = listOf("A", "B", "C")), requestId = "r"),
        )
        assertEquals(listOf("A", "B", "C"), three.buttons.map { it.label })
        assertEquals(NotifyAnswer.Value("B"), three.buttons[1].answer)

        val four = actions(
            event(NotifyType.Input, dialog = dialog("select", options = listOf("A", "B", "C", "D")), requestId = "r"),
        )
        assertTrue(four.buttons.isEmpty())
        assertNull(four.reply)
    }

    @Test
    fun `input and editor shapes differ`() {
        val input = actions(
            event(NotifyType.Input, dialog = dialog("input"), requestId = "r"),
        )
        assertEquals(ReplyTarget.Input, input.reply?.target)
        val editor = actions(
            event(NotifyType.Input, dialog = dialog("editor"), requestId = "r"),
        )
        assertNull(editor.reply)
    }

    @Test
    fun `ask uses options, then free text, then nothing`() {
        val options = actions(
            event(
                NotifyType.Input,
                dialog = dialog(
                    "ask",
                    questions = listOf(NotifyQuestion("q1", options = listOf("A", "B", "C"))),
                ),
                requestId = "r",
            ),
        )
        assertEquals(listOf("A", "B", "C"), options.buttons.map { it.label })
        assertEquals(
            NotifyAnswer.Answers(listOf(AskAnswer("q1", listOf("B"), null))),
            options.buttons[1].answer,
        )

        val tooMany = actions(
            event(
                NotifyType.Input,
                dialog = dialog(
                    "ask",
                    questions = listOf(NotifyQuestion("q1", options = listOf("A", "B", "C", "D"))),
                ),
                requestId = "r",
            ),
        )
        assertTrue(tooMany.buttons.isEmpty())
        assertNull(tooMany.reply)

        val free = actions(
            event(
                NotifyType.Input,
                dialog = dialog("ask", questions = listOf(NotifyQuestion("q9"))),
                requestId = "r",
            ),
        )
        assertEquals(ReplyTarget.Ask("q9"), free.reply?.target)

        val noCustom = actions(
            event(
                NotifyType.Input,
                dialog = dialog(
                    "ask",
                    questions = listOf(NotifyQuestion("q9", allowCustom = false)),
                ),
                requestId = "r",
            ),
        )
        assertNull(noCustom.reply)
    }

    @Test
    fun `multiple ask questions offer no action`() {
        val plan = actions(
            event(
                NotifyType.Input,
                dialog = dialog(
                    "ask",
                    questions = listOf(
                        NotifyQuestion("q1"),
                        NotifyQuestion("q2"),
                    ),
                ),
                requestId = "r",
            ),
        )
        assertTrue(plan.buttons.isEmpty())
        assertNull(plan.reply)
    }

    @Test
    fun `completed replies as a follow up, errors do not`() {
        assertEquals(
            ReplyTarget.FollowUp,
            actions(event(NotifyType.Completed)).reply?.target,
        )
        assertNull(actions(event(NotifyType.Error)).reply)
        assertNull(actions(event(NotifyType.ModelSwitch)).reply)
    }

    @Test
    fun `the reply action carries the caller's label`() {
        val plan = notificationActions(event(NotifyType.Completed), "Antworten")
        assertEquals("Antworten", plan.reply?.label)
    }

    @Test
    fun `input without a request id offers nothing`() {
        val plan = actions(event(NotifyType.Input))
        assertTrue(plan.buttons.isEmpty())
        assertNull(plan.reply)
    }

    @Test
    fun `replyAnswer routes typed text`() {
        assertEquals(NotifyAnswer.Value("hi"), replyAnswer(ReplyTarget.Input, "hi"))
        assertEquals(
            NotifyAnswer.Answers(listOf(AskAnswer("q1", emptyList(), "hi"))),
            replyAnswer(ReplyTarget.Ask("q1"), "hi"),
        )
        assertNull(replyAnswer(ReplyTarget.FollowUp, "hi"))
    }

    @Test
    fun `button answer json round trips`() {
        assertEquals(NotifyAnswer.Value("A"), parseNotifyAnswer("""{"value":"A"}"""))
        assertEquals(NotifyAnswer.Confirmed(false), parseNotifyAnswer("""{"confirmed":false}"""))
        assertEquals(
            NotifyAnswer.Answers(
                listOf(AskAnswer("q1", listOf("A"), "custom")),
            ),
            parseNotifyAnswer("""{"answers":[{"id":"q1","selectedOptions":["A"],"customInput":"custom"}]}"""),
        )
    }

    @Test
    fun `button answer parser rejects malformed and mixed shapes`() {
        assertNull(parseNotifyAnswer(null))
        assertNull(parseNotifyAnswer("  "))
        assertNull(parseNotifyAnswer("not json"))
        assertNull(parseNotifyAnswer("""{"value":"A","confirmed":true}"""))
        assertNull(parseNotifyAnswer("""{"answers":[{"id":""}]}"""))
    }

    // ------------------------------------------------------------ presence

    @Test
    fun `presence requires foreground and a chat`() {
        assertEquals(PresenceVisibility(true, "s1"), resolvePresence(true, "s1"))
        assertEquals(PresenceVisibility(false, null), resolvePresence(false, "s1"))
        assertEquals(PresenceVisibility(false, null), resolvePresence(true, null))
        assertEquals(PresenceVisibility(false, null), resolvePresence(true, "  "))
    }

    @Test
    fun `presence seq grows even when the clock does not`() {
        assertEquals(1_000L, nextPresenceSeq(0, 1_000))
        assertEquals(1_001L, nextPresenceSeq(1_000, 1_000))
        assertEquals(1_001L, nextPresenceSeq(1_000, 900))
        assertEquals(2_000L, nextPresenceSeq(1_000, 2_000))
    }

    @Test
    fun `a visible chat needs the detail pane and no overlay`() {
        assertEquals(
            "s1",
            visibleChatSession("s1", detailPaneVisible = true, coveredByOverlay = false),
        )
        // Compact back keeps the selection but the list is on screen.
        assertNull(visibleChatSession("s1", detailPaneVisible = false, coveredByOverlay = false))
        // The notification panel covers the chat.
        assertNull(visibleChatSession("s1", detailPaneVisible = true, coveredByOverlay = true))
        assertNull(visibleChatSession("  ", detailPaneVisible = true, coveredByOverlay = false))
        assertNull(visibleChatSession(null, detailPaneVisible = true, coveredByOverlay = false))
    }

    @Test
    fun `presence follows the chat the detail pane actually shows`() {
        assertEquals(
            PresenceVisibility(false, null),
            resolvePresence(true, visibleChatSession("s1", detailPaneVisible = false, coveredByOverlay = false)),
        )
        assertEquals(
            PresenceVisibility(false, null),
            resolvePresence(true, visibleChatSession("s1", detailPaneVisible = true, coveredByOverlay = true)),
        )
        assertEquals(
            PresenceVisibility(true, "s1"),
            resolvePresence(true, visibleChatSession("s1", detailPaneVisible = true, coveredByOverlay = false)),
        )
    }

    @Test
    fun `runtime action changes nothing before the first snapshot`() {
        // A service the system just restarted must not be stopped by an empty snapshot.
        assertEquals(NotifyRuntimeAction.Idle, notificationRuntimeAction(false, true, true, true))
        assertEquals(NotifyRuntimeAction.Idle, notificationRuntimeAction(false, false, false, false))
    }

    @Test
    fun `runtime action starts only for a configured signed-in device with prefs on`() {
        assertEquals(NotifyRuntimeAction.Start, notificationRuntimeAction(true, true, true, true))
        assertEquals(NotifyRuntimeAction.Stop(syncDevice = false), notificationRuntimeAction(true, false, true, true))
        assertEquals(NotifyRuntimeAction.Stop(syncDevice = false), notificationRuntimeAction(true, true, true, false))
    }

    @Test
    fun `the master switch off still tells the configured server`() {
        // `enabled:false` has to reach the server, or it keeps routing this device.
        assertEquals(NotifyRuntimeAction.Stop(syncDevice = true), notificationRuntimeAction(true, true, false, true))
        // Without a server there is nothing to unregister.
        assertEquals(NotifyRuntimeAction.Stop(syncDevice = false), notificationRuntimeAction(true, false, false, false))
    }

    // -------------------------------------------------------------- replies

    @Test
    fun `reply text is trimmed, blank-rejected and capped`() {
        assertEquals("hi", sanitizeReplyText("  hi\n"))
        assertNull(sanitizeReplyText(null))
        assertNull(sanitizeReplyText(""))
        assertNull(sanitizeReplyText(" \n\t "))
        val capped = sanitizeReplyText("x".repeat(MAX_REPLY_LENGTH + 500))
        assertEquals(MAX_REPLY_LENGTH, capped?.length)
    }

    // -------------------------------------------------------------- frames

    @Test
    fun `running frame count is the id list size`() {
        val frame = buildJsonObject {
            put(
                "runningSessionIds",
                JsonArray(listOf(JsonPrimitive("a"), JsonPrimitive("b"))),
            )
        }.jsonObject
        assertEquals(2, runningSessionCount(frame))
        assertNull(runningSessionCount(buildJsonObject { }.jsonObject))
    }

    @Test
    fun `generated ids satisfy the server pattern`() {
        val id = randomNotificationId()
        assertTrue(isValidNotificationId(id))
        assertEquals(32, id.length)
        assertFalse(isValidNotificationId("short"))
        assertFalse(isValidNotificationId("bad id with spaces"))
        assertFalse(isValidNotificationId(null))
    }

    // ---------------------------------------------------------- comfort

    @Test
    fun `vibration is one short pulse, a double pulse and one long pulse`() {
        assertTrue(
            "completed must be a single short pulse",
            NotifyType.Completed.vibrationPattern()!!.contentEquals(longArrayOf(0, 120)),
        )
        assertTrue(
            "input must be a double pulse",
            NotifyType.Input.vibrationPattern()!!.contentEquals(longArrayOf(0, 120, 120, 120)),
        )
        assertTrue(
            "error must be one long pulse",
            NotifyType.Error.vibrationPattern()!!.contentEquals(longArrayOf(0, 600)),
        )
        assertNull("model switches are informational only", NotifyType.ModelSwitch.vibrationPattern())
        assertNull(NotifyChannel.ModelSwitch.vibrationPattern())
        assertNull(NotifyChannel.ConnectionStatus.vibrationPattern())
        assertNull(NotifyChannel.AgentMessages.vibrationPattern())
    }

    @Test
    fun `event channels have a vibrating and a quiet twin`() {
        assertTrue(NotifyChannel.NeedsInput.supportsVibration)
        assertEquals("needs_input_v2", NotifyChannel.NeedsInput.vibratingId)
        assertEquals("needs_input_quiet", NotifyChannel.NeedsInput.quietId)
        assertEquals("needs_input_v2", NotifyChannel.NeedsInput.androidChannelId(vibrate = true))
        assertEquals("needs_input_quiet", NotifyChannel.NeedsInput.androidChannelId(vibrate = false))

        // The silent channels keep one stable id, whatever the setting says.
        assertFalse(NotifyChannel.ConnectionStatus.supportsVibration)
        assertEquals("connection_status", NotifyChannel.ConnectionStatus.androidChannelId(vibrate = true))
        assertEquals("agent_messages", NotifyChannel.AgentMessages.androidChannelId(vibrate = false))
    }

    @Test
    fun `stored channel ids map back to their event channel`() {
        assertEquals(NotifyChannel.Errors, notifyChannelFor("errors"))
        assertEquals(NotifyChannel.Errors, notifyChannelFor("errors_v2"))
        assertEquals(NotifyChannel.Errors, notifyChannelFor("errors_quiet"))
        assertEquals(NotifyChannel.Completed, notifyChannelFor("completed_quiet"))
        assertNull(notifyChannelFor("bogus"))
        assertNull(notifyChannelFor(null))
    }

    @Test
    fun `a project is keyed by its canonical root and labelled by its last segment`() {
        assertEquals(
            "windows paths compare case-insensitively",
            NotifyProject("c:/users/me/desktop/ompweb", "ompweb"),
            notifyProject("C:\\Users\\me\\Desktop\\ompweb"),
        )
        assertEquals(
            "a trailing separator does not split a group",
            NotifyProject("/home/me/ompweb", "ompweb"),
            notifyProject("/home/me/ompweb/"),
        )
        assertEquals(
            "posix paths keep their case",
            NotifyProject("/Home/Me/OmpWeb", "OmpWeb"),
            notifyProject("/Home/Me/OmpWeb"),
        )
        assertNull("without a path there is no group", notifyProject(null))
        assertNull(notifyProject("   "))
    }

    @Test
    fun `vibrate defaults on and survives the prefs round trip`() {
        assertTrue(NotifyPrefs.DEFAULT.vibrate)
        val prefs = NotifyPrefs.DEFAULT.copy(vibrate = false)
        assertEquals(false, NotifyPrefs.parse(json(prefs.toJson().toString())).vibrate)
        assertEquals(false, prefs.toJson()["vibrate"]?.let { (it as JsonPrimitive).content }?.toBoolean())
        // A stringly-typed or missing value falls back to the default (on).
        assertEquals(true, NotifyPrefs.parse(json("""{"vibrate":"false"}""")).vibrate)
        assertEquals(true, NotifyPrefs.parse(json("{}")).vibrate)
    }
}
