package io.github.kahme247.ompweb.events

/** One dispatched Server-Sent Event. */
data class SseFrame(
    /** The `event:` field; the mux uses `mux` for control frames and `s<id>` for subscriptions. */
    val event: String?,
    val data: String,
)

/**
 * Incremental SSE parser: feed one line at a time, get a frame back when a
 * blank line completes one.
 *
 * Only the fields ompweb uses are kept (`event`, `data`); `id` and `retry`
 * are ignored because the mux reconnects with its own backoff and never
 * resumes from `Last-Event-ID`. Multi-line `data:` fields are joined with `\n`
 * as the SSE specification requires.
 */
class SseParser {

    private val data = StringBuilder()
    private var event: String? = null
    private var hasData = false

    fun consume(line: String): SseFrame? {
        if (line.isEmpty()) return dispatch()
        if (line.startsWith(":")) return null
        val separator = line.indexOf(':')
        val field = if (separator < 0) line else line.substring(0, separator)
        var value = if (separator < 0) "" else line.substring(separator + 1)
        if (value.startsWith(" ")) value = value.substring(1)
        when (field) {
            "event" -> event = value
            "data" -> {
                if (hasData) data.append('\n')
                data.append(value)
                hasData = true
            }
        }
        return null
    }

    private fun dispatch(): SseFrame? {
        if (!hasData && event == null) return null
        val frame = SseFrame(event = event, data = data.toString())
        data.setLength(0)
        event = null
        hasData = false
        return frame
    }
}
