package io.github.kahme247.ompweb.domain

import java.security.SecureRandom
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

/**
 * Notification domain shared by the foreground service, the renderer and the
 * settings screen. Pure: no Android types, so every decision (prefs parsing,
 * tag/channel mapping, action selection per dialog shape, presence) is
 * unit-tested on the JVM exactly like `lib/notification-events.ts`.
 */

/** The four event types the server publishes (`NOTIFICATION_TYPES`). */
enum class NotifyType(val wire: String) {
    Completed("completed"),
    Input("input"),
    Error("error"),
    ModelSwitch("modelSwitch"),
    ;

    companion object {
        fun fromWire(value: String?): NotifyType? = entries.firstOrNull { it.wire == value }
    }
}

/** Android notification channels; ids are stable, the renderer maps them to resources. */
enum class NotifyChannel(val id: String) {
    NeedsInput("needs_input"),
    Errors("errors"),
    Completed("completed"),
    ModelSwitch("model_switch"),
    ConnectionStatus("connection_status"),
    AgentMessages("agent_messages"),
}

/** Channel a live event belongs to (PLAN §4 "Inhalt und Aktionen"). */
fun NotifyType.channel(): NotifyChannel = when (this) {
    NotifyType.Completed -> NotifyChannel.Completed
    NotifyType.Input -> NotifyChannel.NeedsInput
    NotifyType.Error -> NotifyChannel.Errors
    NotifyType.ModelSwitch -> NotifyChannel.ModelSwitch
}

/** One pulse of the completed event, and of each half of the input double pulse. */
private const val VIBRATION_SHORT_PULSE = 120L

/** Silence between the two pulses of the input event. */
private const val VIBRATION_GAP = 120L

/** One long pulse of the error event. */
private const val VIBRATION_LONG_PULSE = 600L

/**
 * The user's per-event vibration waveform, in the shape
 * `NotificationChannel.vibrationPattern` (and `VibrationEffect.createWaveform`)
 * expects: delay, pulse, pause, pulse, … in milliseconds.
 *
 * Completed = one short pulse, input = a double pulse, error = one long pulse.
 * A model switch is informational and stays silent. Sending a prompt, answering
 * a dialog and the "Sent"/"Failed" result updates never vibrate.
 */
fun NotifyType.vibrationPattern(): LongArray? = when (this) {
    NotifyType.Completed -> longArrayOf(0, VIBRATION_SHORT_PULSE)
    NotifyType.Input -> longArrayOf(0, VIBRATION_SHORT_PULSE, VIBRATION_GAP, VIBRATION_SHORT_PULSE)
    NotifyType.Error -> longArrayOf(0, VIBRATION_LONG_PULSE)
    NotifyType.ModelSwitch -> null
}

/** The waveform a channel's notifications use, or null for the silent channels. */
fun NotifyChannel.vibrationPattern(): LongArray? = when (this) {
    NotifyChannel.NeedsInput -> NotifyType.Input.vibrationPattern()
    NotifyChannel.Errors -> NotifyType.Error.vibrationPattern()
    NotifyChannel.Completed -> NotifyType.Completed.vibrationPattern()
    NotifyChannel.ModelSwitch, NotifyChannel.ConnectionStatus, NotifyChannel.AgentMessages -> null
}

/** Whether the channel has a vibration twin; the other channels keep one stable id. */
val NotifyChannel.supportsVibration: Boolean get() = vibrationPattern() != null

/**
 * Channel ids are immutable after the first creation, so a channel that must
 * vibrate has its own twin id: the legacy (pre-1.0.2) channel ids could never
 * gain a pattern. The `_v2` twin vibrates, the `_quiet` twin never does (the
 * in-app "Vibrate" setting turned off, and the answer-result update).
 */
val NotifyChannel.vibratingId: String get() = if (supportsVibration) "${id}_v2" else id

val NotifyChannel.quietId: String get() = if (supportsVibration) "${id}_quiet" else id

/** The channel id one post uses: the vibrating twin or its quiet twin. */
fun NotifyChannel.androidChannelId(vibrate: Boolean): String = when {
    !supportsVibration -> id
    vibrate -> vibratingId
    else -> quietId
}

/**
 * Maps a stored channel id back to its event channel: the logical id, the
 * `_v2`/`_quiet` twins and the pre-1.0.2 legacy ids all name the same channel.
 */
