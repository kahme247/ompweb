package io.github.kahme247.ompweb.chat

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import io.github.kahme247.ompweb.domain.SUBAGENT_ACTIVITY_BUFFER_MAX
import io.github.kahme247.ompweb.net.ElsewhereSession
import io.github.kahme247.ompweb.domain.SkillDiagnosticsSnapshot
import io.github.kahme247.ompweb.domain.SubagentAgentSource
import io.github.kahme247.ompweb.domain.SubagentInfo
import io.github.kahme247.ompweb.domain.SubagentSource
import io.github.kahme247.ompweb.domain.parseSubagentActivityEvent
import io.github.kahme247.ompweb.domain.parseSubagentLifecycle
import io.github.kahme247.ompweb.domain.parseSubagentProgress
import io.github.kahme247.ompweb.domain.parseSkillDiagnosticsSnapshot
import io.github.kahme247.ompweb.domain.parseTodoPhases
import io.github.kahme247.ompweb.domain.mergeSubagentRoster
import io.github.kahme247.ompweb.domain.pruneSubagentIds
import kotlin.math.roundToLong

/** One-shot side effects the view model executes after a frame batch. */
sealed interface ChatEffect {
    /** Reload the display history; `reset` re-reads from the start. */
    data class RequestContext(val reset: Boolean) : ChatEffect

    /** Ask the view model to re-read `GET /api/agent/{id}` for a run snapshot. */
    data object RequestAgentState : ChatEffect

    /** Speak the latest assistant reply when autoplay is enabled. */
    data object SpeakLastReply : ChatEffect

    /** Play the completion tone (`omp-sound-enabled`), on every terminal `agent_end`. */
    data object PlayCompletionTone : ChatEffect

    /** Show the compaction summary banner (auto-dismiss after 6 s). */
    data class ShowCompactResult(val result: CompactResult) : ChatEffect

    /** Show a failed compaction (auto-dismiss after 3 s). */
    data class ShowCompactError(val message: String) : ChatEffect

    /** Re-read the live roster and the on-disk history after a run ended. */
    data object RefreshSubagents : ChatEffect

    /** The session SSE (re)connected: side questions and the roster re-read silently. */
    data object StreamOpened : ChatEffect

    /**
     * omp moved this conversation to a copy because another process held the
     * file. [fromId] is the original (still the other process's); [toId] is the
     * copy. The screens offer opening either one.
     */
    data class ContentionFork(val fromId: String, val toId: String?) : ChatEffect
}

/**
 * The chat state machine (Slice E of Phase 5).
 *
 * All transcript, run and live-tool state is derived from SSE frames, context
 * syncs and agent-state snapshots. The engine is transport-free: the view
 * model feeds frames, API pages and agent state in and executes the returned
 * effects. This is what the fixture-driven unit tests drive.
 */
