package io.github.kahme247.ompweb.ui.composer.dictation

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.DictationState
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpMonoFontFamily

/**
 * The strip under the composer field while on-device recognition listens. The
 * field itself stays visible and receives the live transcript at its caret;
 * the strip only carries the state and the two exits: stop (keeps the text)
 * and cancel (removes the live text again).
 */
@Composable
fun LiveDictationStrip(
    state: DictationState.Live,
    onStop: () -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalOmpColors.current
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(top = 2.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(colors.statusError),
        )
        Text(
            text = stringResource(R.string.dictation_live_listening),
            style = MaterialTheme.typography.labelMedium,
            color = colors.textMuted,
        )
        Text(
            text = formatTime(state.elapsedMs),
            color = colors.text,
            fontFamily = OmpMonoFontFamily,
            fontSize = 12.sp,
        )
        Box(Modifier.weight(1f))
        TextButton(onClick = onStop) {
            Text(stringResource(R.string.dictation_live_stop), style = MaterialTheme.typography.labelLarge)
        }
        TextButton(onClick = onCancel) {
            Text(
                text = stringResource(R.string.dictation_live_cancel),
                style = MaterialTheme.typography.labelLarge,
                color = colors.statusError,
            )
        }
    }
}
