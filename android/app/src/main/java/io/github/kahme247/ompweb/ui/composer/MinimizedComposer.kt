package io.github.kahme247.ompweb.ui.composer

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors

/**
 * The chevron above the composer that collapses it into the one-line pill
 * (web `ChatWindow` minimized-composer toggle). An [IconButton], so the touch
 * target is the platform's 48 dp even though the glyph is 16 dp.
 */
@Composable
internal fun MinimizeComposerButton(onMinimize: () -> Unit, modifier: Modifier = Modifier) {
    val colors = LocalOmpColors.current
    Box(modifier = modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        IconButton(onClick = onMinimize) {
            Icon(
                imageVector = Icons.Filled.KeyboardArrowDown,
                contentDescription = stringResource(R.string.composer_minimize),
                tint = colors.textDim,
                modifier = Modifier.size(16.dp),
            )
        }
    }
}

/**
 * The slim bar that replaces the full composer while minimized (web
 * `MinimizedComposerBar`): one line with the running status or the draft
 * preview, an expand action and Stop while the agent is running.
 */
@Composable
internal fun MinimizedComposerBar(
    draftPreview: String,
    hasAttachments: Boolean,
    placeholder: String,
    statusText: String?,
    streaming: Boolean,
    onExpand: () -> Unit,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalOmpColors.current
    Surface(
        modifier = modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp),
        color = colors.background,
        contentColor = colors.text,
        shape = RoundedCornerShape(10.dp),
        border = BorderStroke(1.dp, colors.border),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .clickable(onClick = onExpand)
                    // One TalkBack focus stop: expand label + status/preview.
                    .semantics(mergeDescendants = true) {}
                    .padding(start = 12.dp, end = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(
                    imageVector = Icons.Filled.KeyboardArrowUp,
                    contentDescription = stringResource(R.string.composer_expand),
                    tint = colors.textDim,
                    modifier = Modifier.size(16.dp),
                )
                Text(
                    text = statusText ?: draftPreview.ifBlank { placeholder },
                    color = if (statusText == null && draftPreview.isNotBlank()) colors.text else colors.textMuted,
                    fontSize = 13.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (hasAttachments) {
                    Text(
                        text = stringResource(R.string.composer_minimized_attachments),
                        color = colors.textDim,
                        fontSize = 11.sp,
                        maxLines = 1,
                    )
                }
            }
            if (streaming) {
                TextButton(onClick = onStop, modifier = Modifier.heightIn(min = 48.dp).padding(end = 6.dp)) {
                    Text(stringResource(R.string.chat_stop), fontSize = 11.sp, color = colors.accent)
                }
            }
        }
    }
}
