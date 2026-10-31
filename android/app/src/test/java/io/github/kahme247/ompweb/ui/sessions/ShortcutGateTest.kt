package io.github.kahme247.ompweb.ui.sessions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A2/B17: the shell's hardware shortcuts are mapped and gated by pure
 * functions, so the matrix (list visible, files sheet open, overlay open,
 * field focused, busy, palette open) is testable without a device.
 */
class ShortcutGateTest {

    private val chat = ShortcutContext(
        detailVisible = true,
        chatCovered = false,
        textFieldFocused = false,
        busy = true,
        paletteOpen = false,
    )

    // --- B17: the key map ---------------------------------------------------

    @Test
    fun `the web bindings map to the session shortcuts`() {
        assertEquals(
            SessionShortcut.QuickSwitcher,
            ShortcutKeyMap.resolve(key(ShellKeyName.K, ctrl = true)),
        )
        assertEquals(
            "Cmd+Alt+N also opens a new session on macOS",
            SessionShortcut.NewSession,
            ShortcutKeyMap.resolve(key(ShellKeyName.N, meta = true, alt = true)),
        )
        assertEquals(
            SessionShortcut.CycleModel,
            ShortcutKeyMap.resolve(key(ShellKeyName.M, ctrl = true, alt = true)),
        )
        assertEquals(
            SessionShortcut.CycleThinking,
            ShortcutKeyMap.resolve(key(ShellKeyName.T, ctrl = true, alt = true)),
        )
        assertEquals(
            "Ctrl+M (without Alt) starts dictation instead of cycling the model",
            SessionShortcut.Dictation,
            ShortcutKeyMap.resolve(key(ShellKeyName.M, ctrl = true)),
        )
        assertEquals(SessionShortcut.Abort, ShortcutKeyMap.resolve(key(ShellKeyName.Escape)))
        assertEquals(
            SessionShortcut.HistoryBack,
            ShortcutKeyMap.resolve(key(ShellKeyName.DirectionLeft, alt = true)),
        )
        assertEquals(
            SessionShortcut.HistoryForward,
            ShortcutKeyMap.resolve(key(ShellKeyName.DirectionRight, alt = true)),
        )
        assertEquals(
            SessionShortcut.HistoryBack,
            ShortcutKeyMap.resolve(key(ShellKeyName.LeftBracket, ctrl = true)),
        )
        assertEquals(
            SessionShortcut.HistoryForward,
            ShortcutKeyMap.resolve(key(ShellKeyName.RightBracket, ctrl = true)),
        )
    }

    @Test
    fun `unbound keys stay unhandled`() {
        assertNull("a bare K is not bound", ShortcutKeyMap.resolve(key(ShellKeyName.K)))
        assertNull(ShortcutKeyMap.resolve(key(ShellKeyName.M)))
        assertNull("Alt+M is not a shortcut", ShortcutKeyMap.resolve(key(ShellKeyName.M, alt = true)))
        assertNull(
            "Shift+Ctrl+M is not the dictation binding",
            ShortcutKeyMap.resolve(key(ShellKeyName.M, ctrl = true, shift = true)),
        )
    }

    // --- A2: the gate matrix ------------------------------------------------

    @Test
    fun `chat shortcuts are live in an idle uncovered chat`() {
        for (shortcut in listOf(
            SessionShortcut.Abort,
            SessionShortcut.CycleModel,
            SessionShortcut.CycleThinking,
            SessionShortcut.Dictation,
        )) {
            assertTrue("$shortcut in the chat", ShortcutGate.allows(shortcut, chat))
        }
    }

    @Test
    fun `the drawer blocks the chat shortcuts while the list is visible`() {
        val list = chat.copy(detailVisible = false)
        for (shortcut in listOf(
            SessionShortcut.Abort,
            SessionShortcut.CycleModel,
            SessionShortcut.CycleThinking,
            SessionShortcut.Dictation,
        )) {
            assertFalse("$shortcut must not fire from the drawer", ShortcutGate.allows(shortcut, list))
        }
        assertTrue(
            "the palette is a shell-global binding",
            ShortcutGate.allows(SessionShortcut.QuickSwitcher, list),
        )
        assertTrue(
            "new session works from the list",
            ShortcutGate.allows(SessionShortcut.NewSession, list),
        )
    }