fun notifyChannelFor(channelId: String?): NotifyChannel? {
    val value = channelId?.takeIf { it.isNotBlank() } ?: return null
    return NotifyChannel.entries.firstOrNull {
        value == it.id || value == it.vibratingId || value == it.quietId
    }
}

/**
 * The project a session's notifications are grouped under on Android. [key] is
 * the canonical project root (worktrees collapse into their repository), [label]
 * is what the group summary calls it ("3 sessions in ompwebandroid").
 */
data class NotifyProject(val key: String, val label: String)

/**
 * Group identity for a session's cwd/project root, or null when the server did
 * not tell us where the session lives (the notification then stays ungrouped
 * instead of landing in a made-up group).
 */
fun notifyProject(path: String?): NotifyProject? {
    val value = path?.takeIf { it.isNotBlank() } ?: return null
    val key = comparableProjectPath(value)
    if (key.isEmpty()) return null
    return NotifyProject(key = key, label = projectPathLabel(value).ifBlank { key })
}

/** `whenActive` wire values from `NotificationPrefs`. */
enum class NotifyWhenActive(val wire: String) {
    Toast("toast"),
    System("system"),
    ;

    companion object {
        /** Missing or unknown values fall back to the native default, not the web toast. */
        fun fromWire(value: String?): NotifyWhenActive =
            if (value == Toast.wire) Toast else System
    }
}

/**
 * Per-device prefs (`omp-notify-prefs`). Native defaults follow PLAN §4:
 * notifications on, completed/input/error on, model switch off, system
 * notifications while active elsewhere, English. [vibrate] is this device's
 * own output choice; the server ignores the extra field.
 */
data class NotifyPrefs(
    val enabled: Boolean = DEFAULT_ENABLED,
    val completed: Boolean = true,
    val input: Boolean = true,
    val error: Boolean = true,
    val modelSwitch: Boolean = false,
    val whenActive: NotifyWhenActive = NotifyWhenActive.System,
    val locale: String = "en",
    val vibrate: Boolean = true,
) {
    fun isEnabled(type: NotifyType): Boolean = when (type) {
        NotifyType.Completed -> completed
        NotifyType.Input -> input
        NotifyType.Error -> error
        NotifyType.ModelSwitch -> modelSwitch
    }

    fun withType(type: NotifyType, enabled: Boolean): NotifyPrefs = when (type) {
        NotifyType.Completed -> copy(completed = enabled)
        NotifyType.Input -> copy(input = enabled)
        NotifyType.Error -> copy(error = enabled)
        NotifyType.ModelSwitch -> copy(modelSwitch = enabled)
    }

    fun toJson(): JsonObject = buildJsonObject {
        put("enabled", enabled)
        put(
            "types",
            buildJsonObject {
                put("completed", completed)
                put("input", input)
                put("error", error)
                put("modelSwitch", modelSwitch)
            },
        )
        put("whenActive", whenActive.wire)
        put("locale", locale)
        put("vibrate", vibrate)
    }

    companion object {
        /** PLAN §4 registration defaults, not the browser's opt-in default. */
        const val DEFAULT_ENABLED = true

        val DEFAULT = NotifyPrefs()

        /** Field-by-field fallback, mirroring `parseNotificationPrefs`. */
        fun parse(value: JsonElement?): NotifyPrefs {
            val root = value as? JsonObject ?: return DEFAULT
            val types = root["types"] as? JsonObject
            return NotifyPrefs(
                enabled = (root["enabled"] as? JsonPrimitive)?.contentOrNull?.toBooleanStrictOrNull() == true,
                completed = types?.bool("completed") ?: DEFAULT.completed,
                input = types?.bool("input") ?: DEFAULT.input,
                error = types?.bool("error") ?: DEFAULT.error,
                modelSwitch = types?.bool("modelSwitch") ?: DEFAULT.modelSwitch,
                whenActive = NotifyWhenActive.fromWire(root.string("whenActive")),
                locale = root.string("locale")
                    ?.takeIf { LOCALE_PATTERN.matches(it) }
                    ?: DEFAULT.locale,
                vibrate = root.bool("vibrate") ?: DEFAULT.vibrate,
            )
        }
    }
}

private val LOCALE_PATTERN = Regex("^[A-Za-z-]{2,10}$")

/** One question of an `ask` dialog, reduced to what a notification can answer. */
data class NotifyQuestion(
    val id: String,
    val options: List<String> = emptyList(),
    val allowCustom: Boolean = true,
)

