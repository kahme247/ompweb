package io.github.kahme247.ompweb.ui.settings

import androidx.compose.ui.input.key.Key
import io.github.kahme247.ompweb.domain.SETTINGS_CATEGORIES
import io.github.kahme247.ompweb.domain.SettingsTab
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A20: the web settings tablist (`SettingsTabs.tsx:63-73`) steps with the
 * arrows, jumps with Home/End, clamps instead of wrapping, and activates with
 * Enter/Space.
 */
class SettingsKeyNavTest {

    @Test
    fun `arrows step one tab at a time`() {
        assertEquals(4, settingsNavTarget(3, SettingsNavKey.DOWN, 10))
        assertEquals(4, settingsNavTarget(3, SettingsNavKey.RIGHT, 10))
        assertEquals(2, settingsNavTarget(3, SettingsNavKey.UP, 10))
        assertEquals(2, settingsNavTarget(3, SettingsNavKey.LEFT, 10))
    }

    @Test
    fun `the ends clamp instead of wrapping`() {
        assertNull(settingsNavTarget(0, SettingsNavKey.UP, 10))
        assertNull(settingsNavTarget(9, SettingsNavKey.DOWN, 10))
    }

    @Test
    fun `home and end jump to the bounds`() {
        assertEquals(0, settingsNavTarget(5, SettingsNavKey.HOME, 10))
        assertEquals(9, settingsNavTarget(5, SettingsNavKey.END, 10))
    }

    @Test
    fun `enter keeps the current tab`() {
        assertEquals(5, settingsNavTarget(5, SettingsNavKey.ACTIVATE, 10))
    }

    @Test
    fun `an out-of-range index is clamped first`() {
        assertEquals(9, settingsNavTarget(42, SettingsNavKey.ACTIVATE, 10))
        assertEquals(0, settingsNavTarget(-3, SettingsNavKey.ACTIVATE, 10))
        assertNull(settingsNavTarget(0, SettingsNavKey.DOWN, 0))
    }

    @Test
    fun `the compose keys map onto the navigation actions`() {
        assertEquals(SettingsNavKey.UP, settingsNavKeyFor(Key.DirectionUp))
        assertEquals(SettingsNavKey.DOWN, settingsNavKeyFor(Key.DirectionDown))
        assertEquals(SettingsNavKey.LEFT, settingsNavKeyFor(Key.DirectionLeft))
        assertEquals(SettingsNavKey.RIGHT, settingsNavKeyFor(Key.DirectionRight))
        assertEquals(SettingsNavKey.HOME, settingsNavKeyFor(Key.MoveHome))
        assertEquals(SettingsNavKey.END, settingsNavKeyFor(Key.MoveEnd))
        assertEquals(SettingsNavKey.ACTIVATE, settingsNavKeyFor(Key.Enter))
        assertEquals(SettingsNavKey.ACTIVATE, settingsNavKeyFor(Key.NumPadEnter))
        assertEquals(SettingsNavKey.ACTIVATE, settingsNavKeyFor(Key.Spacebar))
        assertNull(settingsNavKeyFor(Key.A))
        assertNull(settingsNavKeyFor(Key.Tab))
    }

    @Test
    fun `workspace tabs drop out without an open workspace`() {
        val all = enabledSettingsTabs("/repo")
        val withoutWorkspace = enabledSettingsTabs(null)

        assertEquals(SETTINGS_CATEGORIES.size, all.size)
        assertTrue(withoutWorkspace.size < all.size)
        assertTrue(all.containsAll(withoutWorkspace))
        assertTrue(
            SETTINGS_CATEGORIES.filter { it.needsWorkspace }.all { it !in withoutWorkspace },
        )
        assertEquals(SettingsTab.AGENTS, SETTINGS_CATEGORIES.first { it.needsWorkspace })
    }
}
