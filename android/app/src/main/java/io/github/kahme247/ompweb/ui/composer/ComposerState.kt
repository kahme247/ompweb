package io.github.kahme247.ompweb.ui.composer

import io.github.kahme247.ompweb.data.ChatDraft
import io.github.kahme247.ompweb.domain.AtQuery
import io.github.kahme247.ompweb.domain.FileIndexEntry
import io.github.kahme247.ompweb.domain.SlashCommandItem
import io.github.kahme247.ompweb.domain.SlashQuery

/** A programmatic rewrite of the composer text (suggestion, history, restore). */
data class ComposerEdit(val id: Long, val text: String, val caret: Int)

data class SlashMenuUi(
    val query: SlashQuery,
    val commands: List<SlashCommandItem>,
    val activeIndex: Int = 0,
) {
    val active: SlashCommandItem? get() = commands.getOrNull(activeIndex)
}

data class AtMenuUi(
    val query: AtQuery,
    val entries: List<FileIndexEntry>,
    val activeIndex: Int = 0,
    val searchingAll: Boolean = false,
) {
    val active: FileIndexEntry? get() = entries.getOrNull(activeIndex)
}

/** `↑` history palette: newest first, [activeIndex] indexes [entries]. */
data class HistoryMenuUi(
    val entries: List<String>,
    val activeIndex: Int = 0,
) {
    val active: String? get() = entries.getOrNull(activeIndex)
}

/**
 * Everything a composer shows: the draft (text + attachments), the open
 * autocomplete/history palettes and the `!`/`!!` shell mode. Shared by the
 * chat and the new-session pane so both behave identically.
 */
data class ComposerUiState(
    val draft: ChatDraft = ChatDraft(),
    val caret: Int = 0,
    val slash: SlashMenuUi? = null,
    val at: AtMenuUi? = null,
    val history: HistoryMenuUi? = null,
    val bashMode: Boolean = false,
    val bashExcluded: Boolean = false,
    val readingAttachments: Boolean = false,
    /** Last programmatic text rewrite; the field applies it when the id changes. */
    val edit: ComposerEdit? = null,
) {
    val text: String get() = draft.value
    val images get() = draft.images
    val files get() = draft.files
    val hasContent: Boolean get() = draft.value.isNotBlank() || draft.hasAttachments
    val canAcceptGhost: Boolean get() = slash == null && at == null && history == null && !bashMode
}

/** `!command` / `!!command` shell mode (web `isBashCommand`). */
fun composerBashMode(text: String): Boolean = text.trimStart().startsWith("!")