/** The blocking extension dialog behind an `input` event. */
data class NotifyDialog(
    val requestId: String,
    val method: String,
    val options: List<String> = emptyList(),
    val questions: List<NotifyQuestion> = emptyList(),
)

/** `sessionName` is null when the server could not read the header. */
data class NotifyEvent(
    val type: NotifyType,
    val sessionId: String,
    val sessionName: String? = null,
    val detail: String? = null,
    val from: String? = null,
    val to: String? = null,
    val requestId: String? = null,
    val dialog: NotifyDialog? = null,
) {
    /** `<sessionId>:<type>` replaces an older notification of the same session/kind. */
    val tag: String get() = "$sessionId:${type.wire}"

    /** The id an answer must echo; the event carries it even without a dialog. */
    val answerRequestId: String? get() = requestId ?: dialog?.requestId
}

/** `notification-dismiss` frame of the `notifications` channel. */
data class NotifyDismiss(val tag: String, val requestId: String)

/** A rendered notification, ready for `NotificationCompat`. */
data class RenderedNotification(
    val title: String,
    val body: String,
    val tag: String,
    val channel: NotifyChannel,
)

/** Title, body, tag and channel for one event; text matches `renderNotification`. */
fun renderNotification(event: NotifyEvent): RenderedNotification {
    val detail = event.detail?.takeIf { it.isNotBlank() }?.let { clipNotificationText(it) }
    val body = when (event.type) {
        NotifyType.Completed -> "Task finished."
        NotifyType.Input -> detail?.let { "Waiting for your answer: $it" } ?: "Waiting for your answer."
        NotifyType.Error -> detail?.let { "Run failed: $it" } ?: "Run failed."
        NotifyType.ModelSwitch -> when {
            event.from != null && event.to != null && detail != null -> "Switched ${event.from} → ${event.to}: $detail"
            event.from != null && event.to != null -> "Switched ${event.from} → ${event.to}."
            else -> detail.orEmpty()
        }
    }
    val title = event.sessionName?.takeIf { it.isNotBlank() }
        ?.let { clipNotificationText(it, NOTIFICATION_TITLE_MAX) } ?: "omp session"
    return RenderedNotification(title = title, body = body, tag = event.tag, channel = event.type.channel())
}

/** The settings "Send test notification" entry rendered locally. */
fun renderTestNotification(title: String, body: String): RenderedNotification = RenderedNotification(
    title = title,
    body = body,
    tag = "ompweb:test",
    channel = NotifyChannel.AgentMessages,
)

/**
 * Where one live `notification` frame goes (web `useNotifications.deliver`):
 * `os` posts a system notification, `toast` stays inside the app, and an
 * unknown kind is ignored.
 */
enum class NoticeRoute { None, System, InApp }

fun noticeRoute(kind: String?): NoticeRoute = when (kind) {
    "os" -> NoticeRoute.System
    "toast" -> NoticeRoute.InApp
    else -> NoticeRoute.None
}

/**
 * A refused system post (permission withdrawn, channel blocked, service gone)
 * must still reach the user: the web falls back to its in-app toast, so the
 * native app falls back to an in-app notice instead of dropping the event.
 */
fun noticeRouteAfterPost(route: NoticeRoute, posted: Boolean): NoticeRoute =
    if (route == NoticeRoute.System && !posted) NoticeRoute.InApp else route

/**
 * An in-app delivery shown in the shell (web toast). It carries the session
 * and the history id so a tap can open the session and mark that entry read.
 * [requestId] is the dialog request the notice stands for; a dismiss frame
 * closes only that request and never a newer one of the same tag.
 */
data class InAppNotice(
    val id: String,
    val sessionId: String,
    val title: String,
    val body: String,
    val error: Boolean,
    val requestId: String?,
) {
    /** Newest first, one notice per `tag` (= [id]), like the web's toast ids. */
    fun addTo(current: List<InAppNotice>, limit: Int): List<InAppNotice> =
        (listOf(this) + current.filterNot { it.id == id }).take(limit)

    /** True when [tag]/[requestId] of a dismiss frame names this notice. */
    fun matches(tag: String, requestId: String): Boolean = id == tag && this.requestId == requestId
}

fun inAppNotice(event: NotifyEvent): InAppNotice {
    val rendered = renderNotification(event)
    return InAppNotice(
        id = rendered.tag,
        sessionId = event.sessionId,
        title = rendered.title,
        body = rendered.body,
        error = event.type == NotifyType.Error,
        requestId = event.answerRequestId,
    )
}

