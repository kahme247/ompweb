package io.github.kahme247.ompweb.ui.chat

import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The keyboard-open budget (user feedback 25.10.: the transcript shrank to
 * four lines and the composer text field grew while typing).
 */
class ChatLayoutTest {

    private fun chrome(fontScale: Float) =
        (ChatLayout.CHROME_LINE_HEIGHT_SP * fontScale).dp + ChatLayout.CHROME_PADDING

    private fun transcriptShare(plan: ChatLayoutPlan, available: Float, fontScale: Float): Float {
        val transcript = available - plan.composerMaxHeight.value - chrome(fontScale).value
        return transcript / available
    }

    @Test
    fun phoneWithKeyboardHidesPanelsAndControlsAndKeepsTranscriptShare() {
        val available = 320.dp
        val plan = ChatLayout.plan(available, imeVisible = true, wide = false, fontScale = 1f)
        assertTrue("panels must collapse while typing", plan.hidePanels)
        assertTrue("controls row must step aside while typing", plan.hideControlsRow)
        assertTrue(
            "transcript keeps >= 45 % of the keyboard-opened pane, was ${transcriptShare(plan, 320f, 1f)}",
            transcriptShare(plan, 320f, 1f) >= ChatLayout.TRANSCRIPT_MIN_FRACTION - 0.001f,
        )
    }

    @Test
    fun fieldIsCappedAtSixLinesOrAThirdOfThePane() {
        // 1x: six 20 sp lines fit in a tall pane.
        val tall = ChatLayout.plan(900.dp, imeVisible = false, wide = false, fontScale = 1f)
        assertEquals(ChatLayout.TEXT_FIELD_MAX_LINES, tall.textFieldMaxLines)
        assertEquals((20 * ChatLayout.TEXT_FIELD_MAX_LINES).dp, tall.textFieldMaxHeight)

        // Keyboard open: a third of the pane wins over the line count.
        val short = ChatLayout.plan(300.dp, imeVisible = true, wide = false, fontScale = 1f)
        assertTrue(short.textFieldMaxHeight <= 300.dp * ChatLayout.TEXT_FIELD_MAX_FRACTION)
        assertTrue(short.textFieldMaxLines in 1..ChatLayout.TEXT_FIELD_MAX_LINES)
    }

    @Test
    fun fontScaleTwoHundredStaysUsable() {
        val available = 300.dp
        val plan = ChatLayout.plan(available, imeVisible = true, wide = false, fontScale = 2f)
        // A 40 dp line: the 35 % cap leaves two lines instead of six, and the
        // field is still at least one line tall (caret visible, internal scroll).
        assertTrue(plan.textFieldMaxLines in 1..3)
        assertEquals(40.dp, (ChatLayout.FIELD_LINE_HEIGHT_SP * 2f).dp)
        assertTrue(plan.textFieldMaxHeight >= ChatLayout.TEXT_FIELD_MIN)
        assertTrue(
            "transcript keeps its share at 200 % too, was ${transcriptShare(plan, 300f, 2f)}",
            transcriptShare(plan, 300f, 2f) >= ChatLayout.TRANSCRIPT_MIN_FRACTION - 0.001f,
        )
    }

