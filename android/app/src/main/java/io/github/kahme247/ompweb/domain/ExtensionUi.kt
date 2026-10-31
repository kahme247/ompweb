package io.github.kahme247.ompweb.domain

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * The blocking dialog part of omp's extension UI protocol
 * (`extension_ui_request`, web `ExtensionDialog.tsx`).
 */
sealed interface ExtensionDialogState {
    val id: String

    /** Absolute expiry in epoch milliseconds; null for a request without timeout. */
    val expiresAt: Long?

    data class Select(
        override val id: String,
        val title: String,
        val options: List<String>,
        override val expiresAt: Long? = null,
    ) : ExtensionDialogState

    data class Confirm(
        override val id: String,
        val title: String,
        val message: String,
        override val expiresAt: Long? = null,
    ) : ExtensionDialogState

    data class Input(
        override val id: String,
        val title: String,
        val placeholder: String?,
        override val expiresAt: Long? = null,
    ) : ExtensionDialogState

    data class Editor(
        override val id: String,
        val title: String,
        val prefill: String,
        /** omp sets this for plain-text answers ("Other"), rendered as prose. */
        val promptStyle: Boolean,
        override val expiresAt: Long? = null,
    ) : ExtensionDialogState

    data class Ask(
        override val id: String,
        val questions: List<AskQuestion>,
        override val expiresAt: Long? = null,
    ) : ExtensionDialogState
}

/** One `ask` question (`RpcAskDialogQuestion`). */
data class AskQuestion(
    val id: String,
    val question: String,
    val header: String?,
    val options: List<AskOption>,
    val multi: Boolean,
    /** Index into [options]; null when nothing is recommended. */
    val recommended: Int?,
)

data class AskOption(val label: String, val description: String?, val preview: String?)

/** Exactly one variant is answered, mirroring `ExtensionUiResponse`. */
sealed interface ExtensionResponse {
    val id: String

    data class Value(override val id: String, val value: String) : ExtensionResponse

    data class Confirmed(override val id: String, val confirmed: Boolean) : ExtensionResponse

    data class Cancelled(override val id: String) : ExtensionResponse

    data class Answers(override val id: String, val answers: List<AskAnswer>) : ExtensionResponse
}

/** Per-question answer sent back in question order (`RpcAskDialogAnswer`). */
data class AskAnswer(val id: String, val selectedOptions: List<String>, val customInput: String?)

data class ExtensionStatusItem(val key: String, val text: String)

enum class ExtensionWidgetPlacement { AboveEditor, BelowEditor }

data class ExtensionWidgetItem(
    val key: String,
    val lines: List<String>,
    val placement: ExtensionWidgetPlacement,
)

/** The custom/terminal panel (`method: "custom"`), fed by `extension_ui_input`. */
data class ExtensionTerminalState(val id: String, val lines: List<String>)

enum class ExtensionNoticeLevel { Info, Warning, Error }

/** What one `extension_ui_request` frame asks of the UI. */
sealed interface ExtensionUiFrame {
    data class Dialog(val request: ExtensionDialogState) : ExtensionUiFrame

    /** `method: "cancel"` — closes only the dialog with [targetId]. */
    data class Cancel(val targetId: String) : ExtensionUiFrame

    data class Notify(val message: String, val level: ExtensionNoticeLevel) : ExtensionUiFrame

    data class OpenUrl(val url: String, val instructions: String?) : ExtensionUiFrame

    /** [text] null clears the extension's status entry. */
    data class Status(val key: String, val text: String?) : ExtensionUiFrame

    /** [lines] null removes the widget. */
    data class Widget(
        val key: String,
        val lines: List<String>?,
        val placement: ExtensionWidgetPlacement,
    ) : ExtensionUiFrame

    data class EditorText(val text: String) : ExtensionUiFrame

    data class Terminal(val id: String, val lines: List<String>) : ExtensionUiFrame

    data class TerminalClosed(val id: String) : ExtensionUiFrame

    /** A method this client deliberately ignores (`setTitle`: the browser is the only client with a title). */
    data object Ignored : ExtensionUiFrame
}

/** One `host_uri_request` frame: the agent reading or writing a host resource. */
data class HostUriRequest(
    val id: String,
    val write: Boolean,
    val url: String,
    /** Present for writes. */
    val content: String?,
)

/** A `pi-web://clipboard` read waiting for the user's consent. */
data class ClipboardPrompt(val sessionId: String)

