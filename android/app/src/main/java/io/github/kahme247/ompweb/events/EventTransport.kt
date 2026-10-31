package io.github.kahme247.ompweb.events

import io.github.kahme247.ompweb.net.EventPostResult
import kotlinx.coroutines.flow.Flow

/**
 * The wire side of the event mux, behind an interface so the mux's
 * reconnect/resubscribe logic can be tested without a network.
 */
interface EventTransport {
    /** Opens the multiplexed stream. The first frame the server sends is `hello`. */
    suspend fun open(): EventStream

    suspend fun subscribe(connectionId: String, id: String, channel: EventChannel): EventPostResult

    suspend fun unsubscribe(connectionId: String, id: String)
}

/** One open `/api/events` connection. */
interface EventStream {
    val frames: Flow<SseFrame>

    /** Closes the connection; the frames flow then completes. */
    fun close()
}
