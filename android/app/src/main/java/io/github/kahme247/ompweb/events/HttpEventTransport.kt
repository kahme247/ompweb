package io.github.kahme247.ompweb.events

import io.github.kahme247.ompweb.net.ApiClient
import io.github.kahme247.ompweb.net.ApiError
import io.github.kahme247.ompweb.net.EventPostResult
import io.github.kahme247.ompweb.net.ServerAddress
import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Response

/**
 * [EventTransport] over OkHttp's streaming read of `/api/events`.
 *
 * [heartbeatSeconds] is the keep-alive interval the whole app asks for (S7;
 * 15–110 s). The app asks for the top of that range: in two 30-minute doze
 * windows on the emulator the 110 s
 * build stayed connected for the whole window with no wakelock, 427 ms + 76 ms
 * of CPU and 62.7 KB down / 48.7 KB up, against 1 129 ms + 168 ms and 904 KB /
 * 106 KB at 60 s. 110 s also sends the fewest keep-alive frames of any allowed
 * interval (about 16 per 30 minutes).
 * The call's read timeout is derived from it (heartbeat + 30 s, i.e. 140 s), so
 * an on-time heartbeat can never race the idle timeout, and a silently dead
 * socket is still noticed within that bound.
 */
class HttpEventTransport(
    private val api: ApiClient,
    private val scope: CoroutineScope,
    private val heartbeatSeconds: Int = DEFAULT_HEARTBEAT_SECONDS,
) : EventTransport {

    override suspend fun open(): EventStream = withContext(Dispatchers.IO) {
        val call = api.openEventStream(heartbeatSeconds)
        var stream: HttpEventStream? = null
        try {
            val response = try {
                call.execute()
            } catch (error: IOException) {
                throw ApiError.Network(error)
            }
            if (response.code !in 200..299) {
                val body = try {
                    response.body.string().take(2048)
                } catch (_: IOException) {
                    ""
                }
                response.close()
                val url = response.request.url
                throw api.errorFor(response.code, body, ServerAddress(url.scheme, url.host, url.port))
            }
            stream = HttpEventStream(call, response, scope)
            stream
        } finally {
            // Cancelling while execute() blocked never reaches a suspension
            // point inside the block; close the stream here so the call and
            // its reader cannot outlive the caller.
            if (!isActive) {
                stream?.close() ?: call.cancel()
            }
        }
    }

    override suspend fun subscribe(connectionId: String, id: String, channel: EventChannel): EventPostResult =
        api.postEvent(
            buildJsonObject {
                put("connectionId", connectionId)
                put(
                    "subscribe",
                    buildJsonObject {
                        put("id", id)
                        put("channel", channel.toJson())
                    },
                )
            },
        )

    override suspend fun unsubscribe(connectionId: String, id: String) {
        api.postEvent(
            buildJsonObject {
                put("connectionId", connectionId)
                put("unsubscribe", id)
            },
        )
    }

    companion object {
        /** S7 heartbeat the app asks for; the server accepts 15–110 s. */
        const val DEFAULT_HEARTBEAT_SECONDS = 110
    }
}

/**
 * Reads the SSE body on its own coroutine and hands frames over a channel, so
 * closing the connection (backgrounding the app, signing out) cancels the
 * blocking read immediately instead of waiting for the next heartbeat.
 */
private class HttpEventStream(
    private val call: Call,
    private val response: Response,
    scope: CoroutineScope,
) : EventStream {

    private val channel = Channel<SseFrame>(Channel.BUFFERED)

    override val frames: Flow<SseFrame> = channel.receiveAsFlow()

    private val reader = scope.launch(Dispatchers.IO) {
        try {
            val parser = SseParser()
            val source = response.body.source()
            while (isActive) {
                val line = source.readUtf8Line() ?: break
                val frame = parser.consume(line) ?: continue
                if (channel.trySend(frame).isFailure) break
            }
        } catch (_: IOException) {
            // The call was cancelled or the connection dropped; EventMux reconnects.
        } finally {
            response.close()
            channel.close()
        }
    }

    override fun close() {
        call.cancel()
        reader.cancel()
        channel.close()
    }
}
