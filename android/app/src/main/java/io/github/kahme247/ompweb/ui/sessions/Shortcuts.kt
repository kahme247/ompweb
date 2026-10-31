package io.github.kahme247.ompweb.ui.sessions

/**
 * Hardware shortcuts the shell root handles (web `useKeyboardShortcuts.ts`
 * for the navigation keys, `ChatInput`/`ChatWindow` for the chat keys).
 */
enum class SessionShortcut {
    QuickSwitcher,
    NewSession,
    Abort,
    CycleModel,
    CycleThinking,
    Dictation,
    HistoryBack,
    HistoryForward,
}

/** The key names the shell distinguishes; anything else is not a shortcut. */
enum class ShellKeyName {
    K,
    N,
    M,
    T,
    Escape,
    DirectionLeft,
    DirectionRight,
    LeftBracket,
    RightBracket,
}

/**
 * A key press reduced to what the mapping needs, so the mapping and the gate
 * stay testable without an Android `KeyEvent`.
 */
data class ShellKeyEvent(
    val key: ShellKeyName,
    val ctrl: Boolean = false,
    val meta: Boolean = false,
    val alt: Boolean = false,
    val shift: Boolean = false,
)

/**
 * The web's key bindings, extracted so B17's test can name them:
 * Ctrl/Cmd+K palette, Ctrl/Cmd+Alt+N new session, Ctrl/Cmd+Alt+M model cycle,
 * Ctrl/Cmd+Alt+T thinking cycle, Ctrl/Cmd+M dictation, Esc abort, and the
 * browser-style Alt+Left/Right history steps.
 */
object ShortcutKeyMap {

    /** Returns the shortcut for [event], or null when the key is not bound. */
    fun resolve(event: ShellKeyEvent): SessionShortcut? {
        val primary = event.ctrl || event.meta
        return when {
            primary && !event.alt && event.key == ShellKeyName.K -> SessionShortcut.QuickSwitcher
            primary && event.alt && event.key == ShellKeyName.N -> SessionShortcut.NewSession
            primary && event.alt && event.key == ShellKeyName.M -> SessionShortcut.CycleModel
            primary && event.alt && event.key == ShellKeyName.T -> SessionShortcut.CycleThinking
            primary && !event.alt && !event.shift && event.key == ShellKeyName.M -> SessionShortcut.Dictation
            event.key == ShellKeyName.Escape -> SessionShortcut.Abort
            event.alt && !primary && !event.shift && event.key == ShellKeyName.DirectionLeft ->
                SessionShortcut.HistoryBack
            event.alt && !primary && !event.shift && event.key == ShellKeyName.DirectionRight ->
                SessionShortcut.HistoryForward
            // Cmd+[ / Cmd+] on macOS and Ctrl+[ / Ctrl+] elsewhere.
            primary && !event.alt && !event.shift && event.key == ShellKeyName.LeftBracket ->
                SessionShortcut.HistoryBack
            primary && !event.alt && !event.shift && event.key == ShellKeyName.RightBracket ->
                SessionShortcut.HistoryForward
            else -> null
        }
    }
}

/**
 * What the shell knows about the moment a key arrives.
 *
 * [textFieldFocused] is true when a descendant of the shell holds focus: the
 * only focusable text fields in the shell are the composer and the search
 * field, and Compose offers no query for the focused semantics, so the root
 * treats a focused descendant as "the user may be typing" (the conservative
 * web rule: Esc must not abort from a TEXTAREA/INPUT).
 */
data class ShortcutContext(
    val detailVisible: Boolean,
    val chatCovered: Boolean,
    val textFieldFocused: Boolean,
    val busy: Boolean,
    val paletteOpen: Boolean,
    /** A modal dialog owns the input (web: shortcuts are ignored in dialogs). */
    val dialogOpen: Boolean = false,
) {
    /** The chat is on screen and nothing (overlay, sheet, typing) covers it. */
    val chatActive: Boolean get() = detailVisible && !chatCovered
}

/**
 * The gate A2 asks for: a shortcut only fires in the context the web allows.
 *
 * `chatActive` requires the detail pane to be visible and uncovered; the
 * palette and the navigation shortcuts stay shell-global (they work from the
 * list, like the web's document-level bindings).
 */
object ShortcutGate {

    fun allows(shortcut: SessionShortcut, context: ShortcutContext): Boolean = when (shortcut) {
        // The palette binding toggles, so it stays live while the palette itself
        // is open (web `CommandPalette` binds Ctrl+K on the window and flips
        // its open flag) — but a modal dialog owns the input like the web's
        // dialog stack, so other dialogs swallow the key.
        SessionShortcut.QuickSwitcher -> !context.dialogOpen

        SessionShortcut.NewSession -> !context.dialogOpen

        // Esc first closes the palette; only an idle composer's Esc means abort.
        SessionShortcut.Abort ->
            context.chatActive && context.busy && !context.paletteOpen &&
                !context.textFieldFocused && !context.dialogOpen

        SessionShortcut.CycleModel,
        SessionShortcut.CycleThinking,
        SessionShortcut.Dictation,
        -> context.chatActive && !context.dialogOpen

        // The browser's history shortcuts must not consume an arrow key the
        // focused field uses to move its caret.
        SessionShortcut.HistoryBack,
        SessionShortcut.HistoryForward,
        -> !context.textFieldFocused && !context.dialogOpen
    }
}

/** The effects a handled shortcut triggers; separate so the gate is pure. */
class ShortcutActions(
    val quickSwitcher: () -> Unit = {},
    val newSession: () -> Unit = {},
    val abort: () -> Unit = {},
    val cycleModel: () -> Unit = {},
    val cycleThinking: () -> Unit = {},
    val dictation: () -> Unit = {},
    val historyBack: () -> Unit = {},
    val historyForward: () -> Unit = {},
)

/**
 * Maps, gates and runs one key event. Returns true when the event was handled,
 * so the caller can stop it from reaching any other handler.
 */
fun handleSessionShortcut(
    event: ShellKeyEvent,
    context: ShortcutContext,
    actions: ShortcutActions,
): Boolean {
    val shortcut = ShortcutKeyMap.resolve(event) ?: return false
    if (!ShortcutGate.allows(shortcut, context)) return false
    when (shortcut) {
        SessionShortcut.QuickSwitcher -> actions.quickSwitcher()
        SessionShortcut.NewSession -> actions.newSession()
        SessionShortcut.Abort -> actions.abort()
        SessionShortcut.CycleModel -> actions.cycleModel()
        SessionShortcut.CycleThinking -> actions.cycleThinking()
        SessionShortcut.Dictation -> actions.dictation()
        SessionShortcut.HistoryBack -> actions.historyBack()
        SessionShortcut.HistoryForward -> actions.historyForward()
    }
    return true
}
