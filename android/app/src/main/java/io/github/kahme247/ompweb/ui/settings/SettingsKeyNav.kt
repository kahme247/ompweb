package io.github.kahme247.ompweb.ui.settings

import androidx.compose.ui.input.key.Key
import io.github.kahme247.ompweb.domain.SETTINGS_CATEGORIES
import io.github.kahme247.ompweb.domain.SettingsTab

/**
 * The keys the web's settings tablist understands (`SettingsTabs.tsx:63-73`):
 * arrows step through the enabled categories, Home/End jump to the ends, and
 * moving the focus also selects the category (activation follows the arrow).
 */
enum class SettingsNavKey {
    UP,
    DOWN,
    LEFT,
    RIGHT,
    HOME,
    END,
    /** Enter/Space: confirm the focused category. */
    ACTIVATE,
}

/** Compose key → navigation action; null for every other key. */
fun settingsNavKeyFor(key: Key): SettingsNavKey? = when (key) {
    Key.DirectionUp -> SettingsNavKey.UP
    Key.DirectionDown -> SettingsNavKey.DOWN
    Key.DirectionLeft -> SettingsNavKey.LEFT
    Key.DirectionRight -> SettingsNavKey.RIGHT
    Key.MoveHome -> SettingsNavKey.HOME
    Key.MoveEnd -> SettingsNavKey.END
    Key.Enter, Key.NumPadEnter, Key.Spacebar -> SettingsNavKey.ACTIVATE
    else -> null
}

/**
 * The target index for [key] within [count] enabled tabs, or null when the key
 * does nothing. The web clamps at both ends instead of wrapping, and a
 * workspace-gated category is skipped entirely because its row is disabled.
 */
fun settingsNavTarget(index: Int, key: SettingsNavKey, count: Int): Int? {
    if (count <= 0) return null
    val current = index.coerceIn(0, count - 1)
    return when (key) {
        SettingsNavKey.UP, SettingsNavKey.LEFT -> (current - 1).takeIf { it >= 0 }
        SettingsNavKey.DOWN, SettingsNavKey.RIGHT -> (current + 1).takeIf { it < count }
        SettingsNavKey.HOME -> 0
        SettingsNavKey.END -> count - 1
        SettingsNavKey.ACTIVATE -> current
    }
}

/** The categories that accept focus: a workspace tab needs an open workspace. */
fun enabledSettingsTabs(cwd: String?): List<SettingsTab> =
    SETTINGS_CATEGORIES.filter { tab -> !tab.needsWorkspace || cwd != null }
