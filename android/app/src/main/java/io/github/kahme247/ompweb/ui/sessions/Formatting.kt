package io.github.kahme247.ompweb.ui.sessions

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.res.stringResource
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.net.SessionSummary
import java.time.Duration
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** `name`, else the first line of the first user message, else `null`. */
internal fun SessionSummary.title(): String? {
    val named = name?.trim()?.takeIf { it.isNotEmpty() }
    if (named != null) return named
    return firstMessage.lineSequence()
        .map { it.trim() }
        .firstOrNull { it.isNotEmpty() }
        ?.let { if (it.length > 120) it.take(117) + "..." else it }
}

internal fun parseTimestamp(value: String): Instant? = try {
    Instant.parse(value)
} catch (_: Exception) {
    try {
        OffsetDateTime.parse(value).toInstant()
    } catch (_: Exception) {
        null
    }
}

internal fun absoluteDate(instant: Instant): String = DateTimeFormatter
    .ofPattern("d MMM yyyy", Locale.getDefault())
    .format(instant.atZone(ZoneId.systemDefault()))

@Composable
internal fun relativeTime(modified: String, now: Instant): String? {
    val instant = remember(modified) { parseTimestamp(modified) } ?: return null
    val seconds = Duration.between(instant, now).seconds.coerceAtLeast(0)
    return when {
        seconds < 60 -> stringResource(R.string.time_just_now)
        seconds < 3_600 -> stringResource(R.string.time_minutes_ago, seconds / 60)
        seconds < 86_400 -> stringResource(R.string.time_hours_ago, seconds / 3_600)
        seconds < 7 * 86_400 -> stringResource(R.string.time_days_ago, seconds / 86_400)
        else -> remember(instant) { absoluteDate(instant) }
    }
}

/** Compact human size for archive rows. */
internal fun formatBytes(bytes: Long): String {
    if (bytes < 1024) return "$bytes B"
    val units = listOf("KB", "MB", "GB")
    var value = bytes.toDouble() / 1024
    var unitIndex = 0
    while (value >= 1024 && unitIndex < units.lastIndex) {
        value /= 1024
        unitIndex++
    }
    return String.format(Locale.US, "%.1f %s", value, units[unitIndex])
}
