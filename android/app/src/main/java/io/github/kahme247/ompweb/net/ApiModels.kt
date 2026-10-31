package io.github.kahme247.ompweb.net

import io.github.kahme247.ompweb.domain.ComposerImage
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/** `GET /api/app-info`: the capability handshake a native client requires. */
@Serializable
data class AppInfo(
    val name: String = "",
    val version: String = "",
    val api: Int = 0,
    val capabilities: Map<String, Boolean> = emptyMap(),
) {
    /**
     * `capabilities.messageSearch`: the server serves
     * `GET /api/sessions/messages/search`. A server that predates that route
     * omits the flag and answers the route with 404, so the app hides its
     * message search. The flag is deliberately not called `sessionSearch`:
     * `/api/sessions/search` belongs to the server's sidebar ranking, which
     * answers a different (NDJSON) shape.
     */
    val supportsMessageSearch: Boolean get() = capabilities["messageSearch"] == true
}

/**
 * One row of `GET /api/sessions` (server shape: `lib/types.ts` `SessionInfo`).
 * Unknown fields are ignored on purpose.
 */
@Serializable
data class SessionSummary(
    val id: String,
    val path: String = "",
    val cwd: String = "",
    val name: String? = null,
    val created: String = "",
    val modified: String = "",
    val messageCount: Int = 0,
    val firstMessage: String = "",
    val parentSessionId: String? = null,
    val projectRoot: String? = null,
    val projectKey: String? = null,
    val worktreeBranch: String? = null,
)

/** `POST /api/cwd/validate {cwd}` — the normalized checkout, or the route's error code. */
sealed interface CwdValidation {
    data class Valid(val cwd: String, val projectRoot: String?) : CwdValidation

    /** `path_required`, `directory_not_found`, `not_a_directory`, … */
    data class Invalid(val code: String?, val message: String?) : CwdValidation
}

/** One live omp child that the server still lists for the running badges. */
@Serializable
data class RunningSession(
    val id: String,
    val cwd: String = "",
)

/**
 * Another omp process owns a session (server `SessionElsewhere`): a second
 * omp-web instance, a terminal `omp --resume`, or — weakest — a session file
 * that was written recently and never closed. omp lets only one process write
 * a session, so a prompt from this app would move the chat to a copy; the
 * server answers that send with `409 session_running_elsewhere` unless the
 * user explicitly asks for the copy (`?force=1`).
 *
 * [kind] is `omp-web`/`terminal`, [source] `instance-list`/`process`/
 * `transcript` (strongest first), [running] means the owner is mid-turn and
 * [active] that it wrote within the server's activity window.
 * [lastActivityAt] is present only when the server read the session file, so
 * absence is normal (not "idle"). The owner's pid and cwd are never sent: no
 * client uses them and they leak the other instance/process.
 *
 * [id] exists only on the entries of `elsewhereSessions` (the list and the
 * `running` frame, one per session). The owner report of a single session
 * (`GET /api/agent/{id}`, the `409` body) is the server's `SessionElsewhere`
 * and carries no id: the chat already knows which session it asked about, so
 * a decode that insisted on an id would drop every live report.
 */
@Serializable
data class ElsewhereSession(
    val id: String = "",
    val kind: String = "",
    val source: String = "",
    val running: Boolean = false,
    val active: Boolean = false,
    val lastActivityAt: Long? = null,
)

/** One omp child that exited unexpectedly (`ExitedRpcSession`). */
@Serializable
data class ExitedSession(
    val id: String,
    val cwd: String = "",
    val at: Long = 0,
    val code: Int? = null,
    val signal: String? = null,
    val detail: String = "",
)

@Serializable
data class SessionList(
    val sessions: List<SessionSummary> = emptyList(),
    val runningSessionIds: List<String> = emptyList(),
    val runningSessions: List<RunningSession> = emptyList(),
    val exitedSessions: List<ExitedSession> = emptyList(),
    /**
     * Sessions another omp process owns. Deliberately apart from
     * `runningSessionIds`: those mean "this server runs a turn", which the
     * unread and notification rules depend on. An older server omits the
     * field, so it defaults to empty.
     */
    val elsewhereSessions: List<ElsewhereSession> = emptyList(),
)

private val elsewhereJson = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }

/**
 * One `elsewhere` payload (`GET /api/agent/{id}`, the `409` body), or null for
 * absent/`null`/malformed. A foreign-owner report must never fail the
 * surrounding answer, so the decode is tolerant.
 */
