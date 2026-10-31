package io.github.kahme247.ompweb.ui.sessions

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpAlertDialog

/**
 * "You have unsent drafts" prompt shown when the user leaves the app (B7).
 * Stay is the safe default; Leave finishes the activity.
 */
@Composable
internal fun ExitDraftDialog(
    draftCount: Int,
    onStay: () -> Unit,
    onLeave: () -> Unit,
) {
    OmpAlertDialog(
        onDismissRequest = onStay,
        text = { ExitDraftContent(draftCount = draftCount, onStay = onStay, onLeave = onLeave) },
        // Both actions live in the body so the confirm surface is one
        // capturable composable (a dialog window is not, B7's golden).
        confirmButton = {},
    )
}

/**
 * The prompt as one composable: title, draft count and both actions, in the
 * web's order (Leave before the safe Stay). Extracted from the dialog for the
 * `shell-exit-confirm` golden — same seam as `ArchiveBrowserContent`.
 */
@Composable
internal fun ExitDraftContent(
    draftCount: Int,
    onStay: () -> Unit,
    onLeave: () -> Unit,
) {
    val colors = LocalOmpColors.current
    Column(modifier = Modifier.fillMaxWidth()) {
        Text(
            text = stringResource(R.string.composer_drafts_title),
            style = MaterialTheme.typography.titleLarge,
            color = colors.text,
        )
        Spacer(Modifier.height(12.dp))
        Text(
            text = stringResource(R.string.composer_drafts_body, draftCount),
            style = MaterialTheme.typography.bodyMedium,
            color = colors.textMuted,
        )
        Spacer(Modifier.height(16.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.End,
        ) {
            TextButton(onClick = onLeave) {
                Text(stringResource(R.string.composer_drafts_leave))
            }
            TextButton(onClick = onStay) {
                Text(stringResource(R.string.composer_drafts_stay))
            }
        }
    }
}
