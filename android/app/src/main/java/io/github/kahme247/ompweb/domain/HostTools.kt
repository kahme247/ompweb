package io.github.kahme247.ompweb.domain

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The consent-bearing host tools the app registers with omp (`set_host_tools`). */
enum class HostToolKind { OpenUrl, OpenFile }

/** One `host_tool_call` that needs the user: a URL or file from an agent. */
data class HostToolPrompt(
    val id: String,
    val sessionId: String,
    val toolName: String,
    val kind: HostToolKind,
    /** The URL, or the full file path (the dialog shows it as-is). */
    val target: String,
    /** True when the call comes from a session the user is not viewing. */
    val crossSession: Boolean,
)

/** What the UI does with a host tool call before asking the user. */
enum class HostToolDecision {
    /** Open it right away (same session, auto-open setting on / file viewer). */
    Execute,

    /** Queue the consent prompt. */
    Ask,

    /** Answer with an error result; nothing is opened. */
    Error,
}

/** Web `requestOpenUrl`/`handleCrossSessionHostTool`: only the viewed session may auto-open. */
fun isCrossSession(callSessionId: String, viewedSessionId: String?): Boolean =
    viewedSessionId == null || viewedSessionId != callSessionId

/**
 * `open_url`: unsafe or missing URLs are rejected; a link from another session
 * always asks, and the auto-open preference applies to the viewed session only.
 */
fun openUrlDecision(
    url: String?,
    callSessionId: String,
    viewedSessionId: String?,
    autoOpen: Boolean,
): HostToolDecision = when {
    !isSafeOpenUrl(url) -> HostToolDecision.Error
    isCrossSession(callSessionId, viewedSessionId) -> HostToolDecision.Ask
    autoOpen -> HostToolDecision.Execute
    else -> HostToolDecision.Ask
}

/**
 * `open_file`: no path is an error, another session's file always asks,
 * a file of the viewed session opens in the app's file viewer.
 */
fun openFileDecision(
    path: String?,
    callSessionId: String,
    viewedSessionId: String?,
): HostToolDecision = when {
    path.isNullOrBlank() -> HostToolDecision.Error
    isCrossSession(callSessionId, viewedSessionId) -> HostToolDecision.Ask
    else -> HostToolDecision.Execute
}

/** Result text the agent sees for an opened target. */
fun openedResult(target: String): String = "Opened $target"

/** Result text while the consent prompt is shown (web `requestOpenUrl`). */
fun askedResult(target: String, crossSession: Boolean): String = if (crossSession) {
    "Asked the user to confirm opening $target; they are viewing another ompweb session."
} else {
    "Asked the user to confirm opening $target."
}

const val UNSAFE_URL_RESULT: String = "Unsafe or invalid URL not opened"
const val NO_PATH_RESULT: String = "No path provided"
const val NOTIFICATION_SHOWN_RESULT: String = "Notification shown"
const val CLIPBOARD_EMPTY_RESULT: String = "(clipboard is empty)"
const val CLIPBOARD_UNAVAILABLE_READ: String = "Clipboard read is not available"
const val CLIPBOARD_UNAVAILABLE_WRITE: String = "Clipboard write is not available"
const val CLIPBOARD_WRITE_FAILED: String = "Clipboard write failed"
const val CLIPBOARD_READ_DENIED: String =
    "Clipboard read was denied. Return to the ompweb app and try again."

fun unknownHostToolResult(toolName: String): String = "Host tool \"$toolName\" is not available in ompweb"

fun unknownHostUriResult(resource: String): String = "Unknown pi-web resource: $resource"

/**
 * The `set_host_tools` payload (web `HOST_TOOL_DEFINITIONS`). Registration is
 * per wrapper and not persisted, so it is re-sent on every reconnect.
 */