/** An `open_url` request the user has to confirm before the app hands it to the system. */
data class ExtensionOpenUrlPrompt(val url: String, val instructions: String?)

/** An extension notice with the level omp attached (`notify`), shown as a coloured bar. */
data class ExtensionNotice(val message: String, val level: ExtensionNoticeLevel = ExtensionNoticeLevel.Info)

/**
 * Parse one `extension_ui_request` frame. Returns null for anything else so a
 * caller can test the frame type first. Unknown methods degrade to
 * [ExtensionUiFrame.Ignored], never to an error.
 */
fun parseExtensionUiFrame(frame: JsonObject, now: Long): ExtensionUiFrame? {
    if (frame.str("type") != "extension_ui_request") return null
    val method = frame.str("method") ?: return ExtensionUiFrame.Ignored
    val id = frame.str("id").orEmpty()
    val expiresAt = frame.expiresAt(now)
    return when (method) {
        "select" -> {
            if (id.isEmpty()) return ExtensionUiFrame.Ignored
            ExtensionUiFrame.Dialog(
                ExtensionDialogState.Select(
                    id = id,
                    title = frame.str("title").orEmpty(),
                    options = frame.strings("options"),
                    expiresAt = expiresAt,
                ),
            )
        }

        "confirm" -> {
            if (id.isEmpty()) return ExtensionUiFrame.Ignored
            ExtensionUiFrame.Dialog(
                ExtensionDialogState.Confirm(
                    id = id,
                    title = frame.str("title").orEmpty(),
                    message = frame.str("message").orEmpty(),
                    expiresAt = expiresAt,
                ),
            )
        }

        "input" -> {
            if (id.isEmpty()) return ExtensionUiFrame.Ignored
            ExtensionUiFrame.Dialog(
                ExtensionDialogState.Input(
                    id = id,
                    title = frame.str("title").orEmpty(),
                    placeholder = frame.str("placeholder"),
                    expiresAt = expiresAt,
                ),
            )
        }

        "editor" -> {
            if (id.isEmpty()) return ExtensionUiFrame.Ignored
            ExtensionUiFrame.Dialog(
                ExtensionDialogState.Editor(
                    id = id,
                    title = frame.str("title").orEmpty(),
                    prefill = frame.str("prefill").orEmpty(),
                    promptStyle = frame.bool("promptStyle") == true,
                    expiresAt = expiresAt,
                ),
            )
        }

        "ask" -> {
            if (id.isEmpty()) return ExtensionUiFrame.Ignored
            ExtensionUiFrame.Dialog(
                ExtensionDialogState.Ask(
                    id = id,
                    questions = (frame.sub("questions") as? JsonArray)
                        ?.mapNotNull { (it as? JsonObject)?.let(::parseAskQuestion) }
                        .orEmpty(),
                    expiresAt = expiresAt,
                ),
            )
        }

        "cancel" -> {
            val target = frame.str("targetId")
            if (target.isNullOrEmpty()) ExtensionUiFrame.Ignored else ExtensionUiFrame.Cancel(target)
        }

        "notify" -> ExtensionUiFrame.Notify(
            message = frame.str("message").orEmpty(),
            level = when (frame.str("notifyType")) {
                "warning" -> ExtensionNoticeLevel.Warning
                "error" -> ExtensionNoticeLevel.Error
                else -> ExtensionNoticeLevel.Info
            },
        )

        "open_url" -> ExtensionUiFrame.OpenUrl(
            // The wrapper allows the extension to hand a different launch URL.
            url = frame.str("launchUrl") ?: frame.str("url").orEmpty(),
            instructions = frame.str("instructions"),
        )

        "setStatus" -> {
            val key = frame.str("statusKey")
            if (key.isNullOrEmpty()) ExtensionUiFrame.Ignored else ExtensionUiFrame.Status(key, frame.str("statusText"))
        }

        "setWidget" -> {
            val key = frame.str("widgetKey")
            if (key.isNullOrEmpty()) {
                ExtensionUiFrame.Ignored
            } else {
                ExtensionUiFrame.Widget(
                    key = key,
                    lines = frame.sub("widgetLines")?.let { parseStringArray(it) },
                    placement = if (frame.str("widgetPlacement") == "belowEditor") {
                        ExtensionWidgetPlacement.BelowEditor
                    } else {
                        ExtensionWidgetPlacement.AboveEditor
                    },
                )
            }
        }

        "set_editor_text" -> ExtensionUiFrame.EditorText(frame.str("text").orEmpty())

        "custom" -> {
            if (id.isEmpty()) {
                ExtensionUiFrame.Ignored
            } else if (frame.bool("closed") == true) {
                ExtensionUiFrame.TerminalClosed(id)
            } else {
                ExtensionUiFrame.Terminal(id, frame.strings("lines"))
            }
        }

        else -> ExtensionUiFrame.Ignored
    }
}

