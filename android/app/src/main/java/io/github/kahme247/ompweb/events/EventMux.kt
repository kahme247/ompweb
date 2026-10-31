package io.github.kahme247.ompweb.events

import io.github.kahme247.ompweb.net.ApiError
import io.github.kahme247.ompweb.net.EventPostResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Whether the mux currently has a working stream. */
enum class ConnectionState { Connected, Reconnecting, Offline }

/** A subscription that the server refused (409) or dropped; delivered to its collectors. */
class EventSubscriptionException(
    val status: Int?,
    message: String,
) : Exception(message)

/**
 * The part of [EventMux] a view model needs, as a seam for JVM tests.
 *
 * Production always uses [EventMux]; `ChatViewModelTest` supplies a fake flow.
 */
interface SessionEventSource {
    val state: StateFlow<ConnectionState>

    fun subscribe(channel: EventChannel): Flow<JsonObject>
}

/**
 * One SSE connection per process to `/api/events`, with ref-counted
 * subscriptions.
 *
 * Subscriptions carry the stable id the server echoes as the SSE `event:`
 * name. After `hello`, every active subscription is POSTed; after a reconnect
 * the same ids are POSTed again on the new connection. An `end` control frame
 * means the server closed only that subscription (its watcher died): the
 * flow stays open and the subscription is POSTed again after
 * [RESUBSCRIBE_DELAY_MILLIS], as the protocol requires. Only a refusing answer
 * (409/403/404 with the channel's own code) ends that subscription's flow
 * with an error, never the connection. While no foreground service holds the
 * stream, it is foreground-only: five seconds after the app goes to the
 * background the connection is dropped, and it comes back on return. The
 * notification service calls [setPersistent] to keep exactly this one
 * connection alive in the background.
 */
