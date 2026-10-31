package io.github.kahme247.ompweb.ui.theme

import androidx.compose.ui.input.key.Key

/**
 * The keyboard contract of the modal pickers, shared by the theme picker and
 * the branch navigator (web `ThemeSwitcher.tsx` / `BranchNavigator.tsx`):
 * arrows/Home/End move the highlight, Enter/Space confirm it and Escape closes
 * without a choice.
 */
enum class PickerDialogKey {
    CHOOSE,
    CANCEL,
    PREVIOUS,
    NEXT,
    FIRST,
    LAST,
}

/** Compose key → picker action; null for every other key (A21). */
fun pickerDialogKeyFor(key: Key): PickerDialogKey? = when (key) {
    Key.Enter, Key.NumPadEnter, Key.Spacebar -> PickerDialogKey.CHOOSE
    Key.Escape -> PickerDialogKey.CANCEL
    Key.DirectionUp -> PickerDialogKey.PREVIOUS
    Key.DirectionDown -> PickerDialogKey.NEXT
    Key.MoveHome -> PickerDialogKey.FIRST
    Key.MoveEnd -> PickerDialogKey.LAST
    else -> null
}

/**
 * The highlight after [key] within [count] rows. Vertical arrows wrap like the
 * web theme menu; Home/End clamp to the ends.
 */
fun pickerDialogTarget(index: Int, key: PickerDialogKey, count: Int): Int? {
    if (count <= 0) return null
    val current = index.coerceIn(0, count - 1)
    return when (key) {
        PickerDialogKey.PREVIOUS -> (current - 1 + count) % count
        PickerDialogKey.NEXT -> (current + 1) % count
        PickerDialogKey.FIRST -> 0
        PickerDialogKey.LAST -> count - 1
        PickerDialogKey.CHOOSE, PickerDialogKey.CANCEL -> null
    }
}