/** Parse one `host_uri_request` frame, or null for another frame type. */
fun parseHostUriRequest(frame: JsonObject): HostUriRequest? {
    if (frame.str("type") != "host_uri_request") return null
    val id = frame.str("id") ?: return null
    if (id.isEmpty()) return null
    return HostUriRequest(
        id = id,
        write = frame.str("operation") == "write",
        url = frame.str("url").orEmpty(),
        content = frame.str("content"),
    )
}

private fun parseAskQuestion(raw: JsonObject): AskQuestion? {
    val id = raw.str("id") ?: return null
    val options = (raw.sub("options") as? JsonArray)
        ?.mapNotNull { (it as? JsonObject)?.let(::parseAskOption) }
        .orEmpty()
    return AskQuestion(
        id = id,
        question = raw.str("question").orEmpty(),
        header = raw.str("header"),
        options = options,
        multi = raw.bool("multi") == true,
        recommended = raw.num("recommended")?.toInt()?.takeIf { it in options.indices },
    )
}

private fun parseAskOption(raw: JsonObject): AskOption? {
    val label = raw.str("label") ?: return null
    return AskOption(
        label = label,
        description = raw.str("description"),
        preview = raw.str("preview"),
    )
}

private fun parseStringArray(element: JsonElement): List<String>? =
    (element as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }

private fun JsonObject.expiresAt(now: Long): Long? {
    val absolute = num("expiresAt")?.toLong()
    if (absolute != null && absolute > 0) return absolute
    val timeout = num("timeout")?.toLong()
    return if (timeout != null && timeout > 0) now + timeout else null
}

private fun JsonObject.strings(key: String): List<String> = sub(key)?.let(::parseStringArray).orEmpty()

private fun JsonObject.sub(key: String): JsonElement? = this[key]

private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

private fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.booleanOrNull

private fun JsonObject.num(key: String): Number? = (this[key] as? JsonPrimitive)?.let { primitive ->
    primitive.longOrNull ?: primitive.intOrNull
}

/**
 * Dialog state of one session, including the replay bookkeeping the protocol
 * requires: a reconnecting stream replays open requests with a fresh sequence,
 * so the same id must never stack a second dialog and a request this tab
 * already answered must never come back.
 */
class ExtensionUiState(private val answeredLimit: Int = ANSWERED_HISTORY_LIMIT) {
    var dialog: ExtensionDialogState? = null
        private set

    var statusItems: List<ExtensionStatusItem> = emptyList()
        private set

    var widgets: List<ExtensionWidgetItem> = emptyList()
        private set

    var terminal: ExtensionTerminalState? = null
        private set

    private val answered = ArrayDeque<String>()

    /** A session switch drops every panel; answered ids stay (a late replay must not reopen). */
    fun bindSession() {
        dialog = null
        statusItems = emptyList()
        widgets = emptyList()
        terminal = null
    }

    /** Forget every panel and every answered id: the signed-in user is being dropped. */
    fun reset() {
        bindSession()
        answered.clear()
    }

    /** Show [request] unless it was answered already; a replay replaces the current state. */
    fun request(request: ExtensionDialogState): Boolean {
        if (isAnswered(request.id)) return false
        dialog = request
        return true
    }

    /** `method: "cancel"` clears only the matching dialog. */
    fun cancel(targetId: String): Boolean {
        if (dialog?.id != targetId) return false
        dialog = null
        return true
    }

    /** Forget [id] after this client answered it, so its replay is ignored. */
    fun markAnswered(id: String) {
        answered.remove(id)
        answered.addLast(id)
        while (answered.size > answeredLimit) answered.removeFirst()
    }

    private fun isAnswered(id: String): Boolean = id in answered

    /**
     * Take [request] out of the UI because this client answers it now: the id
     * counts as answered (so its reconnect replay cannot reopen the panel) and
     * the panel is removed in the same step, before the RPC is sent. False when
     * the request is not the shown dialog or was answered already.
     */
    fun claimAnswer(request: ExtensionDialogState): Boolean {
        if (isAnswered(request.id)) return false
        if (dialog?.id != request.id) return false
        markAnswered(request.id)
        dialog = null
        return true
    }