val HOST_TOOL_DEFINITIONS: JsonArray = buildJsonArray {
    add(
        buildJsonObject {
            put("name", "open_url")
            put("description", "Open a URL in the user's browser.")
            put(
                "parameters",
                buildJsonObject {
                    put("type", "object")
                    put(
                        "properties",
                        buildJsonObject {
                            put("url", buildJsonObject { put("type", "string") })
                        },
                    )
                    put("required", buildJsonArray { add(JsonPrimitive("url")) })
                },
            )
        },
    )
    add(
        buildJsonObject {
            put("name", "notify")
            put("description", "Show a browser notification to the user.")
            put(
                "parameters",
                buildJsonObject {
                    put("type", "object")
                    put(
                        "properties",
                        buildJsonObject {
                            put("title", buildJsonObject { put("type", "string") })
                            put(
                                "message",
                                buildJsonObject {
                                    put("type", "string")
                                    put("description", "Optional notification body.")
                                },
                            )
                        },
                    )
                    put("required", buildJsonArray { add(JsonPrimitive("title")) })
                },
            )
        },
    )
    add(
        buildJsonObject {
            put("name", "open_file")
            put("description", "Open a file in the workspace file viewer.")
            put(
                "parameters",
                buildJsonObject {
                    put("type", "object")
                    put(
                        "properties",
                        buildJsonObject {
                            put(
                                "path",
                                buildJsonObject {
                                    put("type", "string")
                                    put("description", "Absolute or workspace-relative file path.")
                                },
                            )
                        },
                    )
                    put("required", buildJsonArray { add(JsonPrimitive("path")) })
                },
            )
        },
    )
}

/**
 * The `set_host_uri_schemes` payload (web `HOST_URI_SCHEMES`):
 * `pi-web://clipboard` writes the device clipboard and reads it only after the
 * user consented in-app for that session.
 */
val HOST_URI_SCHEMES: JsonArray = buildJsonArray {
    add(
        buildJsonObject {
            put("scheme", "pi-web")
            put(
                "description",
                "App-integrated resources: pi-web://clipboard writes the user's clipboard and reads it after in-app consent.",
            )
            put("writable", true)
        },
    )
}

/**
 * Shared guard for URLs the app hands to the system (agent/extension
 * `open_url`, markdown links; web `isSafeOpenUrl`): only http, https and
 * mailto, no protocol-relative, no other scheme.
 */
fun isSafeOpenUrl(raw: String?): Boolean {
    if (raw == null) return false
    val url = raw.trim()
    if (url.isEmpty()) return false
    if (url.startsWith("//")) return false
    val match = Regex("^([a-zA-Z][a-zA-Z0-9+.-]*):").find(url) ?: return false
    return match.groupValues[1].lowercase() in SAFE_URL_SCHEMES
}

private val SAFE_URL_SCHEMES = setOf("http", "https", "mailto")

fun setHostToolsCommand(): JsonObject = buildJsonObject {
    put("type", "set_host_tools")
    put("tools", HOST_TOOL_DEFINITIONS)
}

fun setHostUriSchemesCommand(): JsonObject = buildJsonObject {
    put("type", "set_host_uri_schemes")
    put("schemes", HOST_URI_SCHEMES)
}

/** `host_tool_result {id,isError,result:{content:[{type:"text",text}]}}`. */
fun hostToolResultCommand(id: String, text: String, isError: Boolean): JsonObject = buildJsonObject {
    put("type", "host_tool_result")
    put("id", id)
    put("isError", isError)
    put(
        "result",
        buildJsonObject {
            put(
                "content",
                buildJsonArray {
                    add(
                        buildJsonObject {
                            put("type", "text")
                            put("text", text)
                        },
                    )
                },
            )
        },
    )
}

/** `host_uri_result` — a read answer carries content, a failure carries `isError` + `error`. */
fun hostUriResultCommand(
    id: String,
    content: String? = null,
    contentType: String? = null,
    error: String? = null,
): JsonObject = buildJsonObject {
    put("type", "host_uri_result")
    put("id", id)
    if (error != null) {
        put("isError", true)
        put("error", error)
    } else {
        if (content != null) {
            put("content", content)
            put("contentType", contentType ?: "text/plain")
        }
    }
}

/**
 * Reads and writes the device clipboard for `pi-web://clipboard`. The
 * controller holds the seam so it stays JVM-testable; the Android
 * implementation lives in `ui/hosttools/AndroidHostTools.kt`.
 */
interface ClipboardBridge {
    /** Current text, or null when the clipboard is empty or unreadable. */
    fun readText(): String?

    fun writeText(text: String)
}
