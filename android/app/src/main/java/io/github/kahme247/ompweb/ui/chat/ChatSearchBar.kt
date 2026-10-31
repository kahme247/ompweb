package io.github.kahme247.ompweb.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors

/**
 * The in-chat search field under the chat's top bar (user feedback 25.10.):
 * query, hit count `3/17`, ↑/↓ stepping through the loaded transcript and the
 * way out to a search that also covers history the transcript does not hold.
 */
@Composable
internal fun ChatSearchBar(
    state: ChatSearchState,
    /** History exists that is not part of the loaded transcript (compaction view off). */
    olderHistoryHidden: Boolean,
    /** Tapping "search full history" only flips a view; disable while it loads. */
    fullHistoryBusy: Boolean,
    onQueryChange: (String) -> Unit,
    onStep: (Int) -> Unit,
    onClose: () -> Unit,
    onSearchFullHistory: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalOmpColors.current
    val focusRequester = remember { FocusRequester() }
    LaunchedEffect(Unit) { focusRequester.requestFocus() }
    val countText = when {
        state.total > 0 -> stringResource(R.string.chat_search_count, state.activeIndex + 1, state.total)
        state.query.isBlank() -> ""
        else -> stringResource(R.string.chat_search_no_hits)
    }
    Surface(
        color = colors.panel,
        contentColor = colors.text,
        shape = RoundedCornerShape(10.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, colors.border),
        modifier = modifier.fillMaxWidth().testTag("chat-search-bar"),
    ) {
        Column {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = Icons.Filled.Search,
                    contentDescription = null,
                    tint = colors.textDim,
                    modifier = Modifier.size(18.dp),
                )
                BasicTextField(
                    value = state.query,
                    onValueChange = onQueryChange,
                    singleLine = true,
                    textStyle = TextStyle(color = colors.text, fontSize = 14.sp, lineHeight = 20.sp),
                    cursorBrush = SolidColor(colors.accent),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = { onStep(1) }),
                    modifier = Modifier
                        .weight(1f)
                        .padding(horizontal = 8.dp)
                        .heightIn(min = 40.dp)
                        .focusRequester(focusRequester)
                        .testTag("chat-search-field"),
                    decorationBox = { inner ->
                        androidx.compose.foundation.layout.Box {
                            if (state.query.isEmpty()) {
                                Text(
                                    text = stringResource(R.string.chat_search_placeholder),
                                    color = colors.textDim,
                                    fontSize = 14.sp,
                                )
                            }
                            inner()
                        }
                    },
                )
                if (countText.isNotEmpty()) {
                    Text(
                        text = countText,
                        color = if (state.total > 0) colors.textMuted else colors.statusError,
                        fontSize = 12.sp,
                        modifier = Modifier
                            .padding(horizontal = 4.dp)
                            .testTag("chat-search-count"),
                    )
                }
                IconButton(
                    onClick = { onStep(-1) },
                    enabled = state.total > 0,
                ) {
                    Icon(
                        imageVector = Icons.Filled.KeyboardArrowUp,
                        contentDescription = stringResource(R.string.chat_search_previous),
                        modifier = Modifier.size(20.dp),
                    )
                }
                IconButton(
                    onClick = { onStep(1) },
                    enabled = state.total > 0,
                ) {
                    Icon(
                        imageVector = Icons.Filled.KeyboardArrowDown,
                        contentDescription = stringResource(R.string.chat_search_next),
                        modifier = Modifier.size(20.dp),
                    )
                }
                IconButton(onClick = onClose) {
                    Icon(
                        imageVector = Icons.Filled.Close,
                        contentDescription = stringResource(R.string.chat_search_close),
                        modifier = Modifier.size(20.dp),
                    )
                }
            }
            if (olderHistoryHidden && state.query.isNotBlank()) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(start = 10.dp, end = 6.dp, bottom = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        text = stringResource(R.string.chat_search_history_hidden),
                        color = colors.textDim,
                        fontSize = 11.5.sp,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = onSearchFullHistory, enabled = !fullHistoryBusy) {
                        Text(
                            text = stringResource(R.string.chat_search_full_history),
                            fontSize = 12.sp,
                        )
                    }
                }
            }
        }
    }
}

/** A row's search mark, so the transcript can paint matches without knowing the query. */
internal enum class ChatRowHighlight { None, Match, Active }
