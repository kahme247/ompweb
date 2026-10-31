package io.github.kahme247.ompweb.domain

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull

/**
 * Context/usage arithmetic and formatting for the composer ring and its detail
 * sheet, ported from `components/ChatInput.tsx` (ring, ring title, usage-limit
 * label, compact result) and `components/ComposerPanels.tsx`
 * (`ContextDetailPanel`), plus `lib/format.ts`.
 */

/** omp's context totals (`contextUsage`): a single total, no per-category split. */
data class ContextUsageInfo(
    val tokens: Int?,
    val contextWindow: Int,
    val percent: Double?,
)

/** A catalog row's capacity, shown next to the window in the detail sheet. */
data class ModelCapacity(val contextWindow: Int?, val maxTokens: Int?)

/** Ring tone thresholds: warning past 70 %, error past 90 %. */
enum class ContextTone { NORMAL, WARNING, ERROR }

fun contextTone(percent: Double?): ContextTone = when {
    percent == null -> ContextTone.NORMAL
    percent > 90 -> ContextTone.ERROR
    percent > 70 -> ContextTone.WARNING
    else -> ContextTone.NORMAL
}

/** `formatPercent`: one stable decimal, `.` as the separator like the web. */
fun formatPercent(percent: Double): String = String.format(Locale.US, "%.1f%%", percent)

/** `formatCompactNumber`: `1.2M`, `34k`, `999`. */
fun formatTokenCount(tokens: Long): String = when {
    tokens >= 1_000_000 -> String.format(Locale.US, "%.1fM", tokens / 1_000_000.0)
    tokens >= 1_000 -> "${Math.round(tokens / 1_000.0)}k"
    else -> tokens.toString()
}

fun formatTokenCount(tokens: Int): String = formatTokenCount(tokens.toLong())

/** The same compaction for a raw count (tool headers, context rows). */
fun formatCompactNumber(value: Double): String =
    if (value.isFinite()) formatTokenCount(Math.round(value)) else "0"

/** Token count as the chips show it (`2.2k`, `999k`); null when not meaningful. */
fun formatTokens(tokens: Long?): String? {
    if (tokens == null || tokens <= 0) return null
    if (tokens >= 1000) {
        // 0 decimals from 10k up, one below; JS toFixed rounds half away from zero.
        val fixed = if (tokens >= 10_000) {
            Math.round(tokens / 1000.0).toString()
        } else {
            formatDecimal(tokens / 1000.0)
        }
        return fixed + "k"
    }
    return tokens.toString()
}

fun formatTokens(tokens: Int?): String? = formatTokens(tokens?.toLong())

/** `42s` / `7m`; null below a second or when absent. */
fun formatDuration(ms: Long?): String? {
    if (ms == null || ms <= 0 || ms < 1_000) return null
    if (ms < 60_000) return "${ms / 1000}s"
    return "${Math.round(ms / 60_000.0)}m"
}

private val THINKING_SUFFIX = Regex(":(off|minimal|low|medium|high|xhigh|max)$")

/** Last path segment of a `provider/model:thinking` string. */
fun shortModel(model: String?): String? {
    if (model.isNullOrEmpty()) return null
    val id = model.substringAfterLast('/')
    return id.replace(THINKING_SUFFIX, "").ifEmpty { null }
}

/** `provider/model` of a `provider/model:thinking` string. */
fun fullModel(model: String?): String? {
    if (model.isNullOrEmpty()) return null
    return model.replace(THINKING_SUFFIX, "").ifEmpty { null }
}

/** Thinking level suffix of a `provider/model:thinking` string. */
fun modelEffort(model: String?): String? {
    if (model == null) return null
    return THINKING_SUFFIX.find(model)?.groupValues?.getOrNull(1)
}

/** `formatCost`: `$0.0123` under a cent, `$1.20` above it; null when there is nothing to show. */
fun formatCost(cost: Double?): String? {
    if (cost == null || !cost.isFinite() || cost <= 0.0) return null
    return String.format(Locale.US, if (cost < 0.01) "$%.4f" else "$%.2f", cost)
}

/** Cache hit rate: `cacheRead / (input + cacheRead) * 100`, null when the denominator is 0. */
fun cacheHitRate(input: Int, cacheRead: Int): Double? {
    val denominator = input.toLong() + cacheRead
    return if (denominator > 0) cacheRead.toDouble() / denominator * 100.0 else null
}

/** omp's allowance percentage as the badge prints it (`42`, `42.5`). */
fun formatAllowancePercent(percent: Double): String =
    if (percent % 1.0 == 0.0) percent.toInt().toString() else String.format(Locale.US, "%.1f", percent)

/**
 * omp's structured provider usage-limit state (`WebSessionState.usageLimit`):
 * `low_priority` while the provider serves below normal priority, `wrap_up`
 * once the limit is reached.
 */
