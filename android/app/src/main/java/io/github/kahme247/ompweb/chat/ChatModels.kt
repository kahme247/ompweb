package io.github.kahme247.ompweb.chat

import kotlinx.serialization.json.JsonObject

/** An image carried by a message. Only one of [url] / [base64] is set. */
data class ChatImage(
    val mimeType: String?,
    val url: String? = null,
    val base64: String? = null,
) {
    val isEmpty: Boolean
        get() = url.isNullOrBlank() && base64.isNullOrBlank()
}

/**
 * One block of an assistant message, normalized across the two shapes omp
 * uses on the wire (`id`/`name`/`arguments` while streaming,
 * `toolCallId`/`toolName`/`input` in the session file).
 */
sealed interface AssistantBlock {
    data class Text(val text: String) : AssistantBlock

    data class Thinking(
        val thinking: String,
        /** True when the server replaced the body by a placeholder (`deferThinking=1`). */
        val deferred: Boolean,
        /** Source content index, for `GET .../thinking?blockIndex=`. */
        val blockIndex: Int,
    ) : AssistantBlock

    data class ToolCall(
        val toolCallId: String,
        val toolName: String,
        val input: JsonObject,
    ) : AssistantBlock

    data class Image(val image: ChatImage) : AssistantBlock

    data class Other(val type: String) : AssistantBlock
}

/**
 * One committed (or currently streaming) transcript message. [key] is stable
 * for the lifetime of the row: the entry id when the server gave one, a
 * synthetic identity otherwise.
 */
sealed interface ChatMessage {
    val key: String
    val timestamp: Long?
    val entryId: String?

    data class User(
        override val key: String,
        override val timestamp: Long?,
        override val entryId: String?,
        val text: String,
        val images: List<ChatImage> = emptyList(),
        /** A compaction branch summary renders like a user row but cannot be forked. */
        val branchSummary: Boolean = false,
    ) : ChatMessage

    data class Assistant(
        override val key: String,
        override val timestamp: Long?,
        override val entryId: String?,
        val blocks: List<AssistantBlock>,
        val model: String? = null,
        val provider: String? = null,
        val stopReason: String? = null,
        val errorMessage: String? = null,
        val durationMs: Double? = null,
        val streaming: Boolean = false,
        /** `usage.output` of the finished message (thinking tokens included). */
        val usageOutput: Int? = null,
        /** Time to first token in ms; excluded from the generation rate. */
        val ttftMs: Double? = null,
        /** When omp finished the message (ms); fallback span without `duration`. */
        val completedAt: Long? = null,
    ) : ChatMessage

    data class ToolResult(
        override val key: String,
        override val timestamp: Long?,
        override val entryId: String?,
        val toolCallId: String,
        val toolName: String,
        val text: String,
        val images: List<ChatImage> = emptyList(),
        val details: JsonObject? = null,
        val isError: Boolean = false,
        /** A live `partialResult` snapshot for a tool that is still running. */
        val partial: Boolean = false,
        /** Passive developer context attached to the batch's last tool card. */
        val passiveContext: String? = null,
    ) : ChatMessage

    data class BashExecution(
        override val key: String,
        override val timestamp: Long?,
        override val entryId: String?,
        val command: String,
        val output: String?,
        val exitCode: Int?,
        val cancelled: Boolean = false,
        val fullOutputPath: String? = null,
    ) : ChatMessage

    data class Custom(
        override val key: String,
        override val timestamp: Long?,
        override val entryId: String?,
        val customType: String,
        val text: String,
        val details: JsonObject? = null,
        val display: Boolean = true,
    ) : ChatMessage

    /** A role this phase does not render (e.g. an unknown extension message). */
    data class Other(
        override val key: String,
        override val timestamp: Long?,
        override val entryId: String?,
        val role: String,
    ) : ChatMessage
}

/** A running tool, driven by `tool_execution_*` frames. */
data class LiveTool(
    val toolCallId: String,
    val toolName: String,
    val args: JsonObject?,
    val result: ChatMessage.ToolResult?,
    val startedAt: Long,
    val endedAt: Long? = null,
    val isError: Boolean = false,
) {
    val running: Boolean
        get() = endedAt == null && result?.partial != true
}

/** One tool omp is currently executing, as the status line names it. */
data class RunningTool(val id: String, val name: String)

/**
 * What the running turn waits on (web `AgentPhase`): the model finishing its
 * reply, a shell command, or the tools it called.
 */
sealed interface AgentPhase {
    data object WaitingModel : AgentPhase

    data object RunningCommand : AgentPhase

    data class RunningTools(val tools: List<RunningTool>) : AgentPhase
}

enum class NoticeKind { Info, Warning, Error }

data class ChatNotice(
    val kind: NoticeKind,
    val message: String,
    val createdAt: Long,
)

data class QueueSnapshot(
    val steering: List<String> = emptyList(),
    val followUp: List<String> = emptyList(),
)

data class ModelRef(val provider: String, val id: String, val name: String? = null)

data class ContextUsage(val tokens: Int, val contextWindow: Int, val percent: Double)

data class AutoRetry(val attempt: Int?, val maxAttempts: Int?, val message: String?)

