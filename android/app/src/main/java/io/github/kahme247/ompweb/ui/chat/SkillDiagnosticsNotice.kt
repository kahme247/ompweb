package io.github.kahme247.ompweb.ui.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.SkillDiagnostic
import io.github.kahme247.ompweb.domain.SkillDiagnosticReason
import io.github.kahme247.ompweb.domain.SkillDiagnosticsSnapshot
import io.github.kahme247.ompweb.domain.SkillEntry
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpDialog

/** Why the last startup-notice change failed (the notice shows the reason inline). */
enum class SkillDiagnosticsFailure { Overridden, SaveFailed, Unavailable }

/**
 * Startup notice for conflicting or redundant skills (web
 * `SkillDiagnosticsNotice`): one line above the panels, a details dialog, and
 * Turn off / Dismiss. Dismissal hides this exact report for the session; a
 * changed report shows again.
 */
@Composable
internal fun SkillDiagnosticsNotice(
    snapshot: SkillDiagnosticsSnapshot?,
    saving: Boolean,
    failure: SkillDiagnosticsFailure?,
    onDisable: () -> Unit,
) {
    if (snapshot == null) return
    val colors = LocalOmpColors.current
    val reportKey = remember(snapshot) { skillDiagnosticsReportKey(snapshot) }
    var dismissedKey by rememberSaveable { mutableStateOf<String?>(null) }
    var open by remember { mutableStateOf(false) }
    val conflicts = snapshot.conflictCount
    val duplicates = snapshot.duplicateCount
    val visible = snapshot.showStartupDiagnostics && (conflicts > 0 || duplicates > 0) &&
        dismissedKey != reportKey
    if (!visible) return
    val summary = buildList {
        if (conflicts > 0) {
            add(
                if (conflicts == 1) {
                    stringResource(R.string.skill_diag_conflicts_one, conflicts)
                } else {
                    stringResource(R.string.skill_diag_conflicts_other, conflicts)
                },
            )
        }
        if (duplicates > 0) {
            add(
                if (duplicates == 1) {
                    stringResource(R.string.skill_diag_duplicates_one, duplicates)
                } else {
                    stringResource(R.string.skill_diag_duplicates_other, duplicates)
                },
            )
        }
    }.joinToString(" · ")
    val tone = if (conflicts > 0) colors.statusWarning else colors.textMuted
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 8.dp)
            // Web `role="status" aria-live="polite"`.
            .semantics { liveRegion = LiveRegionMode.Polite },
        color = colors.backgroundSubtle,
        contentColor = tone,
        shape = RoundedCornerShape(10.dp),
        border = BorderStroke(1.dp, colors.border),
    ) {
        Column(Modifier.padding(start = 12.dp, end = 6.dp, top = 6.dp, bottom = 6.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(
                    imageVector = if (conflicts > 0) Icons.Filled.Warning else Icons.Filled.Info,
                    contentDescription = null,
                    tint = tone,
                    modifier = Modifier.size(14.dp),
                )
                Text(
                    text = summary,
                    color = tone,
                    fontSize = 11.5.sp,
                    modifier = Modifier.weight(1f),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                TextButton(onClick = { open = true }, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text(stringResource(R.string.skill_diag_details), fontSize = 11.sp)
                }
                TextButton(
                    onClick = onDisable,
                    enabled = !saving,
                    modifier = Modifier.heightIn(min = 48.dp),
                ) {
                    Text(
                        text = if (saving) {
                            stringResource(R.string.skill_diag_saving)
                        } else {
                            stringResource(R.string.skill_diag_disable)
                        },
                        fontSize = 11.sp,
                    )
                }
                Spacer(Modifier.weight(1f))
                IconButton(onClick = { dismissedKey = reportKey }) {
                    Icon(
                        imageVector = Icons.Filled.Close,
                        contentDescription = stringResource(R.string.skill_diag_dismiss),
                        tint = colors.textMuted,
                        modifier = Modifier.size(14.dp),
                    )
                }
            }
            if (failure != null) {
                Text(
                    text = stringResource(
                        when (failure) {
                            SkillDiagnosticsFailure.Overridden -> R.string.skill_diag_overridden
                            SkillDiagnosticsFailure.SaveFailed -> R.string.skill_diag_save_failed
                            SkillDiagnosticsFailure.Unavailable -> R.string.skill_diag_unavailable
                        },
                    ),
                    color = colors.statusError,
                    fontSize = 11.sp,
                )
            }
        }
    }
    if (open) {
        OmpDialog(onDismissRequest = { open = false }) {
            SkillDiagnosticsBody(snapshot = snapshot, onDismiss = { open = false })
        }
    }
}

/**
 * The diagnostics dialog's content without the dialog window, so the hardened
 * matrix can render it at 200 % font (dialogs use their own window).
 */
