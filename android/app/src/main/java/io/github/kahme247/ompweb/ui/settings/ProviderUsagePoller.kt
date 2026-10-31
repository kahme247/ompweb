package io.github.kahme247.ompweb.ui.settings

import io.github.kahme247.ompweb.net.ProviderUsageSnapshot
import io.github.kahme247.ompweb.net.SystemApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * The provider limits block's poll loop, shared by every observer in the
 * process instead of one per composition.
 *
 * The web polls `/api/provider-usage` on mount and every five minutes while
 * the view is visible. The full block sits in Settings and the sessions list
 * warns from the same data; both surfaces come and go, so a loop per surface
 * would multiply requests. This poller runs only while at least one subscriber
 * is attached ([subscribe] / [unsubscribe]) and each surface binds that to
 * `ON_START`/`ON_STOP`, so a backgrounded app stops polling and a resumed one
 * refreshes immediately.
 */
class ProviderUsagePoller(
    /** One `/api/provider-usage` request; `force` bypasses the server cache. */
    private val load: suspend (Boolean) -> ProviderUsageSnapshot,
    private val scope: CoroutineScope,
    val intervalMillis: Long = DEFAULT_INTERVAL_MS,
    /** The origin the requests currently go to; a snapshot from another one is stale. */
    private val origin: () -> String? = { null },
) {

    private val _state = MutableStateFlow(ProviderUsageState())
    val state: StateFlow<ProviderUsageState> = _state.asStateFlow()

    private val lock = Any()
    private var subscribers = 0
    private var loop: Job? = null
    private var inFlight: Job? = null

    /** Attaches one observer; the first one starts the loop with an immediate load. */
    fun subscribe() {
        synchronized(lock) {
            subscribers += 1
            if (loop == null) loop = scope.launch { runLoop() }
        }
    }

    /** Detaches one observer; the last one stops the loop (no requests while gone). */
    fun unsubscribe() {
        synchronized(lock) {
            subscribers = (subscribers - 1).coerceAtLeast(0)
            if (subscribers == 0) {
                loop?.cancel()
                loop = null
            }
        }
    }

    /** Loads now, e.g. after a pull-to-refresh or a manual retry. */
    fun refresh(force: Boolean = false) {
        synchronized(lock) {
            if (inFlight?.isActive == true) return
            inFlight = scope.launch { fetch(force) }
        }
    }

    /** Expands one account row; tapping it again collapses it (web `expandedKey`). */
    fun toggleExpanded(key: String) {
        _state.update { it.copy(expandedKey = if (it.expandedKey == key) null else key) }
    }

    private suspend fun runLoop() {
        while (currentCoroutineContext().isActive) {
            fetch(force = false)
            delay(intervalMillis)
        }
    }

    private suspend fun fetch(force: Boolean) {
        val requestedOrigin = origin()
        _state.update { it.copy(loading = true, error = false) }
        val result = runCatching { load(force) }
        _state.update { state ->
            // A request that started under another server must not land in
            // this one: the user switched while it was in flight.
            if (origin() != requestedOrigin) return@update state.copy(loading = false)
            state.copy(
                loading = false,
                snapshot = result.getOrNull() ?: state.snapshot,
                error = result.isFailure,
            )
        }
    }

    /**
     * Drops everything fetched from the previous server and abandons a request
     * still in flight; the next observer starts from an empty bar.
     */
    fun reset() {
        synchronized(lock) {
            inFlight?.cancel()
            inFlight = null
        }
        _state.value = ProviderUsageState()
    }

    companion object {
        const val DEFAULT_INTERVAL_MS: Long = 5 * 60_000L

        private val sharedScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

        @Volatile
        private var shared: ProviderUsagePoller? = null

        /**
         * The process-wide poller. One instance is enough because the system
         * API resolves its origin on every request; [origin] stamps a snapshot
         * with the server it came from.
         */
        fun shared(system: SystemApi, origin: () -> String?): ProviderUsagePoller = synchronized(this) {
            shared ?: ProviderUsagePoller(
                load = { force -> system.providerUsage(force) },
                scope = sharedScope,
                origin = origin,
            ).also { shared = it }
        }
    }
}