/**
 * The outcome of a compaction, shown as a transient banner (web
 * `CompactResultInfo`). `reason` is `auto` for `auto_compaction_end` and
 * `manual` for the RPC `/compact`.
 */
data class CompactResult(val reason: String, val tokensBefore: Long, val estimatedTokensAfter: Long)

/** An optimistic user row that has not been committed by the server yet. */
data class PendingUser(val text: String)

/**
 * omp moved a chat to a copy because another process held the file
 * (`session_contention_fork`). The original stayed with that process; the copy
 * is the conversation this app keeps writing into.
 */
data class ContentionCopy(val originalId: String, val copyId: String?)

/** The engine-owned chat state. Rendered state is derived from it. */
data class ChatState(
    val sessionId: String? = null,
    val messages: List<ChatMessage> = emptyList(),
    val entryIds: List<String> = emptyList(),
    val pendingUser: PendingUser? = null,
    val streaming: ChatMessage.Assistant? = null,
    val liveTools: List<LiveTool> = emptyList(),
    val notices: List<ChatNotice> = emptyList(),
    /** Terminal run error shown above the composer until the next prompt. */
    val error: String? = null,
    val agentRunning: Boolean = false,
    val promptRunning: Boolean = false,
    val streamingActive: Boolean = false,
    /** What the running turn waits on; null while nothing runs. */
    val agentPhase: AgentPhase? = null,
    val compacting: Boolean = false,
    val autoRetry: AutoRetry? = null,
    val model: ModelRef? = null,
    val thinkingLevel: String? = null,
    val contextUsage: ContextUsage? = null,
    val tokensPerSecond: Double? = null,
    /** Live estimate from the streamed text/thinking deltas; null when it is not measurable. */
    val liveTokensPerSecond: Double? = null,
    val queue: QueueSnapshot = QueueSnapshot(),
    /** Bumped by every `queue_update`; a slower `get_state` answer must not override a newer queue. */
    val queueRevision: Long = 0,
    val leafId: String? = null,
    val includePreCompaction: Boolean = false,
    /** True once the first context page arrived; drives the loading state. */
    val historyLoaded: Boolean = false,
    val historyLoading: Boolean = false,
    /**
     * The transcript on screen came from the disk cache and the server answer
     * is still on its way. Cleared by the first real page (or by its failure),
     * so a cached view can never outlive the live one.
     */
    val historyStale: Boolean = false,
    /**
     * Something about the live run has been observed for this session: a frame
     * on its event stream or a `GET /api/agent/{id}` snapshot. While it is
     * false the screen shows only history (disk cache first) and must not
     * present "nothing runs" as a fact — the footer says *Connecting…* until
     * an answer settles it.
     */
    val liveStateKnown: Boolean = false,
    val historyError: String? = null,
    /** True while older pages are still being fetched (`hasMore` from the server). */
    val pagesLoading: Boolean = false,
    /** Run generation; stale async completions compare against it. */
    val runId: Long = 0,
    /**
     * When the current run's prompt was sent. The turn timer measures from
     * here, so a tool start or a steering message never resets it; null for a
     * run this client did not start (the timer then falls back to the
     * transcript).
     */
    val runStartedAt: Long? = null,
    /** How many runs ended; a stop only targets the run it was clicked on. */
    val runsEnded: Long = 0,
    /** omp's slash command roster (`get_commands` / `available_commands_update`). */
    val remoteCommands: List<io.github.kahme247.ompweb.domain.SlashCommandItem> = emptyList(),
    /** omp-web's own `!` / `!!` shell command is running (`bash` RPC). */
    val bashRunning: Boolean = false,
    /** The live todo plan (`get_state` / context pages), shown above the composer. */
    val todoPhases: List<io.github.kahme247.ompweb.domain.TodoPhase> = emptyList(),
    /** Roster fed by `subagent_lifecycle`/`subagent_progress`/`get_subagents`/history. */
    val subagents: List<io.github.kahme247.ompweb.domain.SubagentInfo> = emptyList(),
    /** Bounded per-subagent activity buffer for the transcript dialog. */
    val subagentActivity: Map<String, List<io.github.kahme247.ompweb.domain.SubagentActivityEvent>> = emptyMap(),
    /** Per-subagent revision bumped by `subagent_event`; the dialog debounces refetches. */
    val subagentVersions: Map<String, Long> = emptyMap(),
    /**
     * omp's skill-resolution report (`get_state.skillDiagnostics` and
     * `skill_diagnostics_update`); null while the server has none.
     */
    val skillDiagnostics: io.github.kahme247.ompweb.domain.SkillDiagnosticsSnapshot? = null,
    /** Bumped by every applied report; a slower `get_state` answer must not override a newer one. */
    val skillDiagnosticsRevision: Long = 0,
    /**
     * Another omp process owns this session (`GET /api/agent/{id}.elsewhere`,
     * the `409` body, a `running` frame). While it is set, a send would move
     * the chat to a copy, so the screen shows the owner and asks before
     * sending. Cleared by a snapshot without one and by a locally proven run.
     */
    val foreignRun: io.github.kahme247.ompweb.net.ElsewhereSession? = null,
) {
    val busy: Boolean
        get() = agentRunning || promptRunning || compacting
}