    /**
     * Put a claimed request back after its RPC failed, so the user can answer
     * again. A request past its own [ExtensionDialogState.expiresAt] stays out:
     * the server settled it already, a panel for it could only be answered into
     * the void. The id of an unexpired request is never left burnt; a newer
     * dialog keeps the screen.
     */
    fun restore(request: ExtensionDialogState, now: Long): Boolean {
        val at = request.expiresAt
        if (at != null && at <= now) return false
        answered.remove(request.id)
        if (dialog != null) return false
        dialog = request
        return true
    }

    /** Drop an expired dialog; true when this call removed it. */
    fun expire(now: Long): Boolean {
        val current = dialog ?: return false
        val at = current.expiresAt ?: return false
        if (at > now) return false
        markAnswered(current.id)
        dialog = null
        return true
    }

    fun setStatus(key: String, text: String?) {
        val rest = statusItems.filterNot { it.key == key }
        statusItems = if (text.isNullOrEmpty()) rest else rest + ExtensionStatusItem(key, text)
    }

    fun setWidget(key: String, lines: List<String>?, placement: ExtensionWidgetPlacement) {
        val rest = widgets.filterNot { it.key == key }
        widgets = if (lines == null) {
            rest
        } else {
            rest + ExtensionWidgetItem(key, lines, placement)
        }
    }

    fun setTerminal(id: String, lines: List<String>) {
        terminal = ExtensionTerminalState(id, lines)
    }

    fun closeTerminal(id: String): Boolean {
        if (terminal?.id != id) return false
        terminal = null
        return true
    }

    private companion object {
        /** Enough ids to cover a reconnect replay plus the last few answers. */
        const val ANSWERED_HISTORY_LIMIT = 64
    }
}

// ---------------------------------------------------------------------------
// `ask` forms: the drafts live in the UI, the rules live here.
// ---------------------------------------------------------------------------

data class AskDraft(
    val selected: List<String> = emptyList(),
    /** The Other text stays for the question even while another option is chosen. */
    val other: String = "",
    val otherChosen: Boolean = false,
)

data class AskForm(val drafts: List<AskDraft>) {

    fun draftAt(index: Int): AskDraft = drafts.getOrNull(index) ?: AskDraft()

    /** Multi-select may stay empty; single-select needs a choice or a typed Other. */
    fun canSubmit(questions: List<AskQuestion>): Boolean = questions.withIndex().all { (index, question) ->
        val draft = draftAt(index)
        question.multi || draft.selected.isNotEmpty() || (draft.otherChosen && draft.other.trim().isNotEmpty())
    }

    /** Option ids are labels, exactly as the web dialog sends them. */
    fun answers(questions: List<AskQuestion>): List<AskAnswer> = questions.mapIndexed { index, question ->
        val draft = draftAt(index)
        val custom = if (draft.otherChosen) draft.other.trim() else ""
        AskAnswer(
            id = question.id,
            selectedOptions = question.options.map { it.label }.filter { it in draft.selected },
            customInput = custom.ifEmpty { null },
        )
    }

    fun toggleOption(questions: List<AskQuestion>, index: Int, label: String): AskForm {
        val question = questions.getOrNull(index) ?: return this
        return update(index) { current ->
            if (question.multi) {
                val selected = if (label in current.selected) {
                    current.selected - label
                } else {
                    current.selected + label
                }
                current.copy(selected = selected)
            } else {
                current.copy(selected = listOf(label), otherChosen = false)
            }
        }
    }

    fun chooseOther(questions: List<AskQuestion>, index: Int, chosen: Boolean): AskForm =
        update(index) { current ->
            val multi = questions.getOrNull(index)?.multi == true
            current.copy(
                selected = if (chosen && !multi) emptyList() else current.selected,
                otherChosen = chosen,
            )
        }

    /**
     * Tapping back into kept Other text means answering with it again (web
     * `chooseKeptOther`); it never invents a choice for empty text.
     */
    fun focusOther(questions: List<AskQuestion>, index: Int): AskForm {
        val current = draftAt(index)
        if (current.otherChosen || current.other.trim().isEmpty()) return this
        return chooseOther(questions, index, true)
    }

    fun setOther(questions: List<AskQuestion>, index: Int, text: String): AskForm =
        update(index) { current ->
            if (text.trim().isEmpty()) {
                current.copy(other = text, otherChosen = false)
            } else {
                val multi = questions.getOrNull(index)?.multi == true
                current.copy(
                    other = text,
                    otherChosen = true,
                    selected = if (multi) current.selected else emptyList(),
                )
            }
        }