class ChatEngine(
    private val now: () -> Long = { System.currentTimeMillis() },
    scheduler: FlushScheduler? = null,
    /** Side-question frames never touch the transcript; the view model owns them. */
    private val onBtwFrame: ((JsonObject) -> Unit)? = null,
) {
    private val _state = MutableStateFlow(ChatState())
    val state: StateFlow<ChatState> = _state.asStateFlow()

    private val coalescer = ChatFrameCoalescer(
        ::handleFrame,
        scheduler ?: { flush -> flush(); {} },
    )
    private val effects = ArrayList<ChatEffect>()

    private var streamId: String? = null
    private var messageSequence = 0L
    private var lifecycleSequence = 0L
    private var toolsSnapshotSequence = 0L
    private val toolSequences = HashMap<String, Long>()
    private var lastLiveSequence = -1L
    private var lastLiveStreamId: String? = null

    private var runHadContent = false
    private var lastRunError: String? = null
    /**
     * Bumped whenever the roster is cleared. An in-flight `get_subagents` or
     * history response captured before the clear must not merge into the new
     * roster (web `subagentRosterGenerationRef`).
     */
    private var subagentGeneration = 0L
    /**
     * The prompt ack timed out but omp may already hold the frame
     * (`session_slow` + `maybeStarted`). The run stays active (sending stays
     * locked) and an apparently empty completion repeats the hint instead of
     * claiming the agent stopped without a response.
     */
    private var maybeStartedRun = false
    /**
     * A run ended without a visible answer (e.g. its frames were lost to a
     * reconnect). The classification waits for the reload: the session file
     * may already hold the reply (web `finishPromptWithoutStream`).
     */
    private var awaitingResponseCheck = false
    /** Rows committed from frames that no context page has confirmed yet. */
    private val unconfirmed = LinkedHashMap<String, ChatMessage>()

    /** Live tokens/s estimate of the current assistant message (see [StreamRateTracker]). */
    private val streamRate = StreamRateTracker()
    private var lastRatePublishAt = 0L
    private var lastPublishedRate: Double? = null

    // ---------------------------------------------------------------- public API

    fun setSession(sessionId: String?, leafId: String? = null) {
        coalescer.reset()
        resetStreamRate()
        effects.clear()
        streamId = null
        messageSequence = 0
        lifecycleSequence = 0
        toolsSnapshotSequence = 0
        toolSequences.clear()
        lastLiveSequence = -1
        lastLiveStreamId = null
        runHadContent = false
        lastRunError = null
        awaitingResponseCheck = false
        maybeStartedRun = false
        unconfirmed.clear()
        subagentGeneration += 1
        _state.value = ChatState(
            sessionId = sessionId,
            leafId = leafId,
            historyLoading = sessionId != null,
        )
        if (sessionId != null) effects += ChatEffect.RequestContext(reset = true)
    }

    fun onFrame(frame: JsonObject) {
        coalescer.push(frame)
    }

    /** The roster generation a hydration request must still match to apply. */
    fun subagentGeneration(): Long = subagentGeneration

    /** Fold roster entries into the current roster (live frames win over history). */
    fun mergeSubagents(incoming: List<SubagentInfo>, skipNewerThan: Long? = null) {
        if (incoming.isEmpty()) return
        _state.update {
            it.copy(subagents = mergeSubagentRoster(it.subagents, incoming, skipNewerThan))
                .withSettledSubagents()
        }
    }

    /**
     * Roster with the transcript's async-result deliveries applied: a detached
     * task never gets a lifecycle frame, so its end is only provable from the
     * transcript (see `settleSubagentsFromAsyncResults`).
     */
    private fun ChatState.withSettledSubagents(): ChatState {
        if (subagents.isEmpty()) return this
        val settled = settleSubagentsFromAsyncResults(subagents, messages)
        return if (settled === subagents) this else copy(subagents = settled)
    }

    /**
     * Drop live entries the registry no longer knows: omp deletes a subagent
     * before `get_subagents` answers once its lifecycle went terminal, so a
     * missing entry means a terminal frame was missed. Entries touched after
     * the snapshot was requested are newer than it and survive.
     */
    fun pruneLiveSubagents(snapshotIds: Set<String>, requestedAt: Long) {
        _state.update { state ->
            val next = state.subagents.filter { entry ->
                entry.source == io.github.kahme247.ompweb.domain.SubagentSource.HISTORY ||
                    entry.id in snapshotIds ||
                    (entry.lastUpdate ?: 0L) >= requestedAt
            }
            if (next.size == state.subagents.size) state else state.copy(subagents = next)
        }
    }

    fun flush() {
        coalescer.flush()
    }

    /** Drain the effects accumulated since the last call. */
    fun drainEffects(): List<ChatEffect> {
        if (effects.isEmpty()) return emptyList()
        val drained = ArrayList<ChatEffect>(effects.size)
        for (effect in effects) {
            if (drained.lastOrNull() == effect) continue
            drained += effect
        }
        effects.clear()
        return drained
    }

    /**
     * Start an optimistic prompt run. [command] marks a slash command, which
     * omp answers without a model turn (web `running_command`).
     */
    fun sendStarted(text: String, runId: Long, command: Boolean = false) {
        resetStreamRate()
        val snapshot = _state.value
        _state.value = snapshot.copy(
            runId = runId,
            runStartedAt = now(),
            pendingUser = PendingUser(text),
            agentRunning = true,
            promptRunning = true,
            streamingActive = false,
            streaming = null,
            liveTokensPerSecond = null,
            liveTools = emptyList(),
            error = null,
            autoRetry = null,
            agentPhase = if (command) AgentPhase.RunningCommand else AgentPhase.WaitingModel,
            // The prompt is on its way to a live session; the screen must not
            // fall back to "Connecting…" over the turn it just started.
            liveStateKnown = true,
            // This app started the run: it owns the session now (a user who
            // chose "send anyway (copy)" gets the copy's run).
            foreignRun = null,
        )
        runHadContent = false
        lastRunError = null
        awaitingResponseCheck = false
        maybeStartedRun = false
        coalescer.reset()
    }

    fun sendFailed(message: String?) {
        resetStreamRate()
        _state.update {
            it.copy(
                pendingUser = null,
                agentRunning = false,
                promptRunning = false,
                streamingActive = false,
                streaming = null,
                liveTokensPerSecond = null,
                liveTools = emptyList(),
                agentPhase = null,
                runStartedAt = null,
            )
        }
        coalescer.reset()
        if (!message.isNullOrBlank()) addNotice(NoticeKind.Error, message)
    }

    /**
     * The prompt ack timed out while omp was busy: the message may already be
     * running. Keep the optimistic turn and the run state (so sending stays
     * locked) and only add the hint; the next frame or successful agent-state
     * snapshot settles the run normally.
     */
    fun promptMaybeStarted(message: String?) {
        maybeStartedRun = true
        addNotice(NoticeKind.Warning, message?.ifBlank { null } ?: "omp is busy — your message may still be running.")
    }

    /**
     * Another omp process owns this session, as the server just reported (a
     * `409 session_running_elsewhere` body or a state snapshot). The banner
     * and the send gate read it; a proven local run clears it.
     */
    fun setForeignRun(elsewhere: ElsewhereSession?) {
        if (_state.value.foreignRun == elsewhere) return
        _state.update { it.copy(foreignRun = elsewhere) }
    }

    /** The prompt was accepted into a queue instead of starting a run. */
    fun promptQueued(message: String?) {
        _state.update {
            it.copy(
                pendingUser = null,
                agentRunning = false,
                promptRunning = false,
                streamingActive = false,
                streaming = null,
                agentPhase = null,
            )
        }
        addNotice(NoticeKind.Info, message?.ifBlank { null } ?: "Message queued")
    }

    fun abortSent() {
        addNotice(NoticeKind.Info, "Stopping…")
    }

    /** omp-web's own `!`/`!!` shell command took the session (`bash` RPC). */
    fun bashStarted() {
        _state.update { it.copy(bashRunning = true, error = null) }
    }

    /** The `bash` RPC answered (successfully or not): the live row goes away. */
    fun bashFinished() {
        _state.update { it.copy(bashRunning = false) }
    }

    /** Surface a view-model level message in the chat's notice stack. */
    fun notify(kind: NoticeKind, message: String) {
        if (message.isNotBlank()) addNotice(kind, message)
    }

    fun setIncludePreCompaction(include: Boolean) {
        if (_state.value.includePreCompaction == include) return
        _state.update { it.copy(includePreCompaction = include, historyLoading = true) }
        effects += ChatEffect.RequestContext(reset = true)
    }

    fun setLeaf(leafId: String?) {
        _state.update { it.copy(leafId = leafId, historyLoading = true) }
        effects += ChatEffect.RequestContext(reset = true)
    }

    fun historyRequestFailed(message: String) {
        _state.update {
            // A cached transcript that is on screen keeps the chat usable: it
            // becomes the loaded state, so the failure offers a retry banner
            // above it instead of the full-pane load error.
            val seeded = it.historyStale
            it.copy(
                historyLoading = false,
                pagesLoading = false,
                historyStale = false,
                historyLoaded = it.historyLoaded || seeded,
                historyError = if (it.historyLoaded && !seeded) null else message,
            )
        }
    }

    /**
     * Paint a transcript read from the disk cache while the server answer is
     * still on its way (cache-first open).
     *
     * Refuses whenever the engine already has content — a live frame or a
     * context page that arrived first always wins — and never seeds the live
     * half of the page (stream cursors, tool state), which only the server may
     * report.
     */
    fun seedCachedHistory(page: ContextPage): Boolean {
        val state = _state.value
        if (state.historyLoaded || state.messages.isNotEmpty() || state.entryIds.isNotEmpty()) return false
        if (page.messages.isEmpty()) return false
        _state.update {
            it.copy(
                messages = page.messages,
                entryIds = page.entryIds,
                leafId = page.leafId ?: it.leafId,
                thinkingLevel = page.thinkingLevel ?: it.thinkingLevel,
                model = page.model ?: it.model,
                historyStale = true,
            ).withSettledSubagents()
        }
        return true
    }

    fun pagesLoading(loading: Boolean) {
        _state.update { it.copy(pagesLoading = loading) }
    }

    /** Apply one context-sync page (display history + live snapshot). */
    fun applyContextPage(page: ContextPage) {
        val state = _state.value
        if (page.sessionId != null && state.sessionId != null && page.sessionId != state.sessionId) return
        val pageIdentities = page.messages.mapTo(HashSet()) { it.identity() }
        unconfirmed.keys.filter { it in pageIdentities }.forEach { unconfirmed.remove(it) }

        val messages: MutableList<ChatMessage>
        val entryIds: MutableList<String>
        if (state.messages.isEmpty() && !state.historyLoaded) {
            messages = page.messages.toMutableList()
            entryIds = page.entryIds.toMutableList()
        } else if (page.mode == "append" && page.baseEntryId == state.entryIds.lastOrNull()) {
            messages = state.messages.toMutableList()
            // Ids must stay index-aligned with the messages: a frame-committed
            // row has no id yet, so it keeps a blank slot until a page names it.
            entryIds = state.entryIds.toMutableList()
            while (entryIds.size < messages.size) entryIds += ""
            val seen = entryIds.filter { it.isNotEmpty() }.toHashSet()
            for (index in page.entryIds.indices) {
                val id = page.entryIds[index]
                if (id.isNotEmpty() && !seen.add(id)) continue
                val incoming = page.messages[index]
                // A frame-committed row lacks the entry id the page now has;
                // the page row replaces it in place instead of duplicating it.
                val existingIndex = messages.indexOfFirst { it.identity() == incoming.identity() }
                if (existingIndex >= 0) {
                    messages[existingIndex] = incoming
                    entryIds[existingIndex] = id
                } else {
                    messages += incoming
                    entryIds += id
                }
            }
        } else {
            messages = page.messages.toMutableList()
            entryIds = page.entryIds.toMutableList()
        }
        // A frame-committed row can outrun the session-file write; keep it
        // visible (with a blank id) until a page confirms it.
        for ((identity, message) in unconfirmed) {
            if (messages.none { it.identity() == identity }) {
                messages += message
                while (entryIds.size < messages.size - 1) entryIds += ""
                entryIds += ""
            }
        }
        while (entryIds.size < messages.size) entryIds += ""

        _state.update {
            it.copy(
                messages = messages,
                entryIds = entryIds,
                leafId = page.leafId ?: it.leafId,
                thinkingLevel = page.thinkingLevel ?: it.thinkingLevel,
                model = page.model ?: it.model,
                historyLoaded = true,
                historyLoading = false,
                historyStale = false,
                pagesLoading = if (page.hasMore) it.pagesLoading else false,
                historyError = null,
                pendingUser = it.pendingUser?.takeUnless { pending ->
                    messages.takeLast(4).any { row -> row is ChatMessage.User && row.text == pending.text }
                },
                liveTools = pruneCommittedTools(messages, it.liveTools),
                todoPhases = if (it.agentRunning) it.todoPhases else page.todoPhases,
            ).withSettledSubagents()
        }
        page.live?.let(::applyLiveSnapshot)
        if (awaitingResponseCheck && !page.hasMore) {
            awaitingResponseCheck = false
            if (!hasResponseSinceLastPrompt(messages) && !maybeStartedRun) {
                addNotice(NoticeKind.Error, NO_RESPONSE_MESSAGE)
            }
        }
    }

    /** Whether the transcript holds an answer (or tool work) after its last prompt. */
    private fun hasResponseSinceLastPrompt(messages: List<ChatMessage>): Boolean {
        val lastPrompt = messages.indexOfLast { it is ChatMessage.User }
        for (index in (lastPrompt + 1) until messages.size) {
            when (val message = messages[index]) {
                is ChatMessage.Assistant -> if (hasVisibleContent(message)) return true
                is ChatMessage.ToolResult -> return true
                else -> Unit
            }
        }
        return false
    }

    private fun pruneCommittedTools(
        messages: List<ChatMessage>,
        tools: List<LiveTool>,
    ): List<LiveTool> {
        val committed = messages.filterIsInstance<ChatMessage.ToolResult>().mapTo(HashSet()) { it.toolCallId }
        return tools.filterNot { it.toolCallId in committed }
    }

    private fun applyLiveSnapshot(live: LiveSnapshot) {
        // A page carries `live` only when the server had a live wrapper for
        // this session, which is exactly the answer the footer waits for. Set
        // it before the cursor fence: even a stale snapshot proves liveness.
        markLiveStateKnown()
        val cursor = live.cursor
        if (cursor != null) {
            val newer = cursor.streamId != lastLiveStreamId || cursor.sequence > lastLiveSequence
            if (!newer) return
            lastLiveStreamId = cursor.streamId
            lastLiveSequence = cursor.sequence
            toolsSnapshotSequence = maxOf(toolsSnapshotSequence, cursor.sequence)
        }
        _state.update {
            it.copy(
                streamingActive = live.isStreaming,
                streaming = if (live.isStreaming) live.streamingMessage ?: it.streaming else null,
                agentRunning = if (live.isStreaming || live.isPromptRunning || live.isCompacting) true else it.agentRunning,
                promptRunning = live.isPromptRunning,
                compacting = live.isCompacting,
                liveTools = replayToolEvents(it.liveTools, live.toolEvents),
            )
        }
        if (live.responseObserved) runHadContent = true
        if (live.isStreaming && live.streamingMessage != null && hasVisibleContent(live.streamingMessage)) {
            runHadContent = true
        }
    }

    private fun replayToolEvents(existing: List<LiveTool>, events: List<LiveToolEvent>): List<LiveTool> {
        val tools = existing.toMutableList()
        for (event in events) {
            val index = tools.indexOfFirst { it.toolCallId == event.toolCallId }
            when (event.type) {
                "tool_execution_start", "start" -> {
                    if (index < 0) {
                        tools += LiveTool(
                            toolCallId = event.toolCallId,
                            toolName = event.toolName ?: event.result?.toolName ?: "",
                            args = event.args,
                            result = null,
                            startedAt = now(),
                        )
                    }
                }
                "tool_execution_update", "update" -> {
                    val current = tools.getOrNull(index) ?: continue
                    tools[index] = current.copy(
                        result = event.result ?: current.result,
                        isError = event.isError,
                    )
                }
            }
        }
        return tools
    }

    /**
     * Apply a `GET /api/agent/{id}` snapshot (`{running, state}` or the state
     * itself).
     *
     * [expectedRunId] fences the answer against the run it was requested for:
     * a snapshot that left the device before a new prompt must never end that
     * prompt's run. [expectedQueueRevision] does the same for the queue alone,
     * because a live `queue_update` always wins over a slower `get_state`.
     * [expectedSkillDiagnosticsRevision] follows the same rule for the skill
     * report, whose live `skill_diagnostics_update` must not be overwritten by
     * a snapshot that was requested before it arrived.
     */
    fun applyAgentState(
        root: JsonObject,
        expectedRunId: Long? = null,
        expectedQueueRevision: Long? = null,
        expectedSkillDiagnosticsRevision: Long? = null,
    ) {
        if (expectedRunId != null && _state.value.runId != expectedRunId) return
        val state = root.obj("state") ?: root
        val running = root.bool("running")
        // `running` is the run in flight, `alive` the child. An older server
        // (and the bare state body) has no `alive`: there `running` still meant
        // "a child answers", so it is the fallback for ownership only.
        val alive = root.bool("alive") ?: running
        val isStreaming = state.bool("isStreaming") == true
        val isPromptRunning = state.bool("isPromptRunning") == true
        val isCompacting = state.bool("isCompacting") == true
        val busy = (running ?: true) && (isStreaming || isPromptRunning || isCompacting)
        val wasBusy = _state.value.busy || _state.value.streamingActive
        val model = state.obj("model")?.let {
            val id = it.string("id") ?: it.string("modelId") ?: ""
            ModelRef(provider = it.string("provider") ?: "", id = id, name = it.string("name"))
        }
        val usage = state.obj("contextUsage")?.let {
            ContextUsage(
                tokens = it.int("tokens") ?: 0,
                contextWindow = it.int("contextWindow") ?: 0,
                percent = it.double("percent") ?: 0.0,
            )
        }
        val queueCurrent = expectedQueueRevision == null || expectedQueueRevision == _state.value.queueRevision
        val skillCurrent = expectedSkillDiagnosticsRevision == null ||
            expectedSkillDiagnosticsRevision == _state.value.skillDiagnosticsRevision
        // A snapshot without `todoPhases` (older omp) keeps the current plan.
        val todoPhases = state["todoPhases"]?.let(::parseTodoPhases)
        // The foreign owner is top-level and always present on a server that
        // knows it; an absent field (older server) keeps whatever is known.
        val elsewhere = if (root.containsKey("elsewhere")) {
            io.github.kahme247.ompweb.net.elsewhereFrom(root["elsewhere"])
        } else {
            _state.value.foreignRun
        }
        // Only an explicit report replaces the current one; an absent field
        // means "this omp does not report it", not "no diagnostics".
        val skillDiagnostics = if (skillCurrent) parseSkillDiagnosticsSnapshot(state["skillDiagnostics"]) else null
        _state.update {
            it.copy(
                agentRunning = if (running == false) false else busy,
                promptRunning = isPromptRunning,
                streamingActive = isStreaming,
                compacting = isCompacting,
                agentPhase = when {
                    busy -> it.agentPhase ?: AgentPhase.WaitingModel
                    else -> null
                },
                model = model ?: it.model,
                thinkingLevel = state.string("thinkingLevel") ?: it.thinkingLevel,
                contextUsage = usage ?: it.contextUsage,
                tokensPerSecond = state.double("tokensPerSecond") ?: it.tokensPerSecond,
                liveTokensPerSecond = if (isStreaming) it.liveTokensPerSecond else null,
                queue = if (queueCurrent) parseQueue(state.obj("queuedMessages")) ?: it.queue else it.queue,
                todoPhases = todoPhases ?: it.todoPhases,
                // The server answered for this session: the run state is known,
                // even when it answers "nothing is running".
                liveStateKnown = true,
                skillDiagnostics = skillDiagnostics ?: it.skillDiagnostics,
                skillDiagnosticsRevision = if (skillDiagnostics != null) it.skillDiagnosticsRevision + 1 else it.skillDiagnosticsRevision,
                // A locally proven run owns the session: the server then
                // reports `elsewhere: null` itself, and a stale report must not
                // survive a run this app is driving. Ownership follows `alive`
                // (our child exists), not `running`: an idle wrapper owns it.
                foreignRun = if (alive == true || busy) null else elsewhere,
            )
        }
        if (state.bool("responseObserved") == true) runHadContent = true
        if (wasBusy && !busy && !isStreaming && !isPromptRunning && !isCompacting) {
            finishRun(surfaceError = true)
        }
    }

    /**
     * Apply the answer of `set_skill_startup_diagnostics`. [expectedRevision]
     * is the `skillDiagnosticsRevision` captured before the command was sent:
     * a live report that arrived meanwhile already reflects the new
     * preference and must win (web `skillDiagnosticsSeqRef`). Returns whether
     * the reply was applied.
     */
    fun applySkillDiagnostics(snapshot: SkillDiagnosticsSnapshot, expectedRevision: Long? = null): Boolean {
        if (expectedRevision != null && expectedRevision != _state.value.skillDiagnosticsRevision) return false
        _state.update {
            it.copy(
                skillDiagnostics = snapshot,
                skillDiagnosticsRevision = it.skillDiagnosticsRevision + 1,
            )
        }
        return true
    }

    // ------------------------------------------------------------- frame handling

    /**
     * A live-state read answered 503 `session_slow` (or upstream's
     * `session_state_timeout`): omp is alive but its event loop is blocked by a
     * large session, so the run state is unknown — not ended. The body carries
     * the server's own run state: `false` means no turn is in flight (a fresh
     * child loading a large transcript answers `get_state` too late), so the
     * client settles instead of showing "working" over an idle chat; `true` or
     * an unreported state (older server) keeps the run marked. Only the fences
     * in the caller's read decide whether it may still be applied.
     */
    fun markLiveStateSlow(running: Boolean?) {
        if (running == false) {
            markLiveStateIdle()
            return
        }
        _state.update { state ->
            if (state.liveStateKnown && state.busy) return@update state
            state.copy(liveStateKnown = true, agentRunning = true)
        }
    }

    /**
     * The server has authoritative evidence that nothing runs for this session
     * (`running: false` on a slow answer, or the running list no longer naming
     * it). Settle through the same path as an idle `GET /api/agent/{id}`
     * snapshot, so a missed `agent_end` or an endless 503 cannot leave the
     * screen in "working" for hours.
     */
    fun markLiveStateIdle() {
        if (_state.value.busy || _state.value.streamingActive) finishRun(surfaceError = true)
        _state.update { it.copy(liveStateKnown = true) }
    }

    /**
     * The live run state of this session has been observed (a frame on its
     * channel or a `GET /api/agent/{id}` snapshot). Only then may the screen
     * report "nothing is running"; before that it says *Connecting…* instead of
     * looking idle over a cached transcript.
     */
    private fun markLiveStateKnown() {
        if (_state.value.liveStateKnown) return
        _state.update { it.copy(liveStateKnown = true) }
    }

    private fun handleFrame(frame: JsonObject) {
        val type = frame.string("type") ?: return
        // Any frame proves the session's stream is live, even one the sequence
        // floors below drop as stale: the page can stop saying "Connecting…".
        markLiveStateKnown()
        if (type == "btw_record" || type == "btw_delta") {
            onBtwFrame?.invoke(frame)
            return
        }
        if (!observe(frame)) return
        when (type) {
            "connected" -> {
                effects += ChatEffect.StreamOpened
                effects += ChatEffect.RequestContext(reset = false)
            }
            "agent_start" -> handleAgentStart()
            "agent_end" -> handleAgentEnd(frame)
            "message_start" -> handleMessageStart(frame)
            "message_update" -> handleMessageUpdate(frame)
            "message_end" -> handleMessageEnd(frame)
            "tool_execution_start" -> handleToolStart(frame)
            "tool_execution_update" -> handleToolUpdate(frame)
            "tool_execution_end" -> handleToolEnd(frame)
            "prompt_result" -> handlePromptResult(frame)
            "prompt_error" -> {
                val message = readAgentError(frame["errorMessage"]) ?: readAgentError(frame["error"])
                    ?: readAgentError(frame["message"]) ?: "Command failed"
                lastRunError = message
                if (_state.value.busy) finishRun(surfaceError = true) else addNotice(NoticeKind.Error, message)
            }
            "error", "agent_error", "turn_error", "model_error", "server_error",
            "internal_error", "rpc_frame_error" -> {
                val message = readTerminalError(frame) ?: "The request failed"
                lastRunError = message
                if (!_state.value.agentRunning) addNotice(NoticeKind.Error, message)
            }
            "notice" -> handleNotice(frame)
            "command_output" -> {
                val text = frame.string("text")?.trim().orEmpty()
                if (text.isNotEmpty()) addNotice(NoticeKind.Info, text)
            }
            "thinking_level_changed" -> {
                val level = frame.string("thinkingLevel")
                _state.update { it.copy(thinkingLevel = level ?: it.thinkingLevel) }
            }
            "model_changed" -> effects += ChatEffect.RequestAgentState
            "config_update" -> {
                val model = frame.obj("model")?.let {
                    ModelRef(
                        provider = it.string("provider") ?: "",
                        id = it.string("id") ?: it.string("modelId") ?: "",
                        name = it.string("name"),
                    )
                }
                _state.update {
                    it.copy(
                        model = model ?: it.model,
                        thinkingLevel = frame.string("thinkingLevel") ?: it.thinkingLevel,
                    )
                }
            }
            "available_commands_update" -> {
                val commands = io.github.kahme247.ompweb.domain.parseSlashCommands(frame["commands"])
                if (commands.isNotEmpty()) _state.update { it.copy(remoteCommands = commands) }
            }
            "queue_update" -> {
                // A full snapshot only; a partial payload must not clear the
                // queue (web `readQueueSnapshot`).
                val queue = parseQueue(frame.obj("queuedMessages") ?: frame)
                if (queue != null) {
                    _state.update { it.copy(queue = queue, queueRevision = it.queueRevision + 1) }
                }
            }
            "skill_diagnostics_update" -> {
                // The report rides under `data`; a payload the server's parser
                // rejected arrives as null and clears the banner (web
                // `parseSkillDiagnosticsSnapshot(...) ?? null`).
                _state.update {
                    it.copy(
                        skillDiagnostics = parseSkillDiagnosticsSnapshot(frame["data"]),
                        skillDiagnosticsRevision = it.skillDiagnosticsRevision + 1,
                    )
                }
            }
            "auto_retry_start" -> {
                _state.update {
                    it.copy(
                        autoRetry = AutoRetry(
                            attempt = frame.int("attempt"),
                            maxAttempts = frame.int("maxAttempts"),
                            message = frame.string("errorMessage"),
                        ),
                    )
                }
            }
            "auto_retry_end" -> _state.update { it.copy(autoRetry = null) }
            "auto_compaction_start" -> _state.update { it.copy(compacting = true) }
            "auto_compaction_end" -> {
                _state.update { it.copy(compacting = false) }
                val error = frame.string("errorMessage")?.takeIf { it.isNotBlank() }
                if (error != null) {
                    effects += ChatEffect.ShowCompactError(error)
                } else if (frame.bool("aborted") != true && frame.bool("skipped") != true) {
                    readCompactResult(frame["result"], "auto")?.let { effects += ChatEffect.ShowCompactResult(it) }
                    effects += ChatEffect.RequestContext(reset = false)
                }
            }
            "todo_reminder", "todo_auto_clear" -> effects += ChatEffect.RequestAgentState
            "subagent_lifecycle" -> handleSubagentLifecycle(frame)
            "subagent_progress" -> handleSubagentProgress(frame)
            "subagent_event" -> handleSubagentEvent(frame)
            // The view model answers these on the host-tools/extension paths;
            // they must never reach transcript handling.
            "host_tool_call", "host_uri_request", "extension_ui_request",
            "extension_ui_cancel", "extension_status_update", "extension_widget_update",
            -> Unit
            "session_settled" -> Unit
            // omp forked this conversation because another process held the
            // file (a forced send raced the owner). The copy carries the user's
            // text, so it must be visible instead of looking like a new chat;
            // the screens offer opening the original from here.
            "session_contention_fork" -> {
                val fromId = frame.string("fromId")
                if (fromId != null) {
                    effects += ChatEffect.ContentionFork(fromId, frame.string("toId"))
                    // The copy is this app's session now; the original stays
                    // with the other process.
                    setForeignRun(null)
                }
            }
        }
    }

    /**
     * Per-category sequence floors (web: `hooks/useAgentSession-sync.ts`).
     * Frames older than the newest frame of their category (or of a stronger
     * category) are dropped, so a reconnect replay cannot resurrect stale
     * transcript state.
     */
    private fun observe(frame: JsonObject): Boolean {
        val web = frame.obj("web")
        if (web != null) {
            val incomingStream = web.string("streamId")
            val sequence = web.long("sequence") ?: 0L
            if (incomingStream != null && streamId != null && incomingStream != streamId) {
                streamId = incomingStream
                resetForEpoch()
                return true
            }
            if (incomingStream != null) streamId = incomingStream
            val type = frame.string("type")
            val floor = when {
                type == null -> 0L
                type in LIFECYCLE_FRAMES -> maxOf(lifecycleSequence, messageSequence, newestToolSequence())
                type.startsWith("message_") && !isUserMessageFrame(frame) -> maxOf(lifecycleSequence, messageSequence)
                type.startsWith("tool_execution_") -> {
                    val id = frame.string("toolCallId")
                    maxOf(lifecycleSequence, toolsSnapshotSequence, id?.let { toolSequences[it] ?: 0L } ?: 0L)
                }
                else -> 0L
            }
            if (sequence < floor) return false
            when {
                type in LIFECYCLE_FRAMES -> lifecycleSequence = sequence
                type != null && type.startsWith("message_") && !isUserMessageFrame(frame) -> messageSequence = sequence
                type != null && type.startsWith("tool_execution_") ->
                    frame.string("toolCallId")?.let { toolSequences[it] = sequence }
            }
        }
        return true
    }

    private fun newestToolSequence(): Long = toolSequences.values.maxOrNull() ?: 0L

    private fun isUserMessageFrame(frame: JsonObject): Boolean =
        frame.obj("message")?.string("role") == "user" ||
            frame.obj("assistantMessageEvent")?.obj("partial")?.string("role") == "user"

    /**
     * Re-evaluate the published live rate without a frame. The composer ticker
     * calls this every [STREAM_RATE_PUBLISH_MS] while a reply streams: a stall
     * then hides the number after [STREAM_STALE_MS] instead of freezing the
     * last value on screen (web `useStreamRate`'s interval).
     */
    fun refreshLiveRate(at: Long = now()) {
        val state = _state.value
        if (!state.streamingActive) return
        if (at - lastRatePublishAt < STREAM_RATE_PUBLISH_MS) return
        lastRatePublishAt = at
        val measured = roundedRate(streamRate.rate(at))
        if (measured == lastPublishedRate) return
        lastPublishedRate = measured
        _state.update { current ->
            if (!current.streamingActive) current
            else current.copy(liveTokensPerSecond = measured)
        }
    }

    /**
     * Forget the live rate: the tracker, its publish clock and the last value
     * shown. Callers clear `liveTokensPerSecond` in the same state update.
     */
    private fun resetStreamRate() {
        streamRate.reset()
        lastRatePublishAt = 0L
        lastPublishedRate = null
    }

    /** Rounded to the 0.1 the UI shows, so an unchanged value never rerenders. */
    private fun roundedRate(rate: Double?): Double? =
        rate?.let { (it * 10.0).roundToLong() / 10.0 }

    private fun resetForEpoch() {
        coalescer.reset()
        resetStreamRate()
        _state.update {
            it.copy(
                messages = emptyList(),
                entryIds = emptyList(),
                streaming = null,
                streamingActive = false,
                liveTokensPerSecond = null,
                agentRunning = false,
                promptRunning = false,
                compacting = false,
                liveTools = emptyList(),
                autoRetry = null,
                agentPhase = null,
                error = null,
                runStartedAt = null,
                historyLoading = true,
                historyLoaded = false,
                leafId = it.leafId,
            )
        }
        unconfirmed.clear()
        runHadContent = false
        lastRunError = null
        messageSequence = 0
        lifecycleSequence = 0
        toolsSnapshotSequence = 0
        toolSequences.clear()
        lastLiveSequence = -1
        lastLiveStreamId = null
        effects += ChatEffect.RequestContext(reset = true)
    }

    private fun handleAgentStart() {
        coalescer.reset()
        resetStreamRate()
        _state.update {
            it.copy(
                agentRunning = true,
                promptRunning = true,
                streamingActive = false,
                liveTokensPerSecond = null,
                liveTools = emptyList(),
                autoRetry = null,
                error = null,
                agentPhase = AgentPhase.WaitingModel,
            )
        }
        runHadContent = false
        lastRunError = null
        // A frame is positive evidence: the maybe-started prompt really did run.
        maybeStartedRun = false
        effects += ChatEffect.RequestContext(reset = false)
    }

    private fun handleAgentEnd(frame: JsonObject) {
        if (frame.bool("isTerminal") == false) return
        if (!_state.value.agentRunning && !_state.value.busy) return
        effects += ChatEffect.PlayCompletionTone
        val terminalError = readTerminalError(frame) ?: lastRunError
        if (terminalError != null) {
            addNotice(NoticeKind.Error, terminalError)
        } else if (!runHadContent) {
            // Do not judge here: the reload below decides whether the model
            // really answered (the run's frames may have been lost to a
            // reconnect, web `finishPromptWithoutStream`).
            awaitingResponseCheck = true
        }
        finishRun(surfaceError = false)
    }

    private fun finishRun(surfaceError: Boolean) {
        resetStreamRate()
        val error = lastRunError
        val hadContent = runHadContent
        _state.update {
            it.copy(
                agentRunning = false,
                promptRunning = false,
                streamingActive = false,
                streaming = null,
                liveTokensPerSecond = null,
                compacting = false,
                liveTools = emptyList(),
                autoRetry = null,
                agentPhase = null,
                runStartedAt = null,
                runsEnded = it.runsEnded + 1,
                error = if (surfaceError) error ?: it.error else it.error,
                // A finished run's live roster is stale: omp drops terminal
                // subagents from its registry, and the on-disk history
                // repopulates finished chips (web `setSubagents([])`).
                subagents = emptyList(),
                subagentActivity = emptyMap(),
                subagentVersions = emptyMap(),
            )
        }
        subagentGeneration += 1
        if (surfaceError && error != null && _state.value.notices.none { it.message == error }) {
            addNotice(NoticeKind.Error, error)
        }
        coalescer.reset()
        runHadContent = false
        lastRunError = null
        // `maybeStartedRun` deliberately survives until the reload above
        // settles `awaitingResponseCheck`; a new send/frame/session clears it.
        effects += ChatEffect.RequestContext(reset = false)
        effects += ChatEffect.RefreshSubagents
        if (hadContent && error == null) effects += ChatEffect.SpeakLastReply
    }

    /** Lifecycle frames carry the roster entry under `payload`. */
    private fun subagentPayload(frame: JsonObject): JsonObject = frame.obj("payload") ?: frame

    private fun handleSubagentLifecycle(frame: JsonObject) {
        val info = parseSubagentLifecycle(subagentPayload(frame), now()) ?: return
        mergeSubagents(listOf(info))
    }

    /**
     * Progress frames carry the full `AgentProgress` snapshot (throttled to one
     * per ~150 ms). The reliable key is `progress.id`; `parentToolCallId` and
     * `index` are fallbacks, and a known id that vanished means the frame is
     * stale — falling back there could overwrite a different child.
     */
    private fun handleSubagentProgress(frame: JsonObject) {
        val payload = frame.obj("payload") ?: return
        val progress = parseSubagentProgress(payload["progress"])
        val progressId = progress?.id
        val index = payload.int("index") ?: progress?.index ?: -1
        val parentToolCallId = payload.string("parentToolCallId")
        val task = payload.string("task")?.takeIf { it.isNotBlank() } ?: progress?.task
        val assignment = payload.string("assignment") ?: progress?.assignment
        if (progressId == null && task == null && parentToolCallId == null && index < 0) return
        val timestamp = now()
        _state.update { state ->
            if (state.subagents.isEmpty()) return@update state
            val target = when {
                progressId != null -> state.subagents.indexOfFirst { it.id == progressId }
                parentToolCallId != null && index >= 0 -> state.subagents.indexOfFirst {
                    it.parentToolCallId == parentToolCallId && it.index == index
                }
                parentToolCallId != null -> state.subagents.indexOfFirst { it.parentToolCallId == parentToolCallId }
                index >= 0 -> state.subagents.indexOfFirst { it.index == index }
                else -> -1
            }
            if (target < 0) return@update state
            val current = state.subagents[target]
            val next = current.copy(
                agent = payload.string("agent") ?: current.agent,
                // The snapshot's agent-source literal lives in payload.agentSource,
                // not payload.agent (which holds the agent name).
                agentSource = SubagentAgentSource.fromWire(payload.string("agentSource")) ?: current.agentSource,
                sessionFile = payload.string("sessionFile") ?: current.sessionFile,
                detached = payload.bool("detached") ?: current.detached,
                task = task ?: current.task,
                assignment = assignment ?: current.assignment,
                progress = progress ?: current.progress,
                lastUpdate = timestamp,
                source = SubagentSource.LIVE,
            )
            // Progress arrives every ~150 ms; skip the rerender when no
            // displayed field changed.
            if (next.copy(lastUpdate = current.lastUpdate) == current) return@update state
            state.copy(subagents = state.subagents.toMutableList().also { it[target] = next })
        }
    }

    /**
     * A child's own session event: bump the per-child revision the transcript
     * dialog debounces on and keep a bounded live-activity buffer.
     */
    private fun handleSubagentEvent(frame: JsonObject) {
        val payload = frame.obj("payload") ?: return
        val id = payload.string("id")?.takeIf { it.isNotEmpty() } ?: return
        val activity = parseSubagentActivityEvent(payload, now())
        _state.update { state ->
            val versions = state.subagentVersions.toMutableMap()
            versions[id] = (versions[id] ?: 0L) + 1
            val activityMap = if (activity == null) {
                state.subagentActivity
            } else {
                val merged = (state.subagentActivity[id].orEmpty() + activity).takeLast(SUBAGENT_ACTIVITY_BUFFER_MAX)
                state.subagentActivity + (id to merged)
            }
            state.copy(
                subagentVersions = pruneSubagentIds(versions),
                subagentActivity = pruneSubagentIds(activityMap),
            )
        }
    }

    private fun handleMessageStart(frame: JsonObject) {
        val message = frame.obj("message") ?: return
        when (message.string("role")) {
            "user" -> Unit
            "assistant" -> {
                if (!_state.value.agentRunning) return
                val parsed = parseChatMessage(message, null, "streaming") as? ChatMessage.Assistant ?: return
                resetStreamRate()
                _state.update {
                    it.copy(streaming = parsed, streamingActive = true, liveTokensPerSecond = null)
                }
                if (hasVisibleContent(parsed)) runHadContent = true
            }
        }
    }

    private fun handleMessageUpdate(frame: JsonObject) {
        if (!_state.value.agentRunning) return
        val message = frame.obj("message")
            ?: frame.obj("assistantMessageEvent")?.obj("partial")
            ?: return
        if (message.string("role") != "assistant") return
        val parsed = parseChatMessage(message, null, "streaming") as? ChatMessage.Assistant ?: return
        val preview = parsed.copy(streaming = true)
        val at = now()
        streamRate.observe(estimateStreamTokens(parsed.blocks), at)
        // Publish at most twice a second, and only when the displayed 0.1
        // actually changed; the estimate runs per frame either way.
        var publishRate = false
        if (at - lastRatePublishAt >= STREAM_RATE_PUBLISH_MS) {
            lastRatePublishAt = at
            val measured = roundedRate(streamRate.rate(at))
            if (measured != lastPublishedRate) {
                lastPublishedRate = measured
                publishRate = true
            }
        }
        _state.update {
            it.copy(
                streaming = preview,
                streamingActive = true,
                liveTokensPerSecond = if (publishRate) lastPublishedRate else it.liveTokensPerSecond,
            )
        }
        if (hasVisibleContent(parsed)) runHadContent = true
    }

    private fun handleMessageEnd(frame: JsonObject) {
        val message = frame.obj("message") ?: return
        val parsed = parseChatMessage(message, null, "committed:${message.string("role")}:${now()}") ?: return
        val identity = parsed.identity()
        val alreadyCommitted = _state.value.messages.any { it.identity() == identity }
        if (parsed is ChatMessage.Assistant) {
            resetStreamRate()
            if (parsed.stopReason == "error" || !parsed.errorMessage.isNullOrBlank()) {
                lastRunError = parsed.errorMessage?.trim()?.ifEmpty { null } ?: lastRunError
            }
            if (hasVisibleContent(parsed)) runHadContent = true
        }
        _state.update {
            it.copy(
                streaming = if (parsed is ChatMessage.Assistant) null else it.streaming,
                streamingActive = if (parsed is ChatMessage.Assistant) false else it.streamingActive,
                liveTokensPerSecond = if (parsed is ChatMessage.Assistant) null else it.liveTokensPerSecond,
                messages = if (alreadyCommitted) it.messages else it.messages + parsed,
                pendingUser = if (parsed is ChatMessage.User && it.pendingUser?.text == parsed.text) null else it.pendingUser,
                liveTools = if (parsed is ChatMessage.ToolResult) {
                    it.liveTools.filterNot { tool -> tool.toolCallId == parsed.toolCallId }
                } else it.liveTools,
            ).withSettledSubagents()
        }
        if (!alreadyCommitted) unconfirmed[identity] = parsed
        if (parsed is ChatMessage.Assistant) effects += ChatEffect.RequestContext(reset = false)
    }

    private fun handleToolStart(frame: JsonObject) {
        val id = frame.string("toolCallId") ?: return
        val name = frame.string("toolName") ?: ""
        val startedAt = frame.long("timestamp") ?: now()
        _state.update { state ->
            val existing = state.liveTools.firstOrNull { it.toolCallId == id }
            val tool = LiveTool(
                toolCallId = id,
                toolName = name.ifEmpty { existing?.toolName.orEmpty() },
                args = frame.obj("args") ?: existing?.args,
                result = null,
                startedAt = existing?.startedAt ?: startedAt,
            )
            val liveTools = if (existing == null) state.liveTools + tool
            else state.liveTools.map { if (it.toolCallId == id) tool else it }
            state.copy(
                liveTools = liveTools,
                agentPhase = withRunningTool(state.agentPhase, RunningTool(id, tool.toolName)),
            )
        }
    }

    private fun handleToolUpdate(frame: JsonObject) {
        val id = frame.string("toolCallId") ?: return
        val partial = frame.obj("partialResult")
        val result = partial?.let {
            parseToolResultPayload(it, "live:$id")?.copy(partial = true)
        }
        _state.update { state ->
            val tool = state.liveTools.firstOrNull { it.toolCallId == id }
                ?: LiveTool(
                    toolCallId = id,
                    toolName = frame.string("toolName") ?: "",
                    args = frame.obj("args"),
                    result = null,
                    startedAt = now(),
                )
            val updated = tool.copy(
                toolName = frame.string("toolName") ?: tool.toolName,
                args = frame.obj("args") ?: tool.args,
                result = result ?: tool.result,
                isError = frame.bool("isError") == true,
            )
            if (state.liveTools.any { it.toolCallId == id }) {
                state.copy(liveTools = state.liveTools.map { if (it.toolCallId == id) updated else it })
            } else {
                state.copy(liveTools = state.liveTools + updated)
            }
        }
    }

    private fun handleToolEnd(frame: JsonObject) {
        val id = frame.string("toolCallId") ?: return
        val result = frame.obj("result")?.let { parseToolResultPayload(it, "live:$id") }
        val isError = frame.bool("isError") == true || result?.isError == true
        val endedAt = now()
        _state.update { state ->
            val tool = state.liveTools.firstOrNull { it.toolCallId == id }
            if (tool == null) state
            else state.copy(
                liveTools = state.liveTools.map {
                    if (it.toolCallId != id) it
                    else it.copy(
                        toolName = frame.string("toolName") ?: it.toolName,
                        result = result ?: it.result,
                        isError = isError,
                        endedAt = endedAt,
                    )
                },
                agentPhase = withoutRunningTool(state.agentPhase, id),
            )
        }
    }

    private fun handlePromptResult(frame: JsonObject) {
        if (frame.bool("agentInvoked") != false) return
        if (!_state.value.agentRunning && !_state.value.busy) {
            effects += ChatEffect.RequestAgentState
            return
        }
        finishRun(surfaceError = false)
    }

    private fun handleNotice(frame: JsonObject) {
        val level = frame.string("level")
        val message = readAgentError(frame["message"])
            ?: readAgentError(frame["errorMessage"])
            ?: readAgentError(frame["error"])
            ?: return
        if (message.isBlank()) return
        val kind = when (level) {
            "error" -> NoticeKind.Error
            "warning" -> NoticeKind.Warning
            else -> NoticeKind.Info
        }
        addNotice(kind, message)
    }

    /** An in-app notice from a surface outside the frame pump (extension UI, host access). */
    fun notice(kind: NoticeKind, message: String) = addNotice(kind, message)

    /**
     * Drop a notice the bar dismissed (user or timer). Without this the dedupe
     * in [addNotice] would swallow the same message forever in one session —
     * a repeated host-access notice must be able to show again.
     */
    fun dismissNotice(notice: ChatNotice) {
        _state.update { state ->
            if (notice in state.notices) state.copy(notices = state.notices - notice) else state
        }
    }

    // ------------------------------------------------------------------- helpers

    private fun addNotice(kind: NoticeKind, message: String) {
        if (message.isBlank()) return
        _state.update { state ->
            if (state.notices.any { it.kind == kind && it.message == message }) state
            else state.copy(notices = (state.notices + ChatNotice(kind, message, now())).takeLast(MAX_NOTICES))
        }
    }

    private fun hasVisibleContent(message: ChatMessage.Assistant): Boolean =
        message.blocks.any { block ->
            (block is AssistantBlock.Text && block.text.isNotBlank()) || block is AssistantBlock.Image
        }

    /** Register a running tool; a repeated start for the same id replaces it. */
    private fun withRunningTool(phase: AgentPhase?, tool: RunningTool): AgentPhase {
        val tools = (phase as? AgentPhase.RunningTools)?.tools.orEmpty()
        return AgentPhase.RunningTools(tools.filterNot { it.id == tool.id } + tool)
    }

    /** Tool ends return to the model unless a sibling tool still runs. */
    private fun withoutRunningTool(phase: AgentPhase?, id: String): AgentPhase? {
        val tools = (phase as? AgentPhase.RunningTools)?.tools ?: return phase
        val rest = tools.filterNot { it.id == id }
        return if (rest.isEmpty()) AgentPhase.WaitingModel else AgentPhase.RunningTools(rest)
    }
}