@Composable
internal fun SkillDiagnosticsBody(snapshot: SkillDiagnosticsSnapshot, onDismiss: () -> Unit) {
    val colors = LocalOmpColors.current
    Surface(
        color = colors.panel,
        contentColor = colors.text,
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, colors.border),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier
                .heightIn(max = 520.dp)
                .verticalScroll(rememberScrollState())
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = stringResource(R.string.skill_diag_title),
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .weight(1f)
                        .semantics { heading() },
                )
                IconButton(onClick = onDismiss) {
                    Icon(
                        imageVector = Icons.Filled.Close,
                        contentDescription = stringResource(R.string.skill_diag_close),
                        tint = colors.textMuted,
                        modifier = Modifier.size(16.dp),
                    )
                }
            }
            Text(
                text = displayText(snapshot.cwd),
                color = colors.textDim,
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
            )
            if (snapshot.diagnostics.isEmpty()) {
                Text(
                    text = stringResource(R.string.skill_diag_clean),
                    color = colors.textMuted,
                    fontSize = 12.sp,
                )
            } else {
                snapshot.diagnostics.forEach { diagnostic ->
                    DiagnosticSection(diagnostic)
                }
                Text(
                    text = stringResource(R.string.skill_diag_lineage),
                    color = colors.textMuted,
                    fontSize = 11.sp,
                )
            }
        }
    }
}

@Composable
private fun DiagnosticSection(diagnostic: SkillDiagnostic) {
    val colors = LocalOmpColors.current
    val selected = diagnostic.skills.firstOrNull { it.name == diagnostic.name }
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = colors.backgroundSubtle,
        shape = RoundedCornerShape(8.dp),
        border = BorderStroke(1.dp, colors.border),
    ) {
        Column(
            modifier = Modifier.padding(10.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                text = displayText(diagnostic.name),
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
            )
            if (selected != null) {
                DiagnosticEntry(stringResource(R.string.skill_diag_default), selected)
                Text(
                    text = stringResource(reasonText(diagnostic.reason)),
                    color = colors.textMuted,
                    fontSize = 11.sp,
                )
            } else {
                Text(
                    text = stringResource(R.string.skill_diag_no_default),
                    color = colors.textMuted,
                    fontSize = 11.sp,
                )
            }
            diagnostic.skills.filter { it !== selected }.forEach { entry ->
                DiagnosticEntry(stringResource(R.string.skill_diag_variant), entry)
            }
            diagnostic.duplicates.forEach { duplicate ->
                DiagnosticEntry(stringResource(R.string.skill_diag_redundant), duplicate.skill)
                Text(
                    text = stringResource(
                        R.string.skill_diag_retained,
                        displayText(duplicate.retained.name),
                        displayText(duplicate.retained.filePath),
                    ),
                    color = colors.textDim,
                    fontSize = 11.sp,
                )
            }
        }
    }
}

@Composable
private fun DiagnosticEntry(label: String, entry: SkillEntry) {
    val colors = LocalOmpColors.current
    Column(Modifier.fillMaxWidth()) {
        Row {
            Text(text = "$label: ", color = colors.textMuted, fontSize = 11.sp, fontWeight = FontWeight.Medium)
            Text(
                text = displayText(entry.name),
                color = colors.text,
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
            )
        }
        Text(
            text = displayText(entry.filePath),
            color = colors.textMuted,
            fontSize = 11.sp,
            fontFamily = FontFamily.Monospace,
        )
        Text(
            text = buildString {
                append(stringResource(R.string.skill_diag_source, displayText(entry.source)))
                entry.pluginName?.let { append(" · "); append(displayText(it)) }
            },
            color = colors.textDim,
            fontSize = 11.sp,
        )
    }
}

private fun reasonText(reason: SkillDiagnosticReason): Int = when (reason) {
    SkillDiagnosticReason.SOURCE_ORDER -> R.string.skill_diag_reason_source_order
    SkillDiagnosticReason.CUSTOM_DIRECTORY -> R.string.skill_diag_reason_custom_directory
    SkillDiagnosticReason.AUTHORED_OVER_INSTALLED -> R.string.skill_diag_reason_authored_over_installed
}

/**
 * Stable identity of one report: dismissal only hides the report the user saw.
 * Mirrors the web `JSON.stringify(snapshot.diagnostics)` key without JSON.
 */
private fun skillDiagnosticsReportKey(snapshot: SkillDiagnosticsSnapshot): String = buildString {
    for (diagnostic in snapshot.diagnostics) {
        append(diagnostic.name).append('|').append(diagnostic.reason.wireName).append('|')
        for (entry in diagnostic.skills) {
            append(entry.name).append('@').append(entry.filePath).append(';')
        }
        append('#')
        for (duplicate in diagnostic.duplicates) {
            append(duplicate.skill.filePath).append("->").append(duplicate.retained.filePath).append(';')
        }
        append('\n')
    }
}

/** Web `displayText`: strip control characters and bidi overrides from omp paths. */
private val CONTROL_CHARS = Regex("[\\p{Cc}\\u202a-\\u202e\\u2066-\\u2069]")

private fun displayText(value: String): String = value.replace(CONTROL_CHARS, "")
