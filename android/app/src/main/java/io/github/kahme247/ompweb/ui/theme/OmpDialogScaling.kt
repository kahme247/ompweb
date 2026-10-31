package io.github.kahme247.ompweb.ui.theme

import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.LocalMinimumInteractiveComponentSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.PopupProperties

/**
 * Re-applies [OmpWebTheme]'s scaling, palette and Material theme inside a
 * dialog, bottom sheet or popup window. Those open their own window with its
 * own composition and derive their density from that window's context, so the
 * [OmpDisplayScaling] provider around the app does not reach their content:
 * font size and UI scale would be ignored there.
 *
 * The density is derived from the window's context and not from
 * [LocalDensity]: the preference is applied on top of the base scaling
 * exactly once, also when a dialog is opened from inside another dialog.
 */
@Composable
fun OmpDialogContent(
    preferences: OmpDisplayPreferences,
    content: @Composable () -> Unit,
) {
    val context = LocalContext.current
    val density = remember(context, preferences.uiScale, preferences.fontSize) {
        val base = Density(context)
        Density(
            density = base.density * preferences.uiScale.densityScale,
            fontScale = base.fontScale * preferences.fontSize.fontScale,
        )
    }
    val theme = resolveOmpTheme(preferences.themeId)
    CompositionLocalProvider(
        LocalOmpDisplayPreferences provides preferences,
        LocalDensity provides density,
        LocalMinimumInteractiveComponentSize provides preferences.touchTargets.minimumSizeDp.dp,
        LocalOmpColors provides theme.colors,
    ) {
        MaterialTheme(colorScheme = theme.colors.toColorScheme(theme.isDark), content = content)
    }
}

/**
 * [Dialog] whose content follows the app's font size, UI scale and theme.
 * Use it for every dialog that shows app content (settings, notification
 * history, pickers, viewers) instead of the plain Compose `Dialog`.
 */
@Composable
fun OmpDialog(
    onDismissRequest: () -> Unit,
    properties: DialogProperties = DialogProperties(),
    content: @Composable () -> Unit,
) {
    val preferences = LocalOmpDisplayPreferences.current
    Dialog(onDismissRequest = onDismissRequest, properties = properties) {
        OmpDialogContent(preferences, content)
    }
}

/**
 * [AlertDialog] with a scaled title, text and buttons. The dialog container
 * itself keeps the window's density, so its fixed padding does not follow the
 * UI scale; everything the app renders inside it does.
 */
@Composable
fun OmpAlertDialog(
    onDismissRequest: () -> Unit,
    confirmButton: @Composable () -> Unit,
    title: (@Composable () -> Unit)? = null,
    text: (@Composable () -> Unit)? = null,
    dismissButton: (@Composable () -> Unit)? = null,
) {
    val preferences = LocalOmpDisplayPreferences.current
    AlertDialog(
        onDismissRequest = onDismissRequest,
        confirmButton = { OmpDialogContent(preferences) { confirmButton() } },
        title = if (title != null) {
            { OmpDialogContent(preferences) { title() } }
        } else {
            null
        },
        text = if (text != null) {
            { OmpDialogContent(preferences) { text() } }
        } else {
            null
        },
        dismissButton = if (dismissButton != null) {
            { OmpDialogContent(preferences) { dismissButton() } }
        } else {
            null
        },
    )
}

/**
 * [DropdownMenu] whose items follow the app's font size, UI scale, touch
 * target size and theme. A menu is a popup window like a dialog: it brings its
 * own density from the window context, so the plain `DropdownMenu` keeps the
 * system size no matter what the app is set to.
 *
 * Use it instead of `DropdownMenu` for every menu; the items stay direct
 * children of the menu's own column, so scrolling inside long menus is kept.
 *
 * The menu container itself (its vertical margin and the surface padding) is
 * laid out before the items and keeps the window's density, the same
 * limitation [OmpAlertDialog] has for its container padding.
 */
@Composable
fun OmpDropdownMenu(
    expanded: Boolean,
    onDismissRequest: () -> Unit,
    modifier: Modifier = Modifier,
    offset: DpOffset = DpOffset(0.dp, 0.dp),
    properties: PopupProperties = PopupProperties(focusable = true),
    containerColor: Color = MenuDefaults.containerColor,
    content: @Composable ColumnScope.() -> Unit,
) {
    val preferences = LocalOmpDisplayPreferences.current
    DropdownMenu(
        expanded = expanded,
        onDismissRequest = onDismissRequest,
        modifier = modifier,
        offset = offset,
        properties = properties,
        containerColor = containerColor,
    ) {
        val menuScope = this
        OmpDialogContent(preferences) {
            with(menuScope) { content() }
        }
    }
}