    @Test
    fun fieldNeverPushesTheSendRowOutOfTheScrollingBox() {
        // Bug 13/#7: 350 dp pane at 200 % font. The old cap gave the field
        // 122 dp inside a 160 dp box whose fixed rows (minimize + send) need
        // 116 dp, so the box scrolled and hid the send row. The clamped field
        // leaves exactly the fixed rows.
        val plan = ChatLayout.plan(350.dp, imeVisible = true, wide = false, fontScale = 2f)
        val expectedMax = 350.dp * (1f - ChatLayout.TRANSCRIPT_MIN_FRACTION) - chrome(2f)
        assertEquals(expectedMax.value, plan.composerMaxHeight.value, 0.01f)
        assertEquals(
            (expectedMax - ChatLayout.COMPOSER_FIXED_ROWS).value,
            plan.textFieldMaxHeight.value,
            0.01f,
        )
        assertEquals(
            plan.composerMaxHeight.value,
            plan.textFieldMaxHeight.value + ChatLayout.COMPOSER_FIXED_ROWS.value,
            0.01f,
        )

        // Whenever the box has room for the 40 dp field floor, the cap leaves
        // the fixed rows inside the box — at every font scale and both panes.
        for (ime in listOf(true, false)) {
            for (wide in listOf(true, false)) {
                for (fontScale in listOf(1f, 1.5f, 2f)) {
                    var available = 240
                    while (available <= 1000) {
                        val p = ChatLayout.plan(
                            availableHeight = available.dp,
                            imeVisible = ime,
                            wide = wide,
                            fontScale = fontScale,
                        )
                        val room = p.composerMaxHeight - ChatLayout.COMPOSER_FIXED_ROWS
                        if (room >= ChatLayout.TEXT_FIELD_MIN) {
                            assertTrue(
                                "field $available/$fontScale/$ime/$wide: ${p.textFieldMaxHeight} " +
                                    "+ ${ChatLayout.COMPOSER_FIXED_ROWS} > ${p.composerMaxHeight}",
                                p.textFieldMaxHeight + ChatLayout.COMPOSER_FIXED_ROWS <= p.composerMaxHeight,
                            )
                        }
                        assertTrue(
                            "field never exceeds its room: $available/$fontScale/$ime/$wide",
                            p.textFieldMaxHeight <= p.composerMaxHeight || room < ChatLayout.TEXT_FIELD_MIN,
                        )
                        available += 20
                    }
                }
            }
        }
    }

    @Test
    fun reservedSearchBarShrinksTheComposerNotTheFieldRows() {
        val free = ChatLayout.plan(500.dp, imeVisible = true, wide = false, fontScale = 1f)
        val reserved = ChatLayout.plan(
            availableHeight = 500.dp,
            imeVisible = true,
            wide = false,
            fontScale = 1f,
            reservedHeight = 56.dp,
        )
        assertEquals(free.composerMaxHeight - 56.dp, reserved.composerMaxHeight)
        assertTrue(
            "the reservation is taken from the field, not from the fixed rows",
            reserved.textFieldMaxHeight < free.textFieldMaxHeight,
        )
        assertEquals(
            reserved.composerMaxHeight,
            reserved.textFieldMaxHeight + ChatLayout.COMPOSER_FIXED_ROWS,
        )
    }

    @Test
    fun tabletWithRoomKeepsTheFullComposer() {
        val available = 700.dp
        val plan = ChatLayout.plan(available, imeVisible = true, wide = true, fontScale = 1f)
        assertFalse(plan.hidePanels)
        assertFalse(plan.hideControlsRow)
        assertEquals(available - ChatLayout.TRANSCRIPT_FLOOR, plan.composerMaxHeight)
    }

    @Test
    fun tabletWithoutRoomBehavesLikeAPhone() {
        val plan = ChatLayout.plan(400.dp, imeVisible = true, wide = true, fontScale = 1f)
        assertTrue(plan.hidePanels)
        assertTrue(plan.hideControlsRow)
    }

    @Test
    fun closedKeyboardKeepsTheOldFloors() {
        val plan = ChatLayout.plan(500.dp, imeVisible = false, wide = false, fontScale = 1f)
        assertFalse(plan.hidePanels)
        assertFalse(plan.hideControlsRow)
        assertEquals(500.dp - ChatLayout.TRANSCRIPT_FLOOR, plan.composerMaxHeight)
    }

    @Test
    fun tinyPaneNeverProducesNegativeOrOverflowingHeights() {
        val plan = ChatLayout.plan(0.dp, imeVisible = true, wide = false, fontScale = 2f)
        assertEquals(0.dp, plan.composerMaxHeight)
        assertEquals(ChatLayout.TEXT_FIELD_MIN, plan.textFieldMaxHeight)
        assertEquals(1, plan.textFieldMaxLines)
    }
}
