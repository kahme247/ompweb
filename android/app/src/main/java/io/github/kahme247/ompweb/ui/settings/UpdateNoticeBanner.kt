package io.github.kahme247.ompweb.ui.settings

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.UpdateKind
import io.github.kahme247.ompweb.domain.UpdateNoticeState
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors

/**
 * Font scale above which the summary may wrap to a second line. Below it the
 * single line keeps the banner at the touch-target height; at 1.5×/2.0× the
 * version needs the room.
 */
private const val TWO_LINE_FONT_SCALE = 1.25f

/**
 * The shell-level update announcement (web `AppShell.tsx:357-374`: a toast
 * keyed by version). The host renders it above its content when the notice's
 * [UpdateNoticeState.visible] says so; "Details" opens Settings → System and
 * the dismiss icon hides this version until a newer one appears.
 *
 * The target version leads the summary and the constant title follows it, so
 * an ellipsis at the end of a narrow row can only eat the title — never the
 * version, which is the news. One line normally; from a large font scale on
 * the text may use a second line instead of clipping the version (200 %
 * requirement, Phase 11). One line plus the two actions otherwise, with the
 * icon button and the tight content padding leaving the row's height to the
 * theme's minimum touch target. The live region sits on the text itself: the
 * surface node has no text of its own, so an announcement from there would
 * depend on a child merge that TalkBack does not guarantee.
 *
 * Cross-package interface (gaps.md D1): `OmpWebRoot` owns the single call site
 * and the navigation to the System tab; this composable owns only the look.
 */
@Composable
fun UpdateNoticeBanner(
    state: UpdateNoticeState?,
    onOpenSettings: () -> Unit,
    onDismiss: (UpdateNoticeState) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (state == null || !state.visible) return
    val colors = LocalOmpColors.current
    val title = stringResource(
        if (state.kind == UpdateKind.APP) {
            R.string.update_banner_app_title
        } else {
            R.string.update_banner_omp_title
        },
    )
    val version = stringResource(
        R.string.update_banner_version,
        state.currentVersion ?: "?",
        state.availableVersion,
    )
    val summary = buildAnnotatedString {
        withStyle(SpanStyle(color = colors.text, fontWeight = FontWeight.Medium)) { append(version) }
        append("  ")
        withStyle(SpanStyle(color = colors.textMuted)) { append(title) }
    }
    // At 200 % the version alone no longer fits beside the two actions; the
    // second line keeps it whole instead of ellipsizing it away.
    val maxLines = if (LocalDensity.current.fontScale > TWO_LINE_FONT_SCALE) 2 else 1
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .testTag("update-notice-banner"),
        color = colors.panel,
        border = BorderStroke(1.dp, colors.accent),
        shape = RoundedCornerShape(12.dp),
    ) {
        Row(
            modifier = Modifier.padding(start = 12.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = summary,
                style = MaterialTheme.typography.bodySmall,
                maxLines = maxLines,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .weight(1f)
                    .testTag("update-notice-summary")
                    .semantics { liveRegion = LiveRegionMode.Polite },
            )
            TextButton(
                onClick = onOpenSettings,
                contentPadding = PaddingValues(horizontal = 10.dp),
            ) {
                Text(
                    text = stringResource(R.string.update_banner_action_details),
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.accent,
                )
            }
            IconButton(onClick = { onDismiss(state) }) {
                Icon(
                    imageVector = Icons.Filled.Close,
                    contentDescription = stringResource(R.string.update_banner_dismiss),
                    tint = colors.textMuted,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }
}
