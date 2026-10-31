package io.github.kahme247.ompweb.net

import io.github.kahme247.ompweb.domain.ComposerImage
import io.github.kahme247.ompweb.domain.SlashCommandItem
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * The [ApiClient] calls the chat view model makes, as an interface so the view
 * model runs in JVM tests without a server.
 *
 * Signatures are exactly the `ApiClient` ones. `ChatViewModelTest` supplies a
 * fake; production wires [ApiClient], which implements this interface.
 */
interface ChatApi {

    /**
     * `POST /api/agent/{id} {type:"prompt"}` with optional images and
     * streaming behavior. [force] sends `?force=1`: the server's gate against
     * a session another omp process owns is skipped, on purpose and only after
     * the user confirmed that the send goes into a copy.
     */
    suspend fun prompt(
        sessionId: String,
        message: String,
        images: List<ComposerImage> = emptyList(),
        streamingBehavior: String? = null,
        force: Boolean = false,
    ): JsonElement?

    /** `GET /api/agent/{id}` — `{running, alive, state}` for reconciliation. */
    suspend fun agentState(sessionId: String): JsonObject

    /**
     * `GET /api/sessions` — the ids this server currently runs a turn for.
     * The last-resort authority for a 503 that does not report the run state
     * (older server); it is the same registry the session list shows.
     */
    suspend fun runningSessionIds(): List<String>

    suspend fun abort(sessionId: String): JsonElement?

    /** `{type:"abort_retry"}` — stop the automatic retry banner's wait. */
    suspend fun abortRetry(sessionId: String): JsonElement?

    /** `{type:"steer"}` — deliver [message] into the running turn. */
    suspend fun steer(sessionId: String, message: String, images: List<ComposerImage> = emptyList()): JsonElement?

    /** `{type:"follow_up"}` — queue [message] behind the running turn. */
    suspend fun followUp(sessionId: String, message: String, images: List<ComposerImage> = emptyList()): JsonElement?

    /** `{type:"bash", command, excludeFromContext}` (composer `!` / `!!`). */
    suspend fun bash(sessionId: String, command: String, excludeFromContext: Boolean): JsonElement?

    /** `{type:"abort_bash"}` — stop a `!!` shell command. */
    suspend fun abortBash(sessionId: String): JsonElement?

    /** `{type:"abort_and_restore_queue"}` — take pending messages back and abort. */
    suspend fun abortAndRestoreQueue(sessionId: String): QueueRestore

    /** `{type:"remove_queued_message", message, queue}`. */
    suspend fun removeQueuedMessage(sessionId: String, message: String, queue: String): QueuedMessageRemoval

    /** `{type:"promote_queued_message", message}` — move a follow-up into steering. */
    suspend fun promoteQueuedMessage(sessionId: String, message: String): Boolean

    /** `{type:"get_commands"}` — omp's slash command roster. */
    suspend fun commands(sessionId: String): List<SlashCommandItem>

    /** `{type:"compact"}` with optional custom instructions. */
    suspend fun compact(sessionId: String, customInstructions: String? = null): JsonElement?

    /** `{type:"reload"}` — re-read extensions, skills and prompts. */
    suspend fun reload(sessionId: String): JsonElement?

    /** `{type:"set_session_name"}`. */
    suspend fun setSessionName(sessionId: String, name: String): JsonElement?

    /** `{type:"get_last_assistant_text"}` — text for `/copy`. */
    suspend fun lastAssistantText(sessionId: String): String?

    /** `GET /api/skills?cwd=` — skill names and their model-invocation state. */
    suspend fun skills(cwd: String): SkillsResponse

    /** `GET /api/sessions/{id}/context?sync=1` — one display-history page plus the live snapshot. */
    suspend fun contextSync(
        sessionId: String,
        cursor: String? = null,
        leafId: String? = null,
        includePreCompaction: Boolean = false,
        deferThinking: Boolean = true,
        deferMedia: Boolean = true,
    ): JsonObject

    /** `GET /api/sessions/{id}/context` — the whole display history in one response (web `loadContext`). */
    suspend fun contextFull(
        sessionId: String,
        leafId: String? = null,
        includePreCompaction: Boolean = false,
        deferThinking: Boolean = true,
        deferMedia: Boolean = true,
    ): JsonObject

    /**
     * The same response as [contextFull], as the body the server sent. The
     * chat writes it to the offline cache and parses a cached open from it,
     * so a cached transcript is exactly what the live request would have
     * produced.
     *
     * The default re-renders the parsed object, which is what a test fake
     * needs; [ApiClient] overrides it to hand back the received bytes.
     */
    suspend fun contextFullRaw(
        sessionId: String,
        leafId: String? = null,
        includePreCompaction: Boolean = false,
        deferThinking: Boolean = true,
        deferMedia: Boolean = true,
    ): String = contextFull(sessionId, leafId, includePreCompaction, deferThinking, deferMedia).toString()

    suspend fun sessionDetail(id: String): SessionDetail

    /** `GET /api/github-repo?cwd=` — `owner/repo` for the checkout, or null. */
    suspend fun githubRepo(cwd: String): String?

    suspend fun forkSession(sessionId: String, entryId: String): ForkOutcome

    /** `GET .../entries/{entryId}/thinking?blockIndex=` for a deferred thinking block. */
    suspend fun thinking(sessionId: String, entryId: String, blockIndex: Int): String

    suspend fun bashOutput(sessionId: String, path: String): BashOutputResult

    suspend fun bashOutputBytes(sessionId: String, path: String): ByteArray

    suspend fun subagentCompletion(sessionId: String, subagentId: String): SubagentCompletion

    /** `{type:"get_subagents"}` — the live registry roster (`{subagents:[…]}`). */
    suspend fun subagents(sessionId: String): JsonElement?

    /** `GET /api/sessions/{id}/subagents` — the on-disk roster, without a live process. */
    suspend fun subagentHistory(sessionId: String): JsonElement?

    /**
     * `{type:"get_subagent_messages", subagentId, sessionFile, fromByte}` — one
     * transcript page from the live registry (same shape as the disk route).
     */
    suspend fun subagentTranscript(
        sessionId: String,
        subagentId: String,
        sessionFile: String?,
        fromByte: Long,
    ): JsonElement?

    /** `GET .../subagents/{subagentId}?fromByte=` — the disk fallback for a page. */
    suspend fun subagentTranscriptDisk(sessionId: String, subagentId: String, fromByte: Long): JsonElement?

    /** `POST /api/cwd/validate` — used when restoring a remembered workspace. */
    suspend fun validateCwd(cwd: String): CwdValidation
}