fun elsewhereFrom(element: JsonElement?): ElsewhereSession? {
    val obj = element as? JsonObject ?: return null
    return try {
        elsewhereJson.decodeFromJsonElement(ElsewhereSession.serializer(), obj)
    } catch (_: Exception) {
        null
    }
}

/**
 * The workspace-level omp launch configuration (`lib/types.ts`
 * `ProjectLaunchConfig`).
 */
@Serializable
data class ProjectLaunchConfig(
    val profile: String? = null,
    val advisor: Boolean? = null,
    val extraArgs: List<String>? = null,
) {
    fun isEmpty(): Boolean = profile.isNullOrBlank() && advisor != true && extraArgs.isNullOrEmpty()
}

/** One row of `GET /api/projects` (`ManagedProject`). */
@Serializable
data class ManagedProject(
    val path: String,
    val addedAt: String? = null,
    val alias: String? = null,
    val sortOrder: Int? = null,
    val launchConfig: ProjectLaunchConfig? = null,
)

@Serializable
data class ProjectList(val projects: List<ManagedProject> = emptyList())

@Serializable
data class ProjectResponse(val project: ManagedProject? = null)

/** `GET /api/sessions/{id}` — only the fields the session header needs. */
@Serializable
data class SessionInfo(
    val path: String = "",
    val id: String,
    val cwd: String = "",
    val name: String? = null,
    val created: String = "",
    val modified: String = "",
    val messageCount: Int = 0,
    val firstMessage: String = "",
    val parentSessionId: String? = null,
    val projectRoot: String? = null,
    val projectKey: String? = null,
    val worktreeBranch: String? = null,
)

@Serializable
data class SessionModel(
    val provider: String = "",
    @SerialName("modelId") val modelId: String = "",
)

/**
 * The context part of `GET /api/sessions/{id}`. Messages stay as raw JSON
 * elements: Phase 5 owns transcript rendering, the session header only needs
 * the model and the message count.
 */
@Serializable
data class SessionContext(
    val thinkingLevel: String = "auto",
    val model: SessionModel? = null,
    val messages: List<JsonObject> = emptyList(),
)

@Serializable
data class SessionDetail(
    val sessionId: String = "",
    val filePath: String = "",
    val info: SessionInfo? = null,
    val leafId: String? = null,
    val context: SessionContext? = null,
    /** Projected branch tree (`{entry,children[],…}`); parsed by the chat UI. */
    val tree: List<JsonObject> = emptyList(),
)

/** `GET /api/sessions/{id}/entries/{entryId}/thinking?blockIndex=` */
@Serializable
data class ThinkingResponse(val thinking: String = "")

/** `GET /api/sessions/{id}/subagents/{subagentId}?mode=completion` */
@Serializable
data class SubagentCompletion(
    val completion: String? = null,
    val truncated: Boolean = false,
)

/** `POST /api/agent/{id} {type:"fork", entryId}` — the new child session. */
@Serializable
data class ForkOutcome(
    val cancelled: Boolean = false,
    val newSessionId: String? = null,
    val text: String? = null,
)

/** The text answer of `GET /api/files/[...path]?type=read`. */
@Serializable
data class FileText(
    val content: String = "",
    val language: String? = null,
    val size: Long = 0,
)

/** A file read: JSON for text, raw bytes for images/audio/documents. */
sealed interface FileReadResult {
    data class Text(val content: String, val language: String?, val size: Long) : FileReadResult

    data class Binary(val bytes: ByteArray, val mimeType: String) : FileReadResult
}

/** The referenced bash output, or the server's refusal because it is too large. */
sealed interface BashOutputResult {
    data class Text(val output: String) : BashOutputResult

    data class TooLarge(val size: Long, val maxBytes: Long) : BashOutputResult
}

/** One row of `GET /api/sessions/archive` (`ArchivedSessionInfo`). */
@Serializable
data class ArchiveEntry(
    val key: String,
    val id: String,
    val cwd: String = "",
    val name: String? = null,
    val created: String = "",
    val archivedAt: String = "",
    val messageCount: Int = 0,
    val firstMessage: String = "",
    val size: Long = 0,
    val status: String = "",
)

@Serializable
data class ArchiveList(val archives: List<ArchiveEntry> = emptyList())

@Serializable
data class RestoreArchiveResponse(val ok: Boolean = false, val sessionId: String? = null)

@Serializable
data class DirectoryEntry(val name: String, val path: String)

@Serializable
data class BrowseResponse(
    val path: String = "",
    val parentPath: String? = null,
    val directories: List<DirectoryEntry> = emptyList(),
    val drives: List<DirectoryEntry>? = null,
)