private val LIFECYCLE_FRAMES = setOf(
    "agent_start",
    "agent_end",
    "prompt_result",
    "prompt_error",
    "auto_compaction_start",
    "auto_compaction_end",
)

private const val MAX_NOTICES = 5

private const val NO_RESPONSE_MESSAGE = "The model returned no response"

/** Cross-source identity of a message (same role + timestamp = same message). */
internal fun ChatMessage.identity(): String = when (this) {
    is ChatMessage.User -> "user:${timestamp ?: key}"
    is ChatMessage.Assistant -> "assistant:${timestamp ?: key}"
    is ChatMessage.ToolResult -> "toolResult:${toolCallId.ifEmpty { timestamp?.toString() ?: key }}"
    is ChatMessage.BashExecution -> "bash:${timestamp ?: key}"
    is ChatMessage.Custom -> "custom:${customType}:${timestamp ?: key}"
    is ChatMessage.Other -> "other:$role:${timestamp ?: key}"
}

/** Read an error out of omp's several payload shapes. */
internal fun readAgentError(value: JsonElement?): String? {
    when (value) {
        is JsonPrimitive -> {
            if (!value.isString) return null
            return value.content.trim().ifEmpty { null }
        }
        is JsonObject -> {
            for (key in listOf("errorMessage", "error", "message", "detail")) {
                readAgentError(value[key])?.let { return it }
            }
            if (value.string("stopReason") == "error") return "The request failed"
            return null
        }
        else -> return null
    }
}

internal fun readTerminalError(frame: JsonObject): String? {
    for (key in listOf("errorMessage", "error", "message")) {
        readAgentError(frame[key])?.let { return it }
    }
    val messages = frame["messages"] as? JsonArray ?: return null
    for (index in messages.indices.reversed()) {
        readAgentError(messages[index])?.let { return it }
    }
    return null
}

internal fun parseQueue(value: JsonObject?): QueueSnapshot? {
    if (value == null) return null
    // Both keys are part of the snapshot contract; a partial payload is not
    // queue state (web `readQueueSnapshot`).
    if (!value.containsKey("steering") || !value.containsKey("followUp")) return null
    fun texts(key: String): List<String> = when (val element = value[key]) {
        is JsonArray -> element.mapNotNull { item ->
            when (item) {
                is JsonPrimitive -> item.content
                is JsonObject -> item.string("text") ?: item.string("message")
                else -> null
            }
        }.filter { it.isNotBlank() }
        is JsonPrimitive -> element.content.takeIf { it.isNotBlank() }?.let(::listOf) ?: emptyList()
        else -> emptyList()
    }
    return QueueSnapshot(
        steering = texts("steering"),
        followUp = texts("followUp"),
    )
}
