package io.github.kahme247.ompweb.ui.chat

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * How the chat splits its height between transcript and composer for one
 * measured pane. Computed by [ChatLayout.plan] *before* either side is
 * measured, because both sides are children of the same column: whichever is
 * measured first would otherwise eat the other's space. The composer is the
 * bounded one (it scrolls its secondary rows), the transcript keeps the rest.
 */
internal data class ChatLayoutPlan(
    /** Upper bound of the composer block (panels excluded — they are hidden or above them at all). */
    val composerMaxHeight: Dp,
    val textFieldMaxHeight: Dp,
    val textFieldMaxLines: Int,
    /** The attached composer panels (todo / subagents / btw) are out while typing. */
    val hidePanels: Boolean,
    /** The model/thinking/tools row under the field is out while typing. */
    val hideControlsRow: Boolean,
)

/**
 * The height budget of the chat surface with the keyboard open (user feedback
 * 25.10.: the transcript shrank to four lines while typing).
 *
 * The rule is a fraction, not a fixed dp floor, so it holds at font scale 2.0
 * as well: the transcript keeps at least [TRANSCRIPT_MIN_FRACTION] of the pane
 * the IME left over, the composer takes at most the rest, and the text field
 * itself is capped at [TEXT_FIELD_MAX_LINES] lines / [TEXT_FIELD_MAX_FRACTION]
 * of that space — minus the rows that must stay visible ([COMPOSER_FIXED_ROWS])
 * — and scrolls internally (the caret stays in view because `BasicTextField`
 * scrolls to it).
 *
 * A wide pane (tablet / unfolded, >= [WIDE_SCREEN_DP] dp) that still has at
 * least [WIDE_KEYBOARD_HEADROOM] dp left above the keyboard keeps the full
 * composer: nothing is hidden when there is room for it.
 */
internal object ChatLayout {

    /**
     * What the transcript needs to stay readable. Used as a fixed floor when
     * the keyboard is closed (the composer only grows when the field grows)
     * and replaced by [TRANSCRIPT_MIN_FRACTION] while the keyboard is open.
     */
    val TRANSCRIPT_FLOOR = 120.dp

    /** The composer's own floor while the keyboard is closed. */
    val COMPOSER_FLOOR = 140.dp

    /** Below this the field would show less than its placeholder line. */
    val TEXT_FIELD_MIN = 40.dp

    /** Five to six lines: enough to re-read a prompt, small enough to keep the chat. */
    const val TEXT_FIELD_MAX_LINES = 6

    /** Line height of the composer field (`14.sp` text, `20.sp` line height). */
    const val FIELD_LINE_HEIGHT_SP = 20f

    /** Share of the (IME-reduced) pane the transcript keeps while typing. */
    const val TRANSCRIPT_MIN_FRACTION = 0.45f

    /** Hard cap of the field relative to the (IME-reduced) pane. */
    const val TEXT_FIELD_MAX_FRACTION = 0.35f

    /** `compact` breakpoint used across the shell. */
    const val WIDE_SCREEN_DP = 600

    /**
     * Space above the keyboard that still fits the full composer on a wide
     * pane. Below it the tablet behaves like the phone (hide, cap, scroll).
     */
    val WIDE_KEYBOARD_HEADROOM = 480.dp

    /**
     * The status line under the composer ([io.github.kahme247.ompweb.ui.chat.ChatFooter])
     * is not part of the composer's own cap, so the transcript's share is only
     * honest when the plan reserves it: one `11.sp` line plus its padding, at
     * the current font scale.
     */
    const val CHROME_LINE_HEIGHT_SP = 11f
    val CHROME_PADDING = 10.dp

    /**
     * The composer box scrolls (`ChatScreen`: `heightIn(max).verticalScroll`),
     * so a field cap that ignores the fixed rows around it would push the send
     * row below the visible slice on a small pane / large font. These rows do
     * not shrink and therefore belong to the budget first:
     *
     * - the minimize button above the field: a 48 dp touch target plus its
     *   2 dp vertical padding (`MinimizeComposerButton`);
     * - the composer surface's own 6 dp top/bottom padding;
     * - the send row under the field: 4 dp top padding plus its 48 dp touch
     *   target (the speaker/add buttons set the row height, not the label).
     */
    val MINIMIZE_ROW = 52.dp
    val COMPOSER_SURFACE_PADDING = 12.dp
    val SEND_ROW = 52.dp

    /** Rows of the composer box that must stay visible above and below the field. */
    val COMPOSER_FIXED_ROWS = MINIMIZE_ROW + COMPOSER_SURFACE_PADDING + SEND_ROW

    fun plan(
        availableHeight: Dp,
        imeVisible: Boolean,
        wide: Boolean,
        fontScale: Float,
        /**
         * Height of fixed chrome above the transcript that the plan does not
         * own (the in-chat search bar). Reserved from the composer's share so
         * the 45 % transcript promise also holds with the search open.
         */
        reservedHeight: Dp = 0.dp,
    ): ChatLayoutPlan {
        val available = if (availableHeight.value.isNaN()) 0.dp else availableHeight.coerceAtLeast(0.dp)
        val reserved = if (reservedHeight.value.isNaN()) 0.dp else reservedHeight.coerceAtLeast(0.dp)
        val keyboardTight = imeVisible && !(wide && available >= WIDE_KEYBOARD_HEADROOM)
        val lineHeight = (FIELD_LINE_HEIGHT_SP * fontScale.coerceAtLeast(0.5f)).dp
        val chrome = (CHROME_LINE_HEIGHT_SP * fontScale.coerceAtLeast(0.5f)).dp + CHROME_PADDING
        val composerMax = if (keyboardTight) {
            (available * (1f - TRANSCRIPT_MIN_FRACTION) - chrome - reserved).coerceAtLeast(0.dp)
        } else {
            (available - TRANSCRIPT_FLOOR - reserved)
                .coerceIn(minOf(COMPOSER_FLOOR, available), available)
        }
        // The send row and the minimize button never scroll out of the box:
        // the field only gets what is left after them (Bug 13/#7). The 40 dp
        // floor wins only on panes too small for both; there the box still has
        // to scroll (ComposerBar cannot render a shorter field).
        val fieldRoom = (composerMax - COMPOSER_FIXED_ROWS).coerceAtLeast(0.dp)
        val fieldCap = minOf(lineHeight * TEXT_FIELD_MAX_LINES, available * TEXT_FIELD_MAX_FRACTION, fieldRoom)
            .coerceAtLeast(TEXT_FIELD_MIN)
            .coerceAtMost(available.coerceAtLeast(TEXT_FIELD_MIN))
        val lines = (fieldCap.value / lineHeight.value).toInt()
            .coerceIn(1, TEXT_FIELD_MAX_LINES)
        return ChatLayoutPlan(
            composerMaxHeight = composerMax,
            textFieldMaxHeight = fieldCap,
            textFieldMaxLines = lines,
            hidePanels = keyboardTight,
            hideControlsRow = keyboardTight,
        )
    }
}