data class UsageLimit(
    val stage: Stage,
    val resetsAtSec: Long? = null,
    val allowanceLeftPercent: Double? = null,
    val extraUsage: Boolean = false,
) {
    enum class Stage { LOW_PRIORITY, WRAP_UP }
}

/** The label variants of `formatUsageLimitLabel`, with the absolute reset instant instead of text. */
sealed interface UsageLimitLabel {
    data class LowPriority(val resetAtMillis: Long?, val allowancePercent: Double?) : UsageLimitLabel

    data class WrapUp(val resetAtMillis: Long?, val extraUsage: Boolean) : UsageLimitLabel
}

/**
 * A reset time we can actually put on screen, or null when omp gave us none.
 * omp may omit the field or send a non-number, and a reset already in the past
 * would render a plausible but wrong clock — both are worse than saying no time
 * at all, because the user would plan around them.
 */
fun usableSlowModeResetTime(resetsAtSec: Long?, nowMillis: Long): Long? {
    if (resetsAtSec == null) return null
    val resetAtMillis = resetsAtSec * 1000
    return if (resetAtMillis <= nowMillis) null else resetAtMillis
}

private const val SLOW_MODE_SAME_DAY_MILLIS: Long = 20 * 3_600_000L

/**
 * `formatSlowModeResetClock`: today's clock time, or weekday + time when the
 * reset is more than 20 hours away.
 */
fun formatSlowModeResetClock(
    resetsAtMillis: Long,
    nowMillis: Long,
    zone: ZoneId = ZoneId.systemDefault(),
    locale: Locale = Locale.getDefault(),
): String {
    val pattern = if (resetsAtMillis - nowMillis > SLOW_MODE_SAME_DAY_MILLIS) "EEE HH:mm" else "HH:mm"
    val formatter = DateTimeFormatter.ofPattern(pattern, locale).withZone(zone)
    return formatter.format(Instant.ofEpochMilli(resetsAtMillis))
}

fun usageLimitLabel(limit: UsageLimit, nowMillis: Long): UsageLimitLabel {
    val resetAtMillis = usableSlowModeResetTime(limit.resetsAtSec, nowMillis)
    return when (limit.stage) {
        UsageLimit.Stage.LOW_PRIORITY ->
            UsageLimitLabel.LowPriority(resetAtMillis, limit.allowanceLeftPercent)

        UsageLimit.Stage.WRAP_UP ->
            UsageLimitLabel.WrapUp(resetAtMillis, limit.extraUsage)
    }
}

/** One compacted turn (`CompactResultInfo`), from a `compact` answer or `auto_compaction_end`. */
data class CompactResult(
    val reason: String,
    val tokensBefore: Int,
    val estimatedTokensAfter: Int,
) {
    /** Tokens the compaction saved (never negative when the estimate grows). */
    val savedTokens: Int get() = maxOf(0, tokensBefore - estimatedTokensAfter)
}

/**
 * `readCompactResult`: the server estimates `estimatedTokensAfter` from the
 * summary when omp's `CompactionResult` omits it; nothing usable without
 * `tokensBefore`.
 */
fun readCompactResult(element: JsonElement?, reason: String): CompactResult? {
    val root = element as? JsonObject ?: return null
    val before = (root["tokensBefore"] as? JsonPrimitive)?.intOrNull ?: return null
    val after = (root["estimatedTokensAfter"] as? JsonPrimitive)?.intOrNull ?: 0
    return CompactResult(reason = reason, tokensBefore = before, estimatedTokensAfter = after)
}

/** `SessionStatsInfo` token totals. */
data class SessionTokenTotals(
    val input: Int = 0,
    val output: Int = 0,
    val cacheRead: Int = 0,
    val cacheWrite: Int = 0,
    val total: Int = 0,
)

/** `SessionStatsInfo` as the context sheet renders it (`get_session_stats`). */
data class SessionStats(
    val sessionId: String = "",
    val sessionFile: String? = null,
    val sessionName: String? = null,
    val userMessages: Int = 0,
    val assistantMessages: Int = 0,
    val toolCalls: Int = 0,
    val toolResults: Int = 0,
    val totalMessages: Int = 0,
    val tokens: SessionTokenTotals = SessionTokenTotals(),
    val cost: Double = 0.0,
    val contextUsage: ContextUsageInfo? = null,
)

/** Parse `contextUsage` (`{tokens, contextWindow, percent}`); null when omp reports none. */
fun parseContextUsage(element: JsonElement?): ContextUsageInfo? {
    val root = element as? JsonObject ?: return null
    val window = (root["contextWindow"] as? JsonPrimitive)?.intOrNull ?: return null
    val tokens = (root["tokens"] as? JsonPrimitive)?.intOrNull
    val percent = (root["percent"] as? JsonPrimitive)?.doubleOrNull
    return ContextUsageInfo(tokens = tokens, contextWindow = window, percent = percent)
}
