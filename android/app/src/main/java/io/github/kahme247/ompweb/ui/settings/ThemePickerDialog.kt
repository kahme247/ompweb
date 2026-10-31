package io.github.kahme247.ompweb.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import io.github.kahme247.ompweb.ui.theme.OmpAlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.ui.theme.OmpTheme
import io.github.kahme247.ompweb.ui.theme.PickerDialogKey
import io.github.kahme247.ompweb.ui.theme.SYSTEM_THEME_ID
import io.github.kahme247.ompweb.ui.theme.pickerDialogKeyFor
import io.github.kahme247.ompweb.ui.theme.pickerDialogTarget
import kotlinx.coroutines.launch

/** Theme picker listing the system default plus every ompweb theme, with a colour swatch. */
@Composable
fun ThemePickerDialog(
    selectedThemeId: String,
    onSelect: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    OmpAlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.theme_title)) },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.theme_close))
            }
        },
        text = {
            ThemePickerContent(
                selectedThemeId = selectedThemeId,
                onSelect = onSelect,
                onDismiss = onDismiss,
            )
        },
    )
}

/**
 * The picker list with the web theme menu's keyboard contract (A21):
 * Up/Down wrap the highlight, Home/End jump to the ends, Enter/Space choose the
 * highlighted row (the current theme on open) and Escape cancels. Focus
 * leaving the picker closes it without a choice, mirroring the web menu's
 * blur/outside-click close.
 */
@Composable
internal fun ThemePickerContent(
    selectedThemeId: String,
    onSelect: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val ids = remember { listOf(SYSTEM_THEME_ID) + OmpTheme.entries.map { it.id } }
    val selectedIndex = ids.indexOf(selectedThemeId).takeIf { it >= 0 } ?: 0
    val listState = rememberLazyListState(initialFirstVisibleItemIndex = selectedIndex)
    val rootFocus = remember { FocusRequester() }
    val scope = rememberCoroutineScope()
    var hadFocus by remember { mutableStateOf(false) }
    // The web menu highlights the current theme on open; arrows move the
    // highlight and Enter chooses it. A row that took focus (Tab/click) wins.
    var activeIndex by remember { mutableIntStateOf(selectedIndex) }
    var focusedIndex by remember { mutableStateOf<Int?>(null) }

    fun choose(index: Int) {
        val id = ids.getOrNull(index) ?: return
        onSelect(id)
        onDismiss()
    }

    fun moveTo(index: Int) {
        activeIndex = index
        scope.launch { listState.scrollToItem(index) }
    }

    LaunchedEffect(Unit) { rootFocus.requestFocus() }

    LazyColumn(
        state = listState,
        modifier = Modifier
            .heightIn(max = 420.dp)
            .testTag("theme-picker")
            .focusRequester(rootFocus)
            .onFocusChanged { state ->
                if (state.hasFocus) hadFocus = true else if (hadFocus) onDismiss()
            }
            // Preview: the list would otherwise consume the arrows for scrolling.
            .onPreviewKeyEvent { event ->
                if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                val key = pickerDialogKeyFor(event.key)
                when (key) {
                    PickerDialogKey.CHOOSE -> {
                        choose(focusedIndex ?: activeIndex)
                        true
                    }
                    PickerDialogKey.CANCEL -> {
                        onDismiss()
                        true
                    }
                    null -> false
                    else -> {
                        val target = pickerDialogTarget(activeIndex, key, ids.size)
                        if (target == null) false else {
                            moveTo(target)
                            true
                        }
                    }
                }
            }
            .focusable(),
    ) {
        item(key = SYSTEM_THEME_ID) {
            ThemeRow(
                label = stringResource(R.string.theme_system),
                selected = selectedThemeId == SYSTEM_THEME_ID,
                swatchBackground = MaterialTheme.colorScheme.surface,
                swatchAccent = MaterialTheme.colorScheme.primary,
                modifier = Modifier.testTag("theme-row-$SYSTEM_THEME_ID"),
                onFocus = { focusedIndex = 0 },
                onChoose = { choose(0) },
            )
        }
        items(items = OmpTheme.entries, key = { it.id }) { theme ->
            val index = ids.indexOf(theme.id)
            ThemeRow(
                label = theme.displayName,
                selected = selectedThemeId == theme.id,
                swatchBackground = theme.colors.background,
                swatchAccent = theme.colors.accent,
                modifier = Modifier.testTag("theme-row-${theme.id}"),
                onFocus = { focusedIndex = index },
                onChoose = { choose(index) },
            )
        }
    }
}

@Composable
private fun ThemeRow(
    label: String,
    selected: Boolean,
    swatchBackground: Color,
    swatchAccent: Color,
    modifier: Modifier = Modifier,
    onFocus: () -> Unit,
    onChoose: () -> Unit,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .onFocusChanged { if (it.isFocused) onFocus() }
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onChoose)
            .padding(horizontal = 8.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(22.dp)
                .clip(CircleShape)
                .background(swatchBackground)
                .border(1.dp, MaterialTheme.colorScheme.outlineVariant, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Box(
                modifier = Modifier
                    .size(9.dp)
                    .clip(CircleShape)
                    .background(swatchAccent),
            )
        }
        Spacer(Modifier.width(12.dp))
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f),
        )
        RadioButton(selected = selected, onClick = onChoose)
    }
}
