package io.github.kahme247.ompweb.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ScrollLogicTest {

    @Test
    fun `opening a session at the top never expands before the tail was seen`() {
        val decision = ScrollLogic.decideLoadEarlier(
            firstVisibleItemIndex = 0,
            windowStart = 0,
            nearBottom = false,
            state = LoadEarlierState(),
        )
        assertFalse(decision.expand)
        assertFalse("the tail was never reached", decision.state.tailReached)
        assertFalse("scrolling to the top alone does not arm the trigger", decision.state.armed)
    }

    @Test
    fun `reaching the tail arms the trigger for the next scroll up`() {
        val atTail = ScrollLogic.decideLoadEarlier(
            firstVisibleItemIndex = 4,
            windowStart = 0,
            nearBottom = true,
            state = LoadEarlierState(),
        )
        assertFalse(atTail.expand)
        assertTrue(atTail.state.tailReached)
        assertTrue(atTail.state.armed)

        val scrolledUp = ScrollLogic.decideLoadEarlier(
            firstVisibleItemIndex = 0,
            windowStart = 40,
            nearBottom = false,
            state = atTail.state,
        )
        assertTrue(scrolledUp.expand)
        assertFalse("one expansion consumes the arm", scrolledUp.state.armed)
    }

    @Test
    fun `the trigger does not cascade while the window is prepended`() {
        val afterExpand = LoadEarlierDecision(
            expand = true,
            state = LoadEarlierState(tailReached = true, armed = false),
        ).state
        // The prepended window shifts the reader away from item 0, which re-arms.
        val shifted = ScrollLogic.decideLoadEarlier(
            firstVisibleItemIndex = 1,
            windowStart = 20,
            nearBottom = false,
            state = afterExpand,
        )
        assertFalse(shifted.expand)
        assertTrue(shifted.state.armed)

        // A repeated item 0 without a re-arm must not expand again.
        val repeated = ScrollLogic.decideLoadEarlier(
            firstVisibleItemIndex = 0,
            windowStart = 20,
            nearBottom = false,
            state = LoadEarlierState(tailReached = true, armed = false),
        )
        assertFalse(repeated.expand)
        assertFalse(repeated.state.armed)
    }

    @Test
    fun `the trigger never expands without history or while at the tail`() {
        val noHistory = ScrollLogic.decideLoadEarlier(
            firstVisibleItemIndex = 0,
            windowStart = 0,
            nearBottom = false,
            state = LoadEarlierState(tailReached = true, armed = true),
        )
        assertFalse(noHistory.expand)

        val atTail = ScrollLogic.decideLoadEarlier(
            firstVisibleItemIndex = 0,
            windowStart = 40,
            nearBottom = true,
            state = LoadEarlierState(tailReached = true, armed = true),
        )
        assertFalse("a shrinking viewport at the bottom is not a scroll up", atTail.expand)
    }

    @Test
    fun `row to item mapping keeps the reader's row in place`() {
        assertEquals(5, ScrollLogic.itemIndexForRow(rowIndex = 5, windowStart = 0))
        // With a prepended window the header occupies item 0.
        assertEquals(2, ScrollLogic.itemIndexForRow(rowIndex = 5, windowStart = 4))
        assertEquals(1, ScrollLogic.itemIndexForRow(rowIndex = 12, windowStart = 12))
        assertEquals(1, ScrollLogic.itemIndexForRow(rowIndex = 3, windowStart = 12))
    }

    @Test
    fun `the header reveals the first loaded row`() {
        assertEquals(0, ScrollLogic.revealLoadedItem(windowStart = 0))
        assertEquals(1, ScrollLogic.revealLoadedItem(windowStart = 12))
    }

    @Test
    fun `leading transcript items shift the row mapping`() {
        // Extension band plus the compacted-history notice occupy items 0 and 1;
        // the first transcript row is item 2, not item 0.
        assertEquals(2, ScrollLogic.itemIndexForRow(rowIndex = 0, windowStart = 0, leadItems = 2))
        assertEquals(7, ScrollLogic.itemIndexForRow(rowIndex = 5, windowStart = 0, leadItems = 2))
        // A prepended window adds its "load earlier" row below the lead items.
        assertEquals(3, ScrollLogic.revealLoadedItem(windowStart = 12, leadItems = 2))
        assertEquals(3, ScrollLogic.itemIndexForRow(rowIndex = 12, windowStart = 12, leadItems = 2))
    }

    @Test
    fun `a persisted row survives every leading item combination`() {
        for (leadItems in 0..2) {
            for (windowStart in listOf(0, 4, 40)) {
                for (rowIndex in windowStart until windowStart + 60) {
                    val item = ScrollLogic.itemIndexForRow(rowIndex, windowStart, leadItems)
                    assertEquals(
                        "row $rowIndex at window $windowStart with $leadItems lead item(s)",
                        rowIndex,
                        ScrollLogic.rowIndexForItem(item, windowStart, leadItems),
                    )
                }
            }
        }
        // A header item at the top maps to the first row of the window.
        assertEquals(40, ScrollLogic.rowIndexForItem(itemIndex = 0, windowStart = 40, leadItems = 1))
        assertEquals(40, ScrollLogic.rowIndexForItem(itemIndex = 1, windowStart = 40, leadItems = 1))
        assertEquals(41, ScrollLogic.rowIndexForItem(itemIndex = 3, windowStart = 40, leadItems = 1))
    }

    @Test
    fun `a measured tail at the viewport end is at the bottom`() {
        val atBottom = TailMeasure(
            totalItems = 12,
            lastVisibleIndex = 11,
            lastVisibleEnd = 2000,
            viewportEnd = 2000,
        )
        assertTrue(ScrollLogic.tailAtBottom(atBottom))
        assertFalse("nothing to scroll when the tail is visible", ScrollLogic.needsTailScroll(atBottom))
    }

    @Test
    fun `content that grew below the viewport needs a follow scroll`() {
        // A new row (or a taller one) was laid out: the tail anchor moved out of
        // view and the last visible item is the one above it.
        val grew = TailMeasure(
            totalItems = 13,
            lastVisibleIndex = 10,
            lastVisibleEnd = 1900,
            viewportEnd = 2000,
        )
        assertFalse(ScrollLogic.tailAtBottom(grew))
        assertTrue(ScrollLogic.needsTailScroll(grew))

        // A tall tail item that is only partially visible is not pinned yet.
        val partial = TailMeasure(
            totalItems = 13,
            lastVisibleIndex = 12,
            lastVisibleEnd = 2040,
            viewportEnd = 2000,
        )
        assertTrue(ScrollLogic.needsTailScroll(partial))
    }

    @Test
    fun `a list without a measured layout never scrolls itself`() {
        val empty = TailMeasure(totalItems = 0, lastVisibleIndex = -1, lastVisibleEnd = 0, viewportEnd = 0)
        assertFalse(ScrollLogic.needsTailScroll(empty))
        assertFalse(ScrollLogic.tailAtBottom(empty))
        assertTrue("an unmeasured list counts as the tail", ScrollLogic.isNearBottom(empty, 96))
    }

    @Test
    fun `near bottom uses the tail anchor and a threshold`() {
        // Tail anchor visible: at the bottom, whatever the offsets say.
        assertTrue(
            ScrollLogic.isNearBottom(
                TailMeasure(totalItems = 12, lastVisibleIndex = 11, lastVisibleEnd = 1990, viewportEnd = 2000),
                thresholdPx = 96,
            ),
        )
        // One long item crosses the viewport end; 80 px below is still near.
        assertTrue(
            ScrollLogic.isNearBottom(
                TailMeasure(totalItems = 12, lastVisibleIndex = 10, lastVisibleEnd = 2080, viewportEnd = 2000),
                thresholdPx = 96,
            ),
        )
        // The same item ends 400 px past the viewport end: the reader is up.
        assertFalse(
            ScrollLogic.isNearBottom(
                TailMeasure(totalItems = 12, lastVisibleIndex = 10, lastVisibleEnd = 2400, viewportEnd = 2000),
                thresholdPx = 96,
            ),
        )
        // An item two slots above the tail is visible: far from the bottom.
        assertFalse(
            ScrollLogic.isNearBottom(
                TailMeasure(totalItems = 12, lastVisibleIndex = 9, lastVisibleEnd = 2000, viewportEnd = 2000),
                thresholdPx = 96,
            ),
        )
    }

    @Test
    fun `following resumes after a restore only at the tail`() {
        val atTail =
            TailMeasure(totalItems = 12, lastVisibleIndex = 11, lastVisibleEnd = 1990, viewportEnd = 2000)
        val above =
            TailMeasure(totalItems = 12, lastVisibleIndex = 9, lastVisibleEnd = 2000, viewportEnd = 2000)
        // The saved position is the newest row: the stream keeps following.
        assertTrue(ScrollLogic.followAfterRestore(499, 500, above, thresholdPx = 96))
        // The saved position sits mid-transcript: it stays where the reader left it.
        assertFalse(ScrollLogic.followAfterRestore(100, 500, above, thresholdPx = 96))
        // A position that landed at the bottom anyway keeps following.
        assertTrue(ScrollLogic.followAfterRestore(480, 500, atTail, thresholdPx = 96))
        assertFalse(ScrollLogic.followAfterRestore(480, 500, above, thresholdPx = 96))
    }

    @Test
    fun `a restored window stays where the reader left it`() {
        // 500 rows: the reader scrolled 100 rows up, the window is frozen there.
        assertEquals(400, ScrollLogic.clampWindow(windowStart = 400, rowCount = 500))
        assertEquals(440, ScrollLogic.clampWindow(windowStart = 440, rowCount = 500))
    }

    @Test
    fun `a restored window never points past the transcript`() {
        // The transcript shrank while the surface was gone (branch switch or a
        // compaction dropped rows): the saved window would render nothing.
        assertEquals(39, ScrollLogic.clampWindow(windowStart = 400, rowCount = 40))
        assertEquals(0, ScrollLogic.clampWindow(windowStart = -5, rowCount = 40))
        assertEquals(0, ScrollLogic.clampWindow(windowStart = 120, rowCount = 0))
    }
}