@Serializable
data class DefaultCwd(val cwd: String = "")

@Serializable
data class HomeDirectory(val home: String = "")

@Serializable
data class WorktreeEntry(
    val path: String,
    val branch: String? = null,
    val isMain: Boolean = false,
)

@Serializable
data class WorktreeList(
    val projectRoot: String = "",
    val projectKey: String? = null,
    val isGit: Boolean = false,
    val isTopLevel: Boolean = false,
    val currentWorktreePath: String? = null,
    val worktrees: List<WorktreeEntry> = emptyList(),
)

@Serializable
data class ModelEntry(
    val id: String,
    val name: String = "",
    val provider: String = "",
    val thinkingLevels: List<String> = emptyList(),
    val supportsFastMode: Boolean = false,
    val supportsSlowMode: Boolean = false,
    val contextWindow: Int? = null,
    val maxTokens: Int? = null,
)

@Serializable
data class DefaultModel(val provider: String = "", val modelId: String = "")

/** `GET /api/models?cwd=` — the live model catalog used by the new session picker. */
@Serializable
data class ModelsResponse(
    val models: Map<String, String> = emptyMap(),
    val modelList: List<ModelEntry> = emptyList(),
    val defaultModel: DefaultModel? = null,
    val thinkingLevels: Map<String, List<String>> = emptyMap(),
    /** Providers whose catalog entries carry a pre-spawn Slow tier (anthropic). */
    val anthropicSlowMode: Boolean = false,
    /** Logged-in providers omp reports (`/api/models`); the registry panel lists them. */
    val connectedProviders: List<ConnectedProvider> = emptyList(),
)

/** One logged-in provider as `/api/models` reports it (no credentials). */
@Serializable
data class ConnectedProvider(
    val id: String = "",
    val name: String = "",
    val disabled: Boolean = false,
)

@Serializable
data class AutoNameResponse(
    val title: String = "",
    val generated: Boolean = false,
)

@Serializable
data class AgentNewResponse(
    val success: Boolean = false,
    val sessionId: String = "",
)

/** One entry of omp's `abort_and_restore_queue` reply. */
data class QueuedMessagePayload(val text: String, val images: List<ComposerImage>)

/** `{steering:[...], followUp:[...]}` withdrawn by `abort_and_restore_queue`. */
data class QueueRestore(
    val steering: List<QueuedMessagePayload> = emptyList(),
    val followUp: List<QueuedMessagePayload> = emptyList(),
) {
    val entries: List<QueuedMessagePayload> get() = steering + followUp
    val isEmpty: Boolean get() = steering.isEmpty() && followUp.isEmpty()
}

/** `remove_queued_message` reply: `{removed, images?}`. */
data class QueuedMessageRemoval(val removed: Boolean, val images: List<ComposerImage> = emptyList())

@Serializable
data class SkillInfo(
    val name: String = "",
    val disableModelInvocation: Boolean = false,
)

/** `GET /api/skills?cwd=` — the skill roster plus scanner diagnostics. */
@Serializable
data class SkillsResponse(
    val skills: List<SkillInfo> = emptyList(),
    val diagnostics: List<String> = emptyList(),
)

/**
 * The agent route answers a prompt/steer with
 * `{queued:true, queue:"followUp", reason:"shellRunning"}` when a `!!` shell
 * command owns the session: the text went into omp's queue, no turn started.
 */
fun isQueuedWhileShellRunning(reply: JsonElement?): Boolean {
    val root = reply as? JsonObject ?: return false
    val queued = (root["queued"] as? JsonPrimitive)?.booleanOrNull == true
    val reason = (root["reason"] as? JsonPrimitive)?.contentOrNull
    return queued && reason == "shellRunning"
}

/** Read the `{data, mimeType}` images of one RPC payload (invalid entries dropped). */
fun imagesFromRpc(element: JsonElement?): List<ComposerImage> {
    val array = element as? JsonArray ?: return emptyList()
    return array.mapNotNull { item ->
        val entry = item as? JsonObject ?: return@mapNotNull null
        // omp's queue snapshot may wrap images as `{type:"image", data, mimeType}`.
        val data = (entry["data"] as? JsonPrimitive)?.contentOrNull ?: return@mapNotNull null
        val mimeType = (entry["mimeType"] as? JsonPrimitive)?.contentOrNull ?: return@mapNotNull null
        ComposerImage(data = data, mimeType = mimeType)
    }
}
