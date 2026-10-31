package io.github.kahme247.ompweb.net

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * The `POST /api/agent/{id}` calls the extension-UI and host-tool controllers
 * make (`extension_ui_response`, `extension_ui_input`, `set_host_tools`,
 * `host_tool_result`, `host_uri_result`, …).
 *
 * Kept apart from [ChatApi]/[ComposerControlsApi] so those interfaces stay the
 * surfaces the chat and composer view models implement in tests; the single
 * method is exactly their `agentCommand`.
 */
interface ExtensionApi {

    /** One omp RPC command; returns the route's `data` field (null for fire-and-forget). */
    suspend fun command(sessionId: String, command: JsonObject): JsonElement?
}

/** Production [ExtensionApi]: [ApiClient]'s public `agentCommand`. */
class AgentExtensionApi(private val commands: ComposerControlsApi) : ExtensionApi {

    override suspend fun command(sessionId: String, command: JsonObject): JsonElement? =
        commands.agentCommand(sessionId, command)
}