/** One answer value accepted by `POST /api/notifications/answer`. */
sealed interface NotifyAnswer {
    fun toJson(): JsonObject

    data class Value(val value: String) : NotifyAnswer {
        override fun toJson(): JsonObject = buildJsonObject { put("value", value) }
    }

    data class Confirmed(val confirmed: Boolean) : NotifyAnswer {
        override fun toJson(): JsonObject = buildJsonObject { put("confirmed", confirmed) }
    }

    data class Answers(val answers: List<AskAnswer>) : NotifyAnswer {
        override fun toJson(): JsonObject = buildJsonObject {
            put("answers", buildJsonArray { answers.forEach { add(it.toJson()) } })
        }
    }
}

/** Parses the pre-built answer a notification button carries (one variant, nothing else). */
fun parseNotifyAnswer(json: String?): NotifyAnswer? {
    if (json.isNullOrBlank()) return null
    val root = try {
        Json.parseToJsonElement(json) as? JsonObject
    } catch (_: Exception) {
        null
    } ?: return null
    val keys = root.keys
    if (keys.size != 1) return null
    return when (keys.first()) {
        "value" -> root.string("value")?.let { NotifyAnswer.Value(it) }
        "confirmed" -> root.bool("confirmed")?.let { NotifyAnswer.Confirmed(it) }
        "answers" -> {
            val entries = root["answers"] as? JsonArray ?: return null
            if (entries.isEmpty()) return null
            val answers = entries.map { entry ->
                val answer = entry as? JsonObject ?: return null
                val id = answer.string("id")?.takeIf { it.isNotEmpty() } ?: return null
                AskAnswer(
                    id = id,
                    selectedOptions = answer.stringList("selectedOptions"),
                    customInput = answer.string("customInput"),
                )
            }
            NotifyAnswer.Answers(answers)
        }
        else -> null
    }
}

/** Wire form of a per-question answer (`RpcAskDialogAnswer`). */
private fun AskAnswer.toJson(): JsonObject = buildJsonObject {
    put("id", id)
    put("selectedOptions", buildJsonArray { selectedOptions.forEach { add(JsonPrimitive(it)) } })
    customInput?.let { put("customInput", it) }
}

/** A notification action button (Yes/No or one dialog option). */
data class NotifyActionButton(val label: String, val answer: NotifyAnswer)

/** Where typed notification text goes. */
sealed interface ReplyTarget {
    /** `input` dialog: `{value}`. */
    data object Input : ReplyTarget

    /** One `ask` question without options: `{answers:[{id, selectedOptions:[], customInput}]}`. */
    data class Ask(val questionId: String) : ReplyTarget

    /** Completed event: a regular follow-up prompt through `POST /api/agent/{id}`. */
    data object FollowUp : ReplyTarget
}

data class NotifyReplyAction(val target: ReplyTarget, val label: String)

/**
 * What a notification offers; tapping it always opens the session.
 *
 * PLAN §4: confirm → Yes/No, select and single-question ask with ≤3 options →
 * option buttons, input / free-text ask → Reply, completed → Reply, everything
 * else only Open. Android allows at most three actions, so a fourth choice or
 * a second ask question omits the actions entirely instead of dropping one.
 */
data class NotifyActionPlan(
    val buttons: List<NotifyActionButton> = emptyList(),
    val reply: NotifyReplyAction? = null,
)

private const val MAX_ACTION_OPTIONS = 3

fun notificationActions(event: NotifyEvent, replyLabel: String): NotifyActionPlan = when (event.type) {
    NotifyType.Completed ->
        if (event.sessionId.isNotBlank()) {
            NotifyActionPlan(reply = NotifyReplyAction(ReplyTarget.FollowUp, replyLabel))
        } else {
            NotifyActionPlan()
        }

    NotifyType.Error, NotifyType.ModelSwitch -> NotifyActionPlan()

    NotifyType.Input -> {
        val dialog = event.dialog
        if (dialog == null || event.answerRequestId == null) {
            NotifyActionPlan()
        } else {
            when (dialog.method) {
                "confirm" -> NotifyActionPlan(
                    buttons = listOf(
                        NotifyActionButton("Yes", NotifyAnswer.Confirmed(true)),
                        NotifyActionButton("No", NotifyAnswer.Confirmed(false)),
                    ),
                )
                "select" -> NotifyActionPlan(
                    buttons = dialog.options
                        .takeIf { it.size in 1..MAX_ACTION_OPTIONS }
                        ?.map { NotifyActionButton(it, NotifyAnswer.Value(it)) }
                        .orEmpty(),
                )
                "input" -> NotifyActionPlan(reply = NotifyReplyAction(ReplyTarget.Input, replyLabel))
                "ask" -> askActions(dialog, replyLabel)
                // `editor` needs the full editor; `open_url` never carries a dialog.
                else -> NotifyActionPlan()
            }
        }
    }
}