    @Test
    fun `a covering sheet or overlay blocks the chat shortcuts`() {
        val covered = chat.copy(chatCovered = true)
        assertFalse(ShortcutGate.allows(SessionShortcut.Abort, covered))
        assertFalse(ShortcutGate.allows(SessionShortcut.CycleModel, covered))
        assertFalse(ShortcutGate.allows(SessionShortcut.Dictation, covered))
    }

    @Test
    fun `a focused text field blocks Esc and the history arrows`() {
        val typing = chat.copy(textFieldFocused = true)
        assertFalse("Esc must not abort while the user types", ShortcutGate.allows(SessionShortcut.Abort, typing))
        assertFalse(
            "Alt+Left belongs to the caret",
            ShortcutGate.allows(SessionShortcut.HistoryBack, typing),
        )
        assertFalse(
            "Alt+Right belongs to the caret",
            ShortcutGate.allows(SessionShortcut.HistoryForward, typing),
        )
        assertTrue(
            "Ctrl+Alt+M still cycles the model while typing",
            ShortcutGate.allows(SessionShortcut.CycleModel, typing),
        )
    }

    @Test
    fun `an idle session does not treat Esc as abort`() {
        assertFalse(ShortcutGate.allows(SessionShortcut.Abort, chat.copy(busy = false)))
    }

    @Test
    fun `the palette swallows Esc but not its own shortcut`() {
        val palette = chat.copy(paletteOpen = true)
        assertFalse("Esc closes the palette, it does not abort", ShortcutGate.allows(SessionShortcut.Abort, palette))
        assertTrue(
            "Ctrl+K toggles the palette",
            ShortcutGate.allows(SessionShortcut.QuickSwitcher, palette),
        )
    }

    @Test
    fun `a modal dialog disables the shell actions`() {
        val dialog = chat.copy(dialogOpen = true)
        for (shortcut in SessionShortcut.entries) {
            assertFalse("$shortcut inside a dialog", ShortcutGate.allows(shortcut, dialog))
        }
    }

    @Test
    fun `Ctrl+K toggles the palette instead of only opening it`() {
        var open = false
        val actions = ShortcutActions(quickSwitcher = { open = !open })

        assertTrue(handleSessionShortcut(key(ShellKeyName.K, ctrl = true), chat, actions))
        assertTrue("the first press opens the palette", open)
        assertTrue(handleSessionShortcut(key(ShellKeyName.K, ctrl = true), chat, actions))
        assertFalse("the second press closes it (web CommandPalette.toggles)", open)
    }

    @Test
    fun `handling runs exactly the bound action`() {
        val fired = mutableListOf<String>()
        val actions = ShortcutActions(
            abort = { fired += "abort" },
            cycleModel = { fired += "model" },
            dictation = { fired += "dictation" },
        )
        assertTrue(handleSessionShortcut(key(ShellKeyName.Escape), chat, actions))
        assertTrue(handleSessionShortcut(key(ShellKeyName.M, ctrl = true, alt = true), chat, actions))
        assertEquals(listOf("abort", "model"), fired)

        fired.clear()
        assertFalse(
            "a blocked press is not handled, so the field keeps the key",
            handleSessionShortcut(key(ShellKeyName.Escape), chat.copy(textFieldFocused = true), actions),
        )
        assertTrue(fired.isEmpty())

        assertFalse(handleSessionShortcut(key(ShellKeyName.M), chat, actions))
        assertTrue(fired.isEmpty())
    }

    private fun key(
        name: ShellKeyName,
        ctrl: Boolean = false,
        meta: Boolean = false,
        alt: Boolean = false,
        shift: Boolean = false,
    ) = ShellKeyEvent(name, ctrl = ctrl, meta = meta, alt = alt, shift = shift)
}
