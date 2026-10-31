package io.github.kahme247.ompweb.notify

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout

/**
 * Order of the sign-out / server-switch teardown for a registered notification
 * device.
 *
 * The unregister PUT has to run while the old session cookie and origin still
 * exist, and it must have finished (or timed out) *before* anything clears
 * them — otherwise the server keeps pushing to a device whose answer endpoint
 * no longer authenticates, or the PUT lands on the next installation. The
 * local identity is forgotten afterwards.
 *
 * Kept free of Android types so JVM tests can assert the order.
 */
class NotificationTeardown(
    private val timeoutMillis: Long = DEFAULT_TIMEOUT_MILLIS,
) {

    /**
     * Runs [unregister] with a bounded wait, then [forgetIdentity]. A failed
     * or timed-out unregister never blocks the sign-out: the device id is
     * forgotten locally either way, so this installation cannot answer again.
     */
    suspend fun run(
        unregister: suspend () -> Unit,
        forgetIdentity: suspend () -> Unit,
    ) {
        try {
            withTimeout(timeoutMillis) { unregister() }
        } catch (_: TimeoutCancellationException) {
            // Offline server: sign-out must not hang on it.
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // Already unauthorized or offline: nothing left to unregister.
        }
        forgetIdentity()
    }

    companion object {
        /** Long enough for a slow Tailscale round trip, short enough for a sign-out. */
        const val DEFAULT_TIMEOUT_MILLIS = 3_000L
    }
}
