package io.github.kahme247.ompweb.net

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * The omp RPC calls side questions need (`btw`, `btw_cancel`,
 * `get_btw_history`, `get_state`), as an interface so the BTW view model runs
 * in JVM tests without a server.
 *
 * It is deliberately one method: all four are `POST /api/agent/{id}` commands
 * and the client treats them identically. Production uses [btwApi].
 */
interface BtwApi {
    /** `POST /api/agent/{sessionId}` with [command]; returns the reply's `data`. */
    suspend fun send(sessionId: String, command: JsonObject): JsonElement?
}

/**
 * The production [BtwApi]: omp's RPC route with the session's advisor flag off,
 * exactly like the web's `sendAgentCommand` (`hooks/useBtw.ts`).
 */
fun ApiClient.btwApi(): BtwApi = AgentBtwApi(this)

private class AgentBtwApi(private val client: ApiClient) : BtwApi {
    override suspend fun send(sessionId: String, command: JsonObject): JsonElement? =
        client.agentCommand(sessionId, command, advisor = false)
}