private fun askActions(dialog: NotifyDialog, replyLabel: String): NotifyActionPlan {
    val question = dialog.questions.singleOrNull() ?: return NotifyActionPlan()
    if (question.options.isNotEmpty()) {
        if (question.options.size > MAX_ACTION_OPTIONS) return NotifyActionPlan()
        return NotifyActionPlan(
            buttons = question.options.map { option ->
                NotifyActionButton(
                    option,
                    NotifyAnswer.Answers(listOf(AskAnswer(question.id, listOf(option), null))),
                )
            },
        )
    }
    // An ask option "Other" is free text for exactly this question.
    return if (question.allowCustom) {
        NotifyActionPlan(reply = NotifyReplyAction(ReplyTarget.Ask(question.id), replyLabel))
    } else {
        NotifyActionPlan()
    }
}

/** Response for typed text, or null when the text belongs to an agent prompt. */
fun replyAnswer(target: ReplyTarget, text: String): NotifyAnswer? = when (target) {
    ReplyTarget.Input -> NotifyAnswer.Value(text)
    is ReplyTarget.Ask -> NotifyAnswer.Answers(listOf(AskAnswer(target.questionId, emptyList(), text)))
    ReplyTarget.FollowUp -> null
}

/** A reply typed on the lock screen is untrusted: cap it like a prompt would be. */
const val MAX_REPLY_LENGTH = 4_000

/**
 * The Reply text of a notification action: trimmed, blank rejected, capped to
 * [MAX_REPLY_LENGTH] characters (a reply is copied into a prompt/answer, so an
 * unbounded paste would bloat the request and the agent's context).
 */
fun sanitizeReplyText(raw: CharSequence?): String? =
    raw?.toString()
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
        ?.let { if (it.length > MAX_REPLY_LENGTH) it.take(MAX_REPLY_LENGTH) else it }

/** `{clientId, deviceId, visible, sessionId, seq}` of `POST /api/notifications/presence`. */
data class PresenceReport(
    val clientId: String,
    val deviceId: String,
    val visible: Boolean,
    val sessionId: String?,
    val seq: Long,
)

/** The app is visible only while it is in the foreground and a chat is on screen. */
data class PresenceVisibility(val visible: Boolean, val sessionId: String?)

/**
 * The chat the user is actually looking at. The selection alone is not
 * enough: on a phone "back to the list" keeps the selected session while the
 * detail pane is gone, and an open overlay covers the chat.
 */
fun visibleChatSession(
    selectedSessionId: String?,
    detailPaneVisible: Boolean,
    coveredByOverlay: Boolean,
): String? = selectedSessionId?.takeIf { it.isNotBlank() && detailPaneVisible && !coveredByOverlay }

fun resolvePresence(foreground: Boolean, visibleSessionId: String?): PresenceVisibility =
    if (foreground && !visibleSessionId.isNullOrBlank()) {
        PresenceVisibility(visible = true, sessionId = visibleSessionId)
    } else {
        PresenceVisibility(visible = false, sessionId = null)
    }

/** What one settings snapshot means for the foreground service and the registration. */
sealed interface NotifyRuntimeAction {
    /** The first DataStore emission has not arrived; decide nothing (never stop a restart). */
    data object Idle : NotifyRuntimeAction

    /** Start the service and send the current prefs. */
    data object Start : NotifyRuntimeAction

    /**
     * Stop the service. [syncDevice] is true when a server is configured and
     * signed in, so the master switch being off reaches the server too.
     */
    data class Stop(val syncDevice: Boolean) : NotifyRuntimeAction
}

/**
 * The single decision point for the service: enabled + signed in + an origin
 * starts it; everything else stops it. An unloaded snapshot must not stop a
 * service the system just restarted, and a configured server must still learn
 * about `enabled:false` (otherwise it keeps routing to this device).
 */
