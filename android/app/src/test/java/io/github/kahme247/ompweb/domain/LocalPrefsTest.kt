package io.github.kahme247.ompweb.domain

import org.junit.Assert.assertEquals
import org.junit.Test

class LocalPrefsTest {

    @Test
    fun `wire values match the web hooks`() {
        assertEquals("sm", FontSizePreference.SM.wire)
        assertEquals("md", FontSizePreference.MD.wire)
        assertEquals("lg", FontSizePreference.LG.wire)
        assertEquals("xl", FontSizePreference.XL.wire)
        assertEquals("compact", UiScalePreference.COMPACT.wire)
        assertEquals("standard", UiScalePreference.STANDARD.wire)
        assertEquals("comfortable", UiScalePreference.COMFORTABLE.wire)
        assertEquals("large", UiScalePreference.LARGE.wire)
        assertEquals("auto", TouchTargetsPreference.AUTO.wire)
        assertEquals("compact", TouchTargetsPreference.COMPACT.wire)
        assertEquals("accessible", TouchTargetsPreference.ACCESSIBLE.wire)
    }

    @Test
    fun `unknown and missing wire values fall back to defaults`() {
        assertEquals(FontSizePreference.MD, FontSizePreference.fromWire(null))
        assertEquals(FontSizePreference.MD, FontSizePreference.fromWire("huge"))
        assertEquals(UiScalePreference.STANDARD, UiScalePreference.fromWire(null))
        assertEquals(UiScalePreference.STANDARD, UiScalePreference.fromWire(""))
        assertEquals(TouchTargetsPreference.AUTO, TouchTargetsPreference.fromWire(null))
        assertEquals(TouchTargetsPreference.AUTO, TouchTargetsPreference.fromWire("large"))
    }

    @Test
    fun `scales are monotonic and auto keeps the material minimum`() {
        assertEquals(1f, FontSizePreference.MD.fontScale)
        assertEquals(1f, UiScalePreference.STANDARD.densityScale)
        assertEquals(48f, TouchTargetsPreference.AUTO.minimumSizeDp)
        val fonts = FontSizePreference.entries.map { it.fontScale }
        assertEquals(fonts.sorted(), fonts)
        val densities = UiScalePreference.entries.map { it.densityScale }
        assertEquals(densities.sorted(), densities)
        assertEquals(
            listOf(40f, 48f, 56f),
            TouchTargetsPreference.entries.map { it.minimumSizeDp }.sorted(),
        )
    }
}
