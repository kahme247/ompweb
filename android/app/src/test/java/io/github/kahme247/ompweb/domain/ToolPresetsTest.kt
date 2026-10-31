package io.github.kahme247.ompweb.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ToolPresetsTest {

    @Test
    fun `wire names match lib tool-presets`() {
        assertEquals("none", ToolPreset.NONE.wireName)
        assertEquals("default", ToolPreset.DEFAULT.wireName)
        assertEquals("full", ToolPreset.FULL.wireName)
    }

    @Test
    fun `only the full preset omits toolNames`() {
        assertEquals(emptyList<String>(), ToolPreset.NONE.toolNames())
        assertEquals(listOf("read", "bash", "edit", "write"), ToolPreset.DEFAULT.toolNames())
        assertNull(ToolPreset.FULL.toolNames())
    }

    @Test
    fun `unknown stored values fall back to full`() {
        assertEquals(ToolPreset.FULL, ToolPreset.fromWire(null))
        assertEquals(ToolPreset.FULL, ToolPreset.fromWire("bogus"))
        assertEquals(ToolPreset.DEFAULT, ToolPreset.fromWire("default"))
        assertEquals(ToolPreset.NONE, ToolPreset.fromWire("none"))
    }
}
