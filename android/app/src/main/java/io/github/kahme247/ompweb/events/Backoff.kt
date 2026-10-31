package io.github.kahme247.ompweb.events

import kotlin.random.Random

/**
 * Exponential backoff with jitter for event-stream reconnects: 1 s, 2 s, 4 s
 * … capped at 30 s, with ±20 % jitter so a fleet of clients that lost a server
 * at the same moment does not reconnect in lockstep.
 */
class Backoff(
    private val baseMillis: Long = 1_000,
    private val maxMillis: Long = 30_000,
    private val jitterRatio: Double = 0.2,
    private val random: Random = Random.Default,
) {
    fun delayMillis(attempt: Int): Long {
        var capped = baseMillis
        repeat(attempt.coerceIn(0, 30)) {
            capped = (capped * 2).coerceAtMost(maxMillis)
        }
        val factor = 1.0 + (random.nextDouble() * 2 - 1) * jitterRatio
        return (capped * factor).toLong().coerceIn(1, maxMillis)
    }
}