class EventMux(
    private val transport: EventTransport,
    private val scope: CoroutineScope,
    private val backoff: Backoff = Backoff(),
    /**
     * Monotonic time base for the liveness/rate-limit guards. The app injects
     * `SystemClock.elapsedRealtime()` (it keeps counting through deep sleep); the
     * portable default keeps the class free of Android APIs so the JVM tests can
     * run a live mux.
     */
    private val clock: () -> Long = { System.nanoTime() / 1_000_000 },
) : SessionEventSource {

    private class ActiveSubscription(
        val channel: EventChannel,
        val id: String,
        val sinks: MutableSet<Channel<JsonObject>> = LinkedHashSet(),
    )

    private val lock = Any()
    private val active = LinkedHashMap<String, ActiveSubscription>()
    private val acknowledged = mutableSetOf<String>()
    private val subscribeMutex = Mutex()
    private var nextId = 1

    private var connectionJob: Job? = null
    private var backgroundJob: Job? = null
    private var connectionId: String? = null

    /**
     * Which [connectionLoop] owns the connection identity. `stopConnection()`
     * and every `connectNow()` bump it, so a loop that was replaced while it
     * blocked in a non-cancellable `open()` can never reset the identity of
     * the connection that replaced it.
     */
    private var loopGeneration = 0L

    /** Set by the notification service: backgrounding the app must not drop the stream. */
    private var persistent = false

    /** When the last connection attempt started; rate-limits network-triggered retries. */
    private var lastRetryAt: Long? = null

    /** When the last live frame arrived on the current connection (null = none yet). */
    @Volatile
    private var lastFrameAt: Long? = null

    /**
     * Bumped whenever the connection identity changes. A subscribe POST that
     * started under an older generation must never mark its subscription as
     * acknowledged on the newer connection.
     */
    private var connectionEpoch = 0L
    private var stream: EventStream? = null

    private val _state = MutableStateFlow(ConnectionState.Reconnecting)
    override val state: StateFlow<ConnectionState> = _state.asStateFlow()

    /**
     * Live frames of [channel]. Two collectors of the same channel share one
     * server subscription; the subscription is dropped with its last collector.
     * The flow stays open across an `end` frame (the mux resubscribes) and
     * throws [EventSubscriptionException] when the server refuses the
     * subscription.
     */
    override fun subscribe(channel: EventChannel): Flow<JsonObject> = flow {
        val sink = Channel<JsonObject>(
            capacity = 128,
            onBufferOverflow = BufferOverflow.DROP_OLDEST,
        )
        register(channel, sink)
        try {
            for (frame in sink) emit(frame)
        } finally {
            unregister(channel.key, sink)
        }
    }

    /** Called when the app returns to the foreground. */
    fun onForeground() {
        synchronized(lock) {
            backgroundJob?.cancel()
            backgroundJob = null
        }
        if (hasSubscriptions()) connectNow()
    }

    /** Called when the app leaves the foreground; disconnects after a grace period. */
    fun onBackground() {
        if (synchronized(lock) { persistent }) return
        if (!hasSubscriptions()) return
        synchronized(lock) {
            backgroundJob?.cancel()
            backgroundJob = scope.launch {
                delay(BACKGROUND_GRACE_MILLIS)
                stopConnection()
            }
        }
    }

    /**
     * The notification foreground service keeps the stream open while the app
     * is backgrounded. The service and the UI still share this one connection;
     * this only suspends the background disconnect.
     */
    fun setPersistent(active: Boolean) {
        synchronized(lock) {
            persistent = active
            if (active) {
                backgroundJob?.cancel()
                backgroundJob = null
            }
        }
        if (active && hasSubscriptions()) connectNow()
    }

    /** Drops the current connection and reconnects immediately (the banner's Retry). */
    fun retryNow() {
        stopConnection()
        if (hasSubscriptions()) connectNow()
    }

    /**
     * A default network became available (Wi-Fi after mobile data, Tailscale
     * roaming, airplane mode off). Half-open SSE sockets survive such a change
     * without an error, so the stream has to be reconnected instead of waiting
     * for the read timeout.
     *
     * Two guards keep this from becoming a reconnect storm: the call does
     * nothing without a subscription, and it fires at most once per
     * [MIN_NETWORK_RETRY_INTERVAL_MILLIS] (a network switch delivers several
     * `onAvailable` callbacks for the same event). A reconnect also never
     * happens on top of a live connection that just delivered a frame.
     */
    fun onNetworkAvailable() {
        if (!hasSubscriptions()) return
        val now = clock()
        // A frame that arrived moments ago proves the socket survived the
        // network change; reconnecting then would only add churn. Control
        // frames (hello/open/end) count as liveness too, so a connection that
        // just completed its handshake is not torn down on every `onAvailable`.
        val frameAt = lastFrameAt
        if (frameAt != null && now - frameAt < NETWORK_LIVENESS_MILLIS) return
        synchronized(lock) {
            val retryAt = lastRetryAt
            if (retryAt != null && now - retryAt < MIN_NETWORK_RETRY_INTERVAL_MILLIS) return
            lastRetryAt = now
        }
        retryNow()
    }

    private fun register(channel: EventChannel, sink: Channel<JsonObject>) {
        var needsConnection = false
        var pumpConnection: String? = null
        synchronized(lock) {
            val subscription = active[channel.key]
                ?: ActiveSubscription(channel = channel, id = "s${nextId++}").also {
                    active[channel.key] = it
                }
            subscription.sinks.add(sink)
            if (connectionJob?.isActive != true) {
                needsConnection = true
            } else {
                pumpConnection = connectionId
            }
        }
        if (needsConnection) {
            connectNow()
        } else if (pumpConnection != null) {
            pumpSubscriptions()
        }
    }

    private fun unregister(key: String, sink: Channel<JsonObject>) {
        var removedId: String? = null
        val currentConnectionId: String?
        synchronized(lock) {
            val subscription = active[key] ?: return
            subscription.sinks.remove(sink)
            if (subscription.sinks.isEmpty()) {
                active.remove(key)
                acknowledged.remove(subscription.id)
                if (connectionId != null) removedId = subscription.id
            }
            currentConnectionId = connectionId
        }
        removedId?.let { id ->
            val target = currentConnectionId ?: return@let
            scope.launch {
                runCatching { transport.unsubscribe(target, id) }
            }
        }
        if (!hasSubscriptions()) stopConnection()
    }

    private fun connectNow() {
        synchronized(lock) {
            if (connectionJob?.isActive == true) return
            val owner = ++loopGeneration
            connectionJob = scope.launch {
                connectionLoop(owner)
            }
        }
    }

    private fun stopConnection() {
        val job = synchronized(lock) {
            // Disown the running loop: it may still be blocked in a
            // non-cancellable `open()`, and it must not clear the identity of
            // the connection that replaces it.
            loopGeneration++
            connectionEpoch++
            connectionId = null
            stream = null
            acknowledged.clear()
            lastFrameAt = null
            connectionJob.also { connectionJob = null }
        }
        job?.cancel()
        _state.value = ConnectionState.Offline
    }

    private fun hasSubscriptions(): Boolean = synchronized(lock) { active.isNotEmpty() }

    private fun ownsConnection(owner: Long): Boolean = synchronized(lock) { loopGeneration == owner }

    private suspend fun connectionLoop(owner: Long) {
        var attempt = 0
        while (true) {
            if (!hasSubscriptions()) break
            if (!ownsConnection(owner)) return
            _state.value = ConnectionState.Reconnecting
            var opened: EventStream? = null
            try {
                opened = transport.open()
                // `open()` can block in a non-cancellable handshake for the
                // whole connect timeout. If this loop was replaced meanwhile,
                // the stream belongs to nobody: close it and leave the new
                // loop's identity alone.
                val owns = synchronized(lock) {
                    val mine = loopGeneration == owner
                    if (mine) stream = opened
                    mine
                }
                if (!owns) return
                opened.frames.collect { frame ->
                    if (frame.event == MUX_CONTROL_EVENT) {
                        when (val control = parseControl(frame.data)) {
                            is MuxControl.Hello -> {
                                synchronized(lock) {
                                    connectionEpoch++
                                    connectionId = control.connectionId
                                    acknowledged.clear()
                                }
                                noteFrame()
                                attempt = 0
                                _state.value = ConnectionState.Connected
                                pumpSubscriptions()
                            }
                            is MuxControl.End -> {
                                noteFrame()
                                endSubscription(control.sub)
                            }
                            MuxControl.Open -> noteFrame()
                            null -> Unit
                        }
                    } else if (frame.event != null) {
                        deliver(frame.event, frame.data)
                    }
                }
                // Server closed the stream; fall through to a reconnect.
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: ApiError.Unauthorized) {
                if (ownsConnection(owner)) _state.value = ConnectionState.Offline
                return
            } catch (_: Throwable) {
                // Network failure or an unusable stream: reconnect below.
            } finally {
                opened?.close()
                synchronized(lock) {
                    if (stream === opened) stream = null
                    // Only the loop that still owns the connection may reset
                    // its identity: a replaced loop returning late used to
                    // clear the new connection's id and leave a "Connected"
                    // stream that never subscribed again.
                    if (loopGeneration == owner) {
                        connectionEpoch++
                        connectionId = null
                        acknowledged.clear()
                    }
                }
            }
            if (!hasSubscriptions()) break
            if (!ownsConnection(owner)) return
            _state.value = ConnectionState.Reconnecting
            delay(backoff.delayMillis(attempt++))
        }
        if (ownsConnection(owner)) _state.value = ConnectionState.Offline
    }

    /** A frame of any kind proves the socket is alive (SSE heartbeats are comments and never reach here). */
    private fun noteFrame() {
        lastFrameAt = clock()
    }

    private fun pumpSubscriptions() {
        val connection = synchronized(lock) {
            val current = connectionId ?: return
            current to connectionEpoch
        }
        val (currentConnectionId, epoch) = connection
        scope.launch {
            try {
                subscribeMutex.withLock { postMissingSubscriptions(currentConnectionId, epoch) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: StaleConnection) {
                // `unknown_connection`: the server no longer knows this stream.
                dropStreamIfCurrent(currentConnectionId, epoch)
            } catch (_: ApiError.Unauthorized) {
                _state.value = ConnectionState.Offline
            } catch (_: Throwable) {
                // A transient POST failure (network, 413, 5xx) must not hot-loop:
                // drop the stream and let the connection loop use its backoff.
                dropStreamIfCurrent(currentConnectionId, epoch)
            }
        }
    }

    private suspend fun postMissingSubscriptions(connectionId: String, epoch: Long) {
        while (true) {
            val pending = synchronized(lock) {
                if (!isCurrent(connectionId, epoch)) return
                active.values.filter { it.id !in acknowledged }
            }
            if (pending.isEmpty()) return
            for (subscription in pending) {
                val result = transport.subscribe(connectionId, subscription.id, subscription.channel)
                if (!synchronized(lock) { isCurrent(connectionId, epoch) }) return
                when (result) {
                    EventPostResult.Ok -> synchronized(lock) {
                        // The ack belongs to this connection only; a POST that
                        // returns after the stream changed must not hide the
                        // subscription on the new one.
                        if (isCurrent(connectionId, epoch)) acknowledged.add(subscription.id)
                    }
                    EventPostResult.ConnectionUnknown -> throw StaleConnection()
                    is EventPostResult.Rejected -> terminate(
                        subscription,
                        EventSubscriptionException(
                            result.status,
                            result.message.ifBlank { "Subscription refused" },
                        ),
                    )
                }
            }
        }
    }

    private fun isCurrent(connectionId: String, epoch: Long): Boolean =
        this.connectionId == connectionId && this.connectionEpoch == epoch

    private fun dropStreamIfCurrent(connectionId: String, epoch: Long) {
        val current = synchronized(lock) {
            if (!isCurrent(connectionId, epoch)) return
            stream
        }
        current?.close()
    }

    /**
     * An `end` control frame closed only this subscription on the server. The
     * collectors stay attached and the same id is subscribed again after
     * [RESUBSCRIBE_DELAY_MILLIS].
     */
    private fun endSubscription(subId: String) {
        val subscription = synchronized(lock) {
            active.values.firstOrNull { it.id == subId }
        } ?: return
        synchronized(lock) { acknowledged.remove(subscription.id) }
        scope.launch {
            delay(RESUBSCRIBE_DELAY_MILLIS)
            synchronized(lock) {
                if (active[subscription.channel.key] !== subscription) return@launch
                acknowledged.remove(subscription.id)
            }
            pumpSubscriptions()
        }
    }

    private fun terminate(subscription: ActiveSubscription, cause: Throwable?) {
        synchronized(lock) {
            if (active[subscription.channel.key] === subscription) {
                active.remove(subscription.channel.key)
            }
            acknowledged.remove(subscription.id)
        }
        for (sink in subscription.sinks.toList()) {
            if (cause == null) sink.close() else sink.close(cause)
        }
        subscription.sinks.clear()
        if (!hasSubscriptions()) stopConnection()
    }

    private fun deliver(subId: String, data: String) {
        val subscription = synchronized(lock) { active.values.firstOrNull { it.id == subId } } ?: return
        val json = try {
            JSON.parseToJsonElement(data).jsonObject
        } catch (_: Exception) {
            return
        }
        lastFrameAt = clock()
        for (sink in subscription.sinks.toList()) {
            sink.trySend(json)
        }
    }

    private fun parseControl(data: String): MuxControl? = try {
        val root = JSON.parseToJsonElement(data).jsonObject
        when (root["type"]?.jsonPrimitive?.contentOrNull) {
            "hello" -> root["connectionId"]?.jsonPrimitive?.contentOrNull?.let { MuxControl.Hello(it) }
            "open" -> MuxControl.Open
            "end" -> root["sub"]?.jsonPrimitive?.contentOrNull?.let { MuxControl.End(it) }
            else -> null
        }
    } catch (_: Exception) {
        null
    }

    private sealed interface MuxControl {
        data class Hello(val connectionId: String) : MuxControl
        data object Open : MuxControl
        data class End(val sub: String) : MuxControl
    }

    private class StaleConnection : Exception()

    companion object {
        /** SSE event name of connection/subscription control frames. */
        const val MUX_CONTROL_EVENT = "mux"

        /** Time the app may stay in the background before the stream is dropped. */
        const val BACKGROUND_GRACE_MILLIS = 5_000L

        /** The protocol's pause before a subscription the server ended is opened again. */
        const val RESUBSCRIBE_DELAY_MILLIS = 3_000L

        /**
         * Minimum distance between two network-triggered reconnects: one
         * network switch delivers several `onAvailable` callbacks.
         */
        const val MIN_NETWORK_RETRY_INTERVAL_MILLIS = 2_000L

        /** A frame younger than this proves the socket survived a network change. */
        const val NETWORK_LIVENESS_MILLIS = 5_000L

        private val JSON = Json { ignoreUnknownKeys = true }
    }
}
