package io.github.kahme247.ompweb.chat

import java.util.Locale
import kotlin.math.roundToLong

/**
 * The generation rate of one finished assistant message, derived from omp's
 * own bookkeeping (`usage.output`, `duration`, `ttft`, `completedAt`).
 *
 * [spanMs] is the net generation time: time to first token is excluded, so the
 * value describes the speed at which the model produced the answer, not how
 * long the request waited.
 */
data class MessageSpeed(
    val tokensPerSecond: Double,
    val outputTokens: Int,
    val spanMs: Long,
)

/** Below this net generation span a rate is noise (omp's `MIN_DURATION_MS`). */
const val MIN_MESSAGE_SPAN_MS = 100L

/** Live estimate: sliding window over the streamed token estimate. */
const val STREAM_WINDOW_MS = 3_000L

/** The window needs this much wall time before it may show a value. */
const val STREAM_MIN_SPAN_MS = 700L

/** And this many estimated tokens (fewer would amplify jitter). */
const val STREAM_MIN_TOKENS = 12.0

/** No delta for this long means the stream is not producing: hide the rate. */
const val STREAM_STALE_MS = 2_000L

/** The UI is refreshed at most this often (2×/s), regardless of delta rate. */
const val STREAM_RATE_PUBLISH_MS = 500L

private const val STREAM_MAX_SAMPLES = 256

/**
 * The final rate of [message], or null when the data cannot carry an honest
 * number (error, empty output, sub-100 ms generation, missing timestamps).
 */
fun messageSpeed(message: ChatMessage.Assistant): MessageSpeed? {
    if (message.stopReason == "error") return null
    val output = message.usageOutput ?: return null
    if (output <= 0) return null
    val duration = message.durationMs?.takeIf { it.isFinite() && it > 0.0 }
    val ttft = message.ttftMs?.takeIf { it.isFinite() && it >= 0.0 }
    val completedAt = message.completedAt
    val timestamp = message.timestamp
    val span = when {
        duration != null && ttft != null && ttft < duration -> duration - ttft
        duration != null -> duration
        completedAt != null && timestamp != null && completedAt > timestamp ->
            (completedAt - timestamp).toDouble()
        else -> return null
    }
    if (!span.isFinite() || span < MIN_MESSAGE_SPAN_MS) return null
    val rate = output * 1000.0 / span
    if (!rate.isFinite() || rate <= 0.0) return null
    return MessageSpeed(tokensPerSecond = rate, outputTokens = output, spanMs = span.roundToLong())
}

/**
 * Estimated tokens of a streaming snapshot: ASCII code points count a quarter,
 * every other code point counts one. It is a deliberately cheap stand-in for a
 * tokenizer; the committed `usage.output` corrects it at the end of the
 * message. Tool-call JSON is not counted (bursty, expensive to measure).
 */
fun estimateStreamTokens(blocks: List<AssistantBlock>): Double {
    var ascii = 0
    var wide = 0
    for (block in blocks) {
        val text = when (block) {
            is AssistantBlock.Text -> block.text
            is AssistantBlock.Thinking -> block.thinking
            else -> null
        } ?: continue
        var index = 0
        while (index < text.length) {
            val codePoint = text.codePointAt(index)
            if (codePoint <= 0x7F) ascii++ else wide++
            index += Character.charCount(codePoint)
        }
    }
    return ascii / 4.0 + wide
}

/**
 * Turns the growing token estimate of one streaming message into a rate.
 *
 * The first observation starts the window, so the time to first token never
 * dilutes the number. A regression (new message, retry, reconnect) starts
 * over from the new value.
 */
class StreamRateTracker(
    private val windowMs: Long = STREAM_WINDOW_MS,
    private val minSpanMs: Long = STREAM_MIN_SPAN_MS,
    private val minTokens: Double = STREAM_MIN_TOKENS,
    private val staleMs: Long = STREAM_STALE_MS,
) {
    private data class Sample(val at: Long, val tokens: Double)

    /** Cumulative estimates, oldest first; bounded to [STREAM_MAX_SAMPLES]. */
    private val samples = ArrayDeque<Sample>()

    /** Feed one snapshot; [totalTokens] counts from the start of the message. */
    fun observe(totalTokens: Double, at: Long) {
        if (!totalTokens.isFinite() || totalTokens <= 0.0) return
        val last = samples.lastOrNull()
        if (last != null && at <= last.at) return
        // No new tokens: keep the original delta timestamp, so a stalled
        // stream ages out instead of being kept alive by repeated polls
        // (web `StreamRateTracker.observe`).
        if (last != null && totalTokens == last.tokens) return
        if (last != null && totalTokens < last.tokens) samples.clear()
        samples.addLast(Sample(at, totalTokens))
        while (samples.size > STREAM_MAX_SAMPLES) samples.removeFirst()
    }

    /** The rate at [at], or null while it is not measurable (yet/anymore). */
    fun rate(at: Long): Double? {
        val newest = samples.lastOrNull() ?: return null
        if (at - newest.at > staleMs) return null
        val cutoff = at - windowMs
        var anchor = samples.first()
        for (sample in samples) {
            if (sample.at > cutoff) break
            anchor = sample
        }
        val span = newest.at - anchor.at
        if (span < minSpanMs) return null
        val delta = newest.tokens - anchor.tokens
        if (delta < minTokens) return null
        val rate = delta * 1000.0 / span
        if (!rate.isFinite() || rate <= 0.0) return null
        return rate
    }

    fun reset() {
        samples.clear()
    }
}

/** `39.7627` → `"39.8"`; the locale-independent one-decimal form of a rate. */
fun formatGenerationRate(rate: Double): String = String.format(Locale.US, "%.1f", rate)
