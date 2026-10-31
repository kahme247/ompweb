package io.github.kahme247.ompweb.chat

/**
 * Paging state of the transcript's "load earlier" trigger (web
 * `lib/chat-lazy-load.ts` and the `ChatWindow` IntersectionObserver).
 *
 * Auto-paging starts only after the reader reached the tail once, and only
 * from a re-armed state: prepending one window moves the first visible row
 * away from index 0, which re-arms the trigger. Without that latch every
 * content change at the top would prepend another window (cascade).
 */
data class LoadEarlierState(
    val tailReached: Boolean = false,
    val armed: Boolean = false,
)

data class LoadEarlierDecision(val expand: Boolean, val state: LoadEarlierState)

/**
 * One measurement of the laid-out transcript tail, all values in pixels: the
 * lazy item count, the bottom-most visible item and the viewport's end.
 * Produced after a measure pass, so it describes what is really on screen —
 * unlike the message list, which changes before the list has laid out.
 */
data class TailMeasure(
    val totalItems: Int,
    val lastVisibleIndex: Int,
    val lastVisibleEnd: Int,
    val viewportEnd: Int,
)

/**
 * Pure decisions behind the transcript scroll: the load-earlier latch, the
 * lazy-item mapping used to keep the reader's row in place when a window is
 * prepended, and the follow-the-tail latch.
 */
object ScrollLogic {

    /**
     * One observation of the first visible lazy item.
     *
     * @param firstVisibleItemIndex 0-based lazy item index (`0` = top).
     * @param windowStart first transcript row that is currently rendered.
     * @param nearBottom the viewport sits at the tail.
     */
    fun decideLoadEarlier(
        firstVisibleItemIndex: Int,
        windowStart: Int,
        nearBottom: Boolean,
        state: LoadEarlierState,
    ): LoadEarlierDecision {
        val tailReached = state.tailReached || nearBottom
        if (firstVisibleItemIndex != 0) {
            return LoadEarlierDecision(
                expand = false,
                state = LoadEarlierState(tailReached = tailReached, armed = true),
            )
        }
        val expand = tailReached && state.armed && !nearBottom && windowStart > 0
        return LoadEarlierDecision(
            expand = expand,
            state = LoadEarlierState(
                tailReached = tailReached,
                armed = if (expand) false else state.armed,
            ),
        )
    }

    /**
     * Lazy item index of absolute row [rowIndex] for a window starting at
     * [windowStart], below [leadItems] header items that are always on top (the
     * extension status band, the compacted-history notice).
     */
    fun itemIndexForRow(rowIndex: Int, windowStart: Int, leadItems: Int = 0): Int =
        (rowIndex - windowStart).coerceAtLeast(0) + (if (windowStart > 0) 1 else 0) + leadItems

    /** Item index that shows the first row of a freshly loaded earlier window. */
    fun revealLoadedItem(windowStart: Int, leadItems: Int = 0): Int =
        if (windowStart > 0) 1 + leadItems else leadItems

    /**
     * The absolute row shown by lazy item [itemIndex] — the inverse of
     * [itemIndexForRow], used to persist the reading position. A header item
     * (the leading band/notice or the "load earlier" row) maps to the first row
     * of the window.
     */
    fun rowIndexForItem(itemIndex: Int, windowStart: Int, leadItems: Int = 0): Int {
        val firstRowItem = leadItems + if (windowStart > 0) 1 else 0
        return (itemIndex - firstRowItem).coerceAtLeast(0) + windowStart
    }

    /**
     * The viewport shows the transcript's last item (the tail anchor) with its
     * bottom at or above the viewport end — the reader is at the very bottom.
     */
    fun tailAtBottom(measure: TailMeasure): Boolean =
        measure.totalItems > 0 &&
            measure.lastVisibleIndex == measure.totalItems - 1 &&
            measure.lastVisibleEnd <= measure.viewportEnd

    /**
     * The measured layout left the tail outside the viewport (new content grew
     * below, a taller row was laid out, the keyboard or a panel shrank the
     * viewport). Only a measured layout can answer this: the composable's
     * state changes before the list has measured the new content.
     */
    fun needsTailScroll(measure: TailMeasure): Boolean =
        measure.totalItems > 0 && !tailAtBottom(measure)

    /**
     * Whether the reader sits within [thresholdPx] of the tail. The tail
     * anchor is the last item; while the reader is above the bottom the anchor
     * is out of view and the item above it must end within the threshold of the
     * viewport, either above it (the anchor is just below) or below it (the
     * item is tall and crosses the viewport end). A list without a measured
     * layout counts as the tail, exactly like the viewport's initial state.
     */
    fun isNearBottom(measure: TailMeasure, thresholdPx: Int): Boolean {
        if (measure.totalItems == 0 || measure.lastVisibleIndex < 0) return true
        if (measure.lastVisibleIndex >= measure.totalItems - 1) return true
        if (measure.lastVisibleIndex != measure.totalItems - 2) return false
        val gap = measure.lastVisibleEnd - measure.viewportEnd
        return gap <= thresholdPx && gap >= -thresholdPx
    }

    /**
     * Whether following the tail resumes after a saved reading position
     * ([restoredRow], counted over [rowCount] rows) was restored: only when the
     * position is the newest row or the measured layout already sits at the
     * tail. Any other position belongs to the reader and must stay put while
     * the answer streams.
     */
    fun followAfterRestore(
        restoredRow: Int,
        rowCount: Int,
        measure: TailMeasure,
        thresholdPx: Int,
    ): Boolean = restoredRow >= rowCount - 1 || isNearBottom(measure, thresholdPx)

    /**
     * Render window a rebuilt transcript surface starts in.
     *
     * A configuration change (rotation, fold, window resize) recreates the
     * composable: the lazy list restores its own first item and offset from the
     * saved instance state, so the window those indices were rendered from must
     * survive with them or the same index addresses a different row. A window
     * saved for a longer transcript (branch switch, compaction) is clamped to
     * the rows that still exist.
     */
    fun clampWindow(windowStart: Int, rowCount: Int): Int {
        if (rowCount <= 0) return 0
        return windowStart.coerceIn(0, rowCount - 1)
    }
}