    private fun update(index: Int, transform: (AskDraft) -> AskDraft): AskForm {
        if (index !in drafts.indices) return this
        return AskForm(drafts.mapIndexed { at, draft -> if (at == index) transform(draft) else draft })
    }
}

/** Fresh drafts for [questions]; single-select starts on its recommended option. */
fun initialAskForm(questions: List<AskQuestion>): AskForm = AskForm(
    questions.map { question ->
        val recommended = question.recommended
            ?.takeIf { !question.multi }
            ?.let { question.options.getOrNull(it) }
        AskDraft(selected = recommended?.let { listOf(it.label) }.orEmpty())
    },
)

/** `pi-web://clipboard` is the only host resource the app implements. */
fun hostUriResource(url: String): String = url.replace(Regex("^pi-web://", RegexOption.IGNORE_CASE), "")

// ---------------------------------------------------------------------------
// Terminal input (web `lib/terminal-input.ts`)
// ---------------------------------------------------------------------------

/**
 * The `extension_ui_input` data for one hardware key press in the custom
 * terminal panel; null means the key produces no terminal input. [key] uses
 * the DOM names (`Enter`, `ArrowUp`, `Backspace`, …) so the port stays
 * comparable with the web table.
 */
fun terminalKeyData(key: String, ctrl: Boolean, alt: Boolean, shift: Boolean): String? {
    // Ctrl+V stays a paste for the text field, exactly like the web terminal.
    if (ctrl && !alt && key.equals("v", ignoreCase = true)) return null
    if (ctrl && !alt) {
        legacyCtrlSequence(key)?.let { return it }
    }
    if (alt && !ctrl) {
        if (key == "Backspace") return "\u001b\u007f"
        TERMINAL_ALT_ARROWS[key]?.let { return it }
        if (key.length == 1) return "\u001b$key"
    }
    if (key == "Enter") return if (shift) "\n" else "\r"
    if (key == "Tab") return if (shift) "\u001b[Z" else "\t"
    return TERMINAL_SPECIAL_KEYS[key]
}

private val TERMINAL_SPECIAL_KEYS = mapOf(
    "ArrowUp" to "\u001b[A",
    "ArrowDown" to "\u001b[B",
    "ArrowRight" to "\u001b[C",
    "ArrowLeft" to "\u001b[D",
    "Home" to "\u001b[H",
    "End" to "\u001b[F",
    "Insert" to "\u001b[2~",
    "Delete" to "\u001b[3~",
    "PageUp" to "\u001b[5~",
    "PageDown" to "\u001b[6~",
    "Escape" to "\u001b",
    "Backspace" to "\u007f",
)

private val TERMINAL_ALT_ARROWS = mapOf(
    "ArrowLeft" to "\u001bb",
    "ArrowRight" to "\u001bf",
    "ArrowUp" to "\u001bp",
    "ArrowDown" to "\u001bn",
)

private fun legacyCtrlSequence(key: String): String? {
    if (key.length != 1) return null
    val code = key.uppercase()[0].code
    if (code in 64..95) return (code and 0x1f).toChar().toString()
    return if (key == "?") "\u007f" else null
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

/** `extension_ui_response`: exactly one answer variant (web `respondToExtensionUi`). */
fun extensionResponseCommand(response: ExtensionResponse): JsonObject = buildJsonObject {
    put("type", "extension_ui_response")
    put("id", response.id)
    when (response) {
        is ExtensionResponse.Value -> put("value", response.value)
        is ExtensionResponse.Confirmed -> put("confirmed", response.confirmed)
        is ExtensionResponse.Cancelled -> put("cancelled", true)
        is ExtensionResponse.Answers -> put(
            "answers",
            buildJsonArray {
                response.answers.forEach { answer ->
                    add(
                        buildJsonObject {
                            put("id", answer.id)
                            put(
                                "selectedOptions",
                                buildJsonArray { answer.selectedOptions.forEach { add(JsonPrimitive(it)) } },
                            )
                            answer.customInput?.let { put("customInput", it) }
                        },
                    )
                }
            },
        )
    }
}

/** `extension_ui_input` for the custom/terminal panel. */
fun extensionInputCommand(id: String, data: JsonElement): JsonObject = buildJsonObject {
    put("type", "extension_ui_input")
    put("id", id)
    put("data", data)
}