fun notificationRuntimeAction(
    loaded: Boolean,
    hasOrigin: Boolean,
    enabled: Boolean,
    signedIn: Boolean,
): NotifyRuntimeAction = when {
    !loaded -> NotifyRuntimeAction.Idle
    hasOrigin && enabled && signedIn -> NotifyRuntimeAction.Start
    else -> NotifyRuntimeAction.Stop(syncDevice = hasOrigin && signedIn)
}

private val NOTIFICATION_ID_PATTERN = Regex("^[A-Za-z0-9_-]{8,64}$")

/** Client and device ids the server accepts (`isValidNotificationId`). */
fun isValidNotificationId(value: String?): Boolean = value != null && NOTIFICATION_ID_PATTERN.matches(value)

private val random = SecureRandom()

/** A fresh server-accepted id (24 random bytes, base64url without padding). */
fun randomNotificationId(): String {
    val bytes = ByteArray(24).also(random::nextBytes)
    return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
}

/** `PUT /api/notifications/devices` identity. */
data class NotifyIdentity(val deviceId: String, val clientId: String)

/** Parses one `notification` frame's `event`; null for unknown/malformed frames. */
fun parseNotifyEvent(value: JsonElement?): NotifyEvent? {
    val root = value as? JsonObject ?: return null
    val type = NotifyType.fromWire(root.string("type")) ?: return null
    val sessionId = root.string("sessionId") ?: return null
    val dialog = parseNotifyDialog(root["dialog"])
    return NotifyEvent(
        type = type,
        sessionId = sessionId,
        sessionName = root.string("sessionName"),
        detail = root.string("detail"),
        from = root.string("from"),
        to = root.string("to"),
        requestId = root.string("requestId")?.takeIf { it.isNotEmpty() },
        dialog = dialog,
    )
}

fun parseNotifyDialog(value: JsonElement?): NotifyDialog? {
    val root = value as? JsonObject ?: return null
    val requestId = root.string("requestId")?.takeIf { it.isNotEmpty() } ?: return null
    val method = root.string("method")?.takeIf { it.isNotEmpty() } ?: return null
    val options = root.stringList("options", strict = true)
    val questions = (root["questions"] as? JsonArray)?.mapNotNull { parseNotifyQuestion(it) }.orEmpty()
    return NotifyDialog(
        requestId = requestId,
        method = method,
        options = options,
        questions = questions,
    )
}

private fun parseNotifyQuestion(value: JsonElement): NotifyQuestion? {
    val root = value as? JsonObject ?: return null
    val id = root.string("id")?.takeIf { it.isNotEmpty() } ?: return null
    return NotifyQuestion(
        id = id,
        options = root.stringList("options", strict = true),
        // The server sends `allowCustom: true` unless omp forbids "Other".
        allowCustom = root.bool("allowCustom") != false,
    )
}

/** Parses a `notification-dismiss` frame; the server always sends all three ids. */
fun parseNotifyDismiss(value: JsonElement?): NotifyDismiss? {
    val root = value as? JsonObject ?: return null
    val tag = root.string("tag")?.takeIf { it.isNotEmpty() } ?: return null
    root.string("sessionId")?.takeIf { it.isNotEmpty() } ?: return null
    val requestId = root.string("requestId")?.takeIf { it.isNotEmpty() } ?: return null
    return NotifyDismiss(tag, requestId)
}

/**
 * Number of running agents from a `running` frame, or null when the frame
 * carries no id list (the server omits it on some transitions).
 */
fun runningSessionCount(value: JsonObject): Int? = (value["runningSessionIds"] as? JsonArray)?.size

/** `seq` only grows, even across process restarts, so the server never drops a newer report. */
fun nextPresenceSeq(previous: Long, nowMillis: Long): Long =
    if (nowMillis > previous) nowMillis else previous + 1

private fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull

/** Only a JSON boolean counts; stringly-typed legacy values fall back to defaults. */
private fun JsonObject.bool(key: String): Boolean? =
    (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

private fun JsonObject.stringList(key: String, strict: Boolean = false): List<String> {
    val array = this[key] as? JsonArray ?: return emptyList()
    val values = array.mapNotNull { (it as? JsonPrimitive)?.takeIf { primitive -> primitive.isString }?.content }
    return if (strict && values.size != array.size) emptyList() else values
}
