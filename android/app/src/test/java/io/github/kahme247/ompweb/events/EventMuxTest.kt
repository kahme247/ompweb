package io.github.kahme247.ompweb.events

import io.github.kahme247.ompweb.net.ApiError
import io.github.kahme247.ompweb.net.EventPostResult
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlin.random.Random
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class EventMuxTest {

    private val transport = FakeTransport()

    private fun TestScope.mux(): EventMux = EventMux(
        transport = transport,
        scope = backgroundScope,
        backoff = Backoff(baseMillis = 1, maxMillis = 4, jitterRatio = 0.0, random = Random(0)),
        // Virtual time: the liveness and rate-limit guards use the same clock
        // as `advanceTimeBy`.
        clock = { testScheduler.currentTime },
    )

    private fun hello(connectionId: String): String = """{"type":"hello","connectionId":"$connectionId"}"""

    @Test
    fun `hello leads to a subscribe and sN frames reach the collector`() = runTest {
        val mux = mux()
        val received = mutableListOf<JsonObject>()
        backgroundScope.launch { mux.subscribe(EventChannel.Running).collect { received += it } }
        runCurrent()

        val stream = transport.openStream()
        stream.send(EventMux.MUX_CONTROL_EVENT, hello("c1"))
        runCurrent()

        assertEquals(ConnectionState.Connected, mux.state.value)
        assertEquals(1, transport.subscribes.size)
        val subscription = transport.subscribes.single()
        assertEquals("c1", subscription.connectionId)
        assertEquals("s1", subscription.id)
        assertEquals(EventChannel.Running, subscription.channel)

        stream.send("s1", """{"type":"running","runningSessionIds":["a"]}""")
        runCurrent()

        assertEquals(1, received.size)
        assertEquals("""{"type":"running","runningSessionIds":["a"]}""", received.single().toString())
    }

    @Test
    fun `a dropped stream reconnects and resubscribes with the same id`() = runTest {
        val mux = mux()
        backgroundScope.launch { mux.subscribe(EventChannel.Running).collect {} }
        runCurrent()

        val first = transport.openStream()
        first.send(EventMux.MUX_CONTROL_EVENT, hello("c1"))
        runCurrent()

        first.close()
        runCurrent()
        assertEquals(ConnectionState.Reconnecting, mux.state.value)

        val second = transport.openStream()
        advanceTimeBy(5)
        runCurrent()
        second.send(EventMux.MUX_CONTROL_EVENT, hello("c2"))
        runCurrent()

        assertEquals(ConnectionState.Connected, mux.state.value)
        assertEquals(2, transport.subscribes.size)
        assertEquals("c2", transport.subscribes[1].connectionId)
        assertEquals("s1", transport.subscribes[1].id)
    }

    @Test
    fun `a network change reconnects a silent stream`() = runTest {
        val mux = mux()
        backgroundScope.launch { mux.subscribe(EventChannel.Running).collect {} }
        runCurrent()
        val stream = transport.openStream()
        stream.send(EventMux.MUX_CONTROL_EVENT, hello("c1"))
        runCurrent()
        assertEquals(1, transport.openCalls)

        // Wi-Fi came back while the socket still looked open: nothing arrived
        // for a while (the handshake is older than the liveness window), so the
        // stream is reconnected instead of waiting for the read timeout.
        advanceTimeBy(EventMux.NETWORK_LIVENESS_MILLIS + 1)
        mux.onNetworkAvailable()
        runCurrent()

        assertEquals("the silent socket is replaced", 2, transport.openCalls)
    }

    @Test
    fun `a connection that just completed its handshake is not torn down`() = runTest {
        val mux = mux()
        backgroundScope.launch { mux.subscribe(EventChannel.Running).collect {} }
        runCurrent()
        val stream = transport.openStream()
        stream.send(EventMux.MUX_CONTROL_EVENT, hello("c1"))
        runCurrent()

        // A channel can be quiet for minutes. The hello frame itself proves the
        // socket survived the network change, so a flapping network must not
        // rebuild a healthy connection on every `onAvailable` (each rebuild is
        // a handshake plus one POST per subscription).
        mux.onNetworkAvailable()
        runCurrent()

        assertEquals("the handshake counts as liveness", 1, transport.openCalls)
        assertEquals(ConnectionState.Connected, mux.state.value)
    }

    @Test
    fun `a network change keeps a stream that just delivered a frame`() = runTest {
        val mux = mux()
        backgroundScope.launch { mux.subscribe(EventChannel.Running).collect {} }
        runCurrent()
        val stream = transport.openStream()
        stream.send(EventMux.MUX_CONTROL_EVENT, hello("c1"))
        runCurrent()
        stream.send("s1", """{"type":"running","runningSessionIds":["a"]}""")
        runCurrent()

        mux.onNetworkAvailable()
        runCurrent()

        assertEquals("a live socket is not torn down for nothing", 1, transport.openCalls)
        assertEquals(ConnectionState.Connected, mux.state.value)
    }

    @Test
    fun `a slow open from a replaced loop never clears the new connection`() = runTest {
        val gate = CompletableDeferred<Unit>()
        transport.nonCooperativeOpenGate = gate
        val mux = mux()
        val received = mutableListOf<JsonObject>()
        backgroundScope.launch { mux.subscribe(EventChannel.Running).collect { received += it } }
        runCurrent()
        assertEquals("the first loop is stuck in the handshake", 1, transport.openCalls)

        // The banner's Retry (or a second `onAvailable`) replaces the loop while
        // the first one is still inside the non-cancellable `open()`.
        val second = transport.openStream()
        mux.retryNow()
        runCurrent()
        second.send(EventMux.MUX_CONTROL_EVENT, hello("c2"))
        runCurrent()
        assertEquals(ConnectionState.Connected, mux.state.value)
        assertEquals(listOf("c2"), transport.subscribes.map { it.connectionId })

        // The replaced loop's open() returns now. Its cleanup used to reset
        // `connectionId`/the epoch unconditionally, leaving a "Connected" mux
        // that never subscribed again.
        gate.complete(Unit)
        runCurrent()

        assertEquals("the live connection keeps its state", ConnectionState.Connected, mux.state.value)
        val posts = transport.subscribes.size
        backgroundScope.launch { mux.subscribe(EventChannel.Session("late")).collect {} }
        runCurrent()
        assertEquals("the new channel is subscribed", posts + 1, transport.subscribes.size)
        assertEquals("on the live connection", "c2", transport.subscribes.last().connectionId)

        second.send("s1", """{"type":"running","runningSessionIds":[]}""")
        runCurrent()
        assertEquals("the live stream still delivers", 1, received.size)
    }

    @Test
    fun `two network changes in a row reconnect once`() = runTest {
        val mux = mux()
        backgroundScope.launch { mux.subscribe(EventChannel.Running).collect {} }
        runCurrent()
        val stream = transport.openStream()
        stream.send(EventMux.MUX_CONTROL_EVENT, hello("c1"))
        runCurrent()
        advanceTimeBy(EventMux.NETWORK_LIVENESS_MILLIS + 1)

        // One switch delivers several `onAvailable` callbacks.
        mux.onNetworkAvailable()
        runCurrent()
        mux.onNetworkAvailable()
        runCurrent()

        assertEquals(2, transport.openCalls)
    }

    @Test
    fun `a network change without a subscription connects nothing`() = runTest {
        val mux = mux()
        mux.onNetworkAvailable()
        runCurrent()

        assertEquals(0, transport.openCalls)
    }

    @Test
    fun `a refused subscription fails only its own flow`() = runTest {
        val mux = mux()
        val running = mutableListOf<JsonObject>()
        backgroundScope.launch { mux.subscribe(EventChannel.Running).collect { running += it } }
        runCurrent()
        val stream = transport.openStream()
        stream.send(EventMux.MUX_CONTROL_EVENT, hello("c1"))
        runCurrent()

        transport.results.add(EventPostResult.Rejected(409, "session_not_running", "no wrapper"))
        val failed = async {
            runCatching { mux.subscribe(EventChannel.Session("dead")).collect {} }.exceptionOrNull()
        }
        runCurrent()

        val error = failed.await()
        assertTrue(error is EventSubscriptionException)
        assertEquals(409, (error as EventSubscriptionException).status)
        assertEquals(ConnectionState.Connected, mux.state.value)

        stream.send("s1", """{"type":"running","runningSessionIds":[]}""")
        runCurrent()
        assertEquals(1, running.size)
    }

    @Test
    fun `an end control frame keeps the flow and resubscribes after three seconds`() = runTest {
        val mux = mux()
        val received = mutableListOf<JsonObject>()
        val failures = mutableListOf<Throwable>()
        val collector = backgroundScope.launch {
            try {
                mux.subscribe(EventChannel.Running).collect { received += it }
            } catch (failure: EventSubscriptionException) {
                failures += failure
            }
        }
        val stream = transport.openStream()
        runCurrent()
        stream.send(EventMux.MUX_CONTROL_EVENT, hello("c1"))
        runCurrent()
        assertEquals(1, transport.subscribes.size)

        stream.send(EventMux.MUX_CONTROL_EVENT, """{"type":"end","sub":"s1"}""")
        runCurrent()

        // The flow stays open: an end frame only closed the server watcher.
        assertTrue(collector.isActive)
        assertEquals(1, transport.subscribes.size)

        advanceTimeBy(EventMux.RESUBSCRIBE_DELAY_MILLIS + 1)
        runCurrent()

        assertEquals(2, transport.subscribes.size)
        assertEquals("c1", transport.subscribes[1].connectionId)
        assertEquals("s1", transport.subscribes[1].id)

        stream.send("s1", """{"type":"running","runningSessionIds":["a"]}""")
        runCurrent()

        assertEquals(1, received.size)
        assertEquals(ConnectionState.Connected, mux.state.value)
        assertTrue(failures.isEmpty())
    }

    @Test
    fun `collectors of one channel share a single server subscription`() = runTest {
        val mux = mux()
        val first = backgroundScope.launch { mux.subscribe(EventChannel.Running).collect {} }
        runCurrent()
        val stream = transport.openStream()
        stream.send(EventMux.MUX_CONTROL_EVENT, hello("c1"))
        runCurrent()
        assertEquals(1, transport.subscribes.size)

        val second = backgroundScope.launch { mux.subscribe(EventChannel.Running).collect {} }
        runCurrent()
        assertEquals(1, transport.subscribes.size)

        first.cancel()
        runCurrent()
        assertTrue(transport.unsubscribes.isEmpty())

        second.cancel()
        runCurrent()
        assertEquals(1, transport.unsubscribes.size)
        assertEquals("c1", transport.unsubscribes.single().first)
        assertEquals("s1", transport.unsubscribes.single().second)
        assertEquals(ConnectionState.Offline, mux.state.value)
    }

    @Test
    fun `a dead connection during subscribe reconnects instead of dropping the flow`() = runTest {
        val mux = mux()
        val received = mutableListOf<JsonObject>()
        backgroundScope.launch { mux.subscribe(EventChannel.Running).collect { received += it } }
        runCurrent()
        val first = transport.openStream()
        transport.results.add(EventPostResult.ConnectionUnknown)
        first.send(EventMux.MUX_CONTROL_EVENT, hello("c1"))
        runCurrent()

        assertEquals(ConnectionState.Reconnecting, mux.state.value)

        val second = transport.openStream()
        advanceTimeBy(5)
        runCurrent()
        second.send(EventMux.MUX_CONTROL_EVENT, hello("c2"))
        runCurrent()

        assertEquals(ConnectionState.Connected, mux.state.value)
        assertEquals("c2", transport.subscribes.last().connectionId)
        assertEquals("s1", transport.subscribes.last().id)

        second.send("s1", """{"type":"running","runningSessionIds":[]}""")
        runCurrent()
        assertEquals(1, received.size)
    }

    @Test
    fun `a refused open retries with growing delays`() = runTest {
        transport.failNextOpen = true
        val mux = mux()
        val received = mutableListOf<JsonObject>()
        backgroundScope.launch { mux.subscribe(EventChannel.Running).collect { received += it } }
        runCurrent()
        assertEquals(ConnectionState.Reconnecting, mux.state.value)

        val stream = transport.openStream()
        advanceTimeBy(2)
        runCurrent()
        stream.send(EventMux.MUX_CONTROL_EVENT, hello("c1"))
        runCurrent()

        assertEquals(ConnectionState.Connected, mux.state.value)
        assertEquals(1, transport.subscribes.size)
    }

    @Test
    fun `leaving the foreground disconnects and returning reconnects`() = runTest {
        val mux = mux()
        backgroundScope.launch { mux.subscribe(EventChannel.Running).collect {} }
        runCurrent()
        transport.openStream().send(EventMux.MUX_CONTROL_EVENT, hello("c1"))
        runCurrent()
        assertEquals(ConnectionState.Connected, mux.state.value)

        mux.onBackground()
        advanceTimeBy(EventMux.BACKGROUND_GRACE_MILLIS + 1)
        runCurrent()
        assertEquals(ConnectionState.Offline, mux.state.value)

        mux.onForeground()
        runCurrent()
        val stream = transport.openStream()
        runCurrent()
        stream.send(EventMux.MUX_CONTROL_EVENT, hello("c2"))
        runCurrent()
        assertEquals(ConnectionState.Connected, mux.state.value)
    }

    @Test
    fun `reconnect delays stay inside the jittered cap`() {
        val backoff = Backoff(baseMillis = 1_000, maxMillis = 30_000, jitterRatio = 0.2, random = Random(42))

        assertTrue(backoff.delayMillis(0) in 800..1_200)
        assertTrue(backoff.delayMillis(1) in 1_600..2_400)
        assertTrue(backoff.delayMillis(4) in 12_800..19_200)
        assertTrue(backoff.delayMillis(10) in 24_000..30_000)
        assertTrue(backoff.delayMillis(100) in 24_000..30_000)
    }

    @Test
    fun `a subscribe acknowledgement from an old connection does not hide the new subscription`() = runTest {
        val mux = mux()
        val received = mutableListOf<JsonObject>()
        backgroundScope.launch { mux.subscribe(EventChannel.Running).collect { received += it } }
        runCurrent()

        val gate = CompletableDeferred<Unit>()
        transport.subscribeGate = gate
        val first = transport.openStream()
        first.send(EventMux.MUX_CONTROL_EVENT, hello("c1"))
        runCurrent()
        // The POST for c1/s1 is in flight and blocked on the gate.
        assertEquals(1, transport.subscribes.size)

        first.close()
        runCurrent()
        assertEquals(ConnectionState.Reconnecting, mux.state.value)

        advanceTimeBy(5)
        runCurrent()
        val second = transport.openStream()
        runCurrent()
        second.send(EventMux.MUX_CONTROL_EVENT, hello("c2"))
        runCurrent()

        // The old POST succeeds now; it must not mark s1 as acknowledged on c2.
        gate.complete(Unit)
        runCurrent()

        assertEquals(listOf("c1", "c2"), transport.subscribes.map { it.connectionId })
        assertEquals(listOf("s1", "s1"), transport.subscribes.map { it.id })

        second.send("s1", """{"type":"running","runningSessionIds":["a"]}""")
        runCurrent()
        assertEquals(1, received.size)
    }

    @Test
    fun `a forbidden subscription ends only its flow and does not reconnect`() = runTest {
        val mux = mux()
        backgroundScope.launch { mux.subscribe(EventChannel.Running).collect {} }
        runCurrent()
        val stream = transport.openStream()
        stream.send(EventMux.MUX_CONTROL_EVENT, hello("c1"))
        runCurrent()

        transport.results.add(EventPostResult.Rejected(403, "forbidden", "forbidden"))
        val failed = async {
            runCatching { mux.subscribe(EventChannel.Session("secret")).collect {} }.exceptionOrNull()
        }
        runCurrent()

        val error = failed.await()
        assertTrue(error is EventSubscriptionException)
        assertEquals(403, (error as EventSubscriptionException).status)
        assertEquals(ConnectionState.Connected, mux.state.value)
        assertEquals(1, transport.openCalls)
    }

    @Test
    fun `a transient subscribe failure reconnects through the backoff instead of hot-looping`() = runTest {
        val mux = mux()
        backgroundScope.launch { mux.subscribe(EventChannel.Running).collect {} }
        runCurrent()
        val first = transport.openStream()
        first.send(EventMux.MUX_CONTROL_EVENT, hello("c1"))
        runCurrent()
        assertEquals(1, transport.subscribes.size)

        transport.failSubscribeWith = ApiError.Http(500, "")
        backgroundScope.launch { mux.subscribe(EventChannel.Session("s")).collect {} }
        runCurrent()

        assertEquals(ConnectionState.Reconnecting, mux.state.value)
        assertEquals(1, transport.openCalls)
        assertEquals(2, transport.subscribes.size)

        advanceTimeBy(5)
        runCurrent()
        val second = transport.openStream()
        runCurrent()
        second.send(EventMux.MUX_CONTROL_EVENT, hello("c2"))
        runCurrent()

        assertEquals(2, transport.openCalls)
        assertEquals(
            setOf("s1", "s2"),
            transport.subscribes.filter { it.connectionId == "c2" }.map { it.id }.toSet(),
        )
    }

    @Test
    fun `a lost network reports reconnecting and recovers without user action`() = runTest {
        val mux = mux()
        val states = mutableListOf<ConnectionState>()
        backgroundScope.launch { mux.state.collect { states += it } }
        val received = mutableListOf<JsonObject>()
        backgroundScope.launch { mux.subscribe(EventChannel.Running).collect { received += it } }
        runCurrent()
        val first = transport.openStream()
        first.send(EventMux.MUX_CONTROL_EVENT, hello("c1"))
        runCurrent()
        assertEquals(ConnectionState.Connected, mux.state.value)

        // Wi-Fi/Tailscale goes away: the stream dies and the next opens fail
        // exactly like an unreachable host.
        transport.failOpens = 2
        first.close()
        runCurrent()
        assertEquals(ConnectionState.Reconnecting, mux.state.value)

        repeat(2) {
            advanceTimeBy(5)
            runCurrent()
        }
        assertEquals("retries stay visible as reconnecting", ConnectionState.Reconnecting, mux.state.value)

        // The network returns; nobody taps anything.
        advanceTimeBy(5)
        runCurrent()
        val second = transport.openStream()
        second.send(EventMux.MUX_CONTROL_EVENT, hello("c2"))
        runCurrent()

        assertEquals(ConnectionState.Connected, mux.state.value)
        assertEquals("s1", transport.subscribes.last().id)
        assertEquals("c2", transport.subscribes.last().connectionId)

        second.send("s1", """{"type":"running","runningSessionIds":["a"]}""")
        runCurrent()

        assertEquals(1, received.size)
        // Collapse only *consecutive* repeats: a plain `distinct()` would drop
        // the final Connected and make the expected sequence unreachable.
        val transitions = states.fold(mutableListOf<ConnectionState>()) { acc, state ->
            if (acc.lastOrNull() != state) acc += state
            acc
        }
        assertEquals(
            listOf(ConnectionState.Connected, ConnectionState.Reconnecting, ConnectionState.Connected),
            transitions.dropWhile { it != ConnectionState.Connected },
        )
        assertTrue("the state never reports offline while subscriptions exist", states.none { it == ConnectionState.Offline })
    }

    @Test
    fun `a server restart resubscribes every channel and delivers each frame once`() = runTest {
        val mux = mux()
        val running = mutableListOf<JsonObject>()
        val session = mutableListOf<JsonObject>()
        backgroundScope.launch { mux.subscribe(EventChannel.Running).collect { running += it } }
        backgroundScope.launch { mux.subscribe(EventChannel.Session("a")).collect { session += it } }
        runCurrent()
        val first = transport.openStream()
        first.send(EventMux.MUX_CONTROL_EVENT, hello("c1"))
        runCurrent()
        assertEquals(listOf("s1", "s2"), transport.subscribes.map { it.id })

        first.close()
        runCurrent()
        assertEquals(ConnectionState.Reconnecting, mux.state.value)

        advanceTimeBy(5)
        runCurrent()
        val second = transport.openStream()
        second.send(EventMux.MUX_CONTROL_EVENT, hello("c2"))
        runCurrent()

        assertEquals(ConnectionState.Connected, mux.state.value)
        assertEquals(
            listOf("s1", "s2"),
            transport.subscribes.filter { it.connectionId == "c2" }.map { it.id },
        )

        second.send("s1", """{"type":"running","runningSessionIds":["a"]}""")
        second.send("s2", """{"type":"agent_end","sessionId":"a"}""")
        runCurrent()

        assertEquals(1, running.size)
        assertEquals(1, session.size)
        assertEquals("""{"type":"agent_end","sessionId":"a"}""", session.single().toString())
    }

    private class Subscription(
        val connectionId: String,
        val id: String,
        val channel: EventChannel,
    )

    private class FakeTransport : EventTransport {
        val streams = Channel<FakeStream>(Channel.UNLIMITED)
        val subscribes = mutableListOf<Subscription>()
        val unsubscribes = mutableListOf<Pair<String, String>>()
        val results = ArrayDeque<EventPostResult>()

        var failNextOpen = false
        /** Number of upcoming opens that fail like an unreachable host. */
        var failOpens = 0
        var openCalls = 0
        var failSubscribeWith: Throwable? = null
        var subscribeGate: CompletableDeferred<Unit>? = null

        /**
         * Simulates the blocking `call.execute()` of the real transport: the
         * next `open()` ignores cancellation and only returns once the gate
         * completes (like a handshake that runs into the connect timeout).
         */
        var nonCooperativeOpenGate: CompletableDeferred<Unit>? = null

        fun openStream(): FakeStream = FakeStream().also { streams.trySend(it) }

        override suspend fun open(): EventStream {
            openCalls++
            if (failOpens > 0) {
                failOpens--
                throw IOException("connection refused")
            }
            if (failNextOpen) {
                failNextOpen = false
                throw IOException("connection refused")
            }
            val gate = nonCooperativeOpenGate
            if (gate != null) {
                nonCooperativeOpenGate = null
                // `suspendCoroutine` has no cancellation hook, so a cancelled
                // loop still resumes here — exactly the real `execute()`.
                suspendCoroutine<Unit> { continuation ->
                    gate.invokeOnCompletion { continuation.resume(Unit) }
                }
                return FakeStream()
            }
            return streams.receive()
        }

        override suspend fun subscribe(connectionId: String, id: String, channel: EventChannel): EventPostResult {
            subscribes += Subscription(connectionId, id, channel)
            subscribeGate?.await()
            failSubscribeWith?.let { failure ->
                failSubscribeWith = null
                throw failure
            }
            return results.removeFirstOrNull() ?: EventPostResult.Ok
        }

        override suspend fun unsubscribe(connectionId: String, id: String) {
            unsubscribes += connectionId to id
        }
    }

    private class FakeStream : EventStream {
        private val channel = Channel<SseFrame>(Channel.UNLIMITED)

        override val frames: Flow<SseFrame> = channel.receiveAsFlow()

        fun send(event: String, data: String) {
            channel.trySend(SseFrame(event, data))
        }

        override fun close() {
            channel.close()
        }
    }
}
