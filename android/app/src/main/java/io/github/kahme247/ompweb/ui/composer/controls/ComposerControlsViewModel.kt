package io.github.kahme247.ompweb.ui.composer.controls

import io.github.kahme247.ompweb.data.ChatSettings
import io.github.kahme247.ompweb.domain.ModelCapacity
import io.github.kahme247.ompweb.domain.ModelKey
import io.github.kahme247.ompweb.domain.ModelOption
import io.github.kahme247.ompweb.domain.ThinkingModelMeta
import io.github.kahme247.ompweb.domain.ToolPreset
import io.github.kahme247.ompweb.domain.buildModelOptions
import io.github.kahme247.ompweb.domain.normalizeThinkingLevel
import io.github.kahme247.ompweb.domain.readCompactResult
import io.github.kahme247.ompweb.domain.resolveAvailableThinkingLevels
import io.github.kahme247.ompweb.net.AgentConfigSnapshot
import io.github.kahme247.ompweb.net.ApiError
import io.github.kahme247.ompweb.net.ComposerControlsApi
import io.github.kahme247.ompweb.net.ModelsResponse
import io.github.kahme247.ompweb.net.parseAgentConfig
import io.github.kahme247.ompweb.net.parseSessionStats
import io.github.kahme247.ompweb.net.parseThinkingModel
import io.github.kahme247.ompweb.net.userMessage
import kotlin.math.round
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

/**
 * The composer's model/thinking/fast/slow/advisor/usage/context controls.
 *
 * Port of `hooks/useAgentSession.ts` (model, thinking, fast/slow, advisor,
 * compact, session stats — the parts `ChatInput` renders) plus the composer
 * slices of `components/ChatInput.tsx` and `components/ComposerPanels.tsx`
 * (`ContextDetailPanel`).
 *
 * Resolution order mirrors the web: the user's explicit pick wins until omp
 * reports a different resolved model, then the live `get_state.model` (omp may
 * fall back to the default model when the recorded one disappeared), then the
 * session file's entry, then the catalog default for a new chat. Live answers
 * stay `null`-able on purpose: without an omp process the catalog backs the
 * Fast/Slow toggles and the reasoning ladder.
 */
class ComposerControlsViewModel(
    private val api: ComposerControlsApi,
    private val settings: ChatSettings,
    private val scope: CoroutineScope,
) {

    private val _state = MutableStateFlow(ComposerControlsState())
    val state: StateFlow<ComposerControlsState> = _state.asStateFlow()

    private var catalog: ModelsResponse = ModelsResponse()
    private var catalogLoaded = false

    /** Monotonic token for authoritative live-state syncs (web `authoritativeModelSeqRef`). */
    private var syncSeq = 0

    // Live answers from omp. null = "no live answer": the catalog backs the control.
    private var liveModel: ThinkingModelMeta? = null
    private var liveSlowSupported: Boolean? = null
    private var liveSlowEnabled: Boolean? = null
    private var liveSlowScope: String? = null

    /** The user's explicit pick that no live snapshot has superseded yet. */
    private var pickedModel: ModelKey? = null

    /** The model recorded in the session file (web `data.context.model`). */
    private var sessionModel: ModelKey? = null
    private var sessionModelName: String? = null

    /** Choices of a brand-new chat that has no omp process to command yet. */
    private var preSpawnFast: Boolean? = null
    private var preSpawnSlow: Boolean? = null

    private var catalogJob: Job? = null
    private var liveJob: Job? = null
    private var statsJob: Job? = null
    private var catalogFence = 0

    private val speedSamples = ArrayDeque<Double>()
    private var lastReportedSpeed: Double? = null

    /** True once omp answered the ladder itself; the session file stops mattering. */
    private var liveThinkingReceived = false

    /**
     * Follows the composer's scope. `sessionId == null` is the unsent new chat:
     * picks stay pending and are handed to `POST /api/agent/new` through
     * [pendingSpawnOptions]. Never spawns an omp process.
     */
    fun bind(sessionId: String?, cwd: String) {
        val current = _state.value
        val sameScope = current.sessionId == sessionId && current.cwd == cwd
        if (sameScope) {
            if (!catalogLoaded && catalogJob?.isActive != true) loadCatalog(cwd)
            return
        }
        // Only a brand-new chat this instance prepared still holds unsaved
        // pre-spawn picks. A cold-started bind of an existing session has none
        // (`current` is empty), so it must read the store instead of carrying
        // the defaults over — that made every cold-started session look
        // spawned and forgot its advisor flag (B18).
        val spawned = current.sessionId == null && sessionId != null && (
            current.advisorEnabled || preSpawnFast != null || preSpawnSlow != null
            )
        statsJob?.cancel()
        resetLive()
        speedSamples.clear()
        lastReportedSpeed = null
        if (!spawned) {
            pickedModel = null
            sessionModel = null
            sessionModelName = null
            preSpawnFast = null
            preSpawnSlow = null
            liveThinkingReceived = false
        }
        _state.value = ComposerControlsState(
            sessionId = sessionId,
            cwd = cwd,
            models = current.models,
            modelsLoading = current.modelsLoading,
            modelsError = current.modelsError,
            model = if (spawned) current.model else null,
            modelName = if (spawned) current.modelName else null,
            thinkingLevel = if (spawned) current.thinkingLevel else "auto",
            advisorEnabled = when {
                sessionId == null -> current.advisorEnabled
                // A pre-spawn toggle is not persisted yet; the choice this
                // instance carries is the truth for the new id.
                spawned -> current.advisorEnabled
                else -> settings.snapshot.value.advisorSessions.contains(sessionId)
            },
            toolPreset = ToolPreset.fromWire(settings.snapshot.value.toolPreset),
        )
        refreshDerived()
        loadCatalog(cwd)
        if (sessionId != null) {
            refreshLiveState(sessionId)
            if (spawned) {
                // Persist the carried choice for this id, so the chat's own
                // controls instance and a later cold start see it too.
                settings.markSessionCreated(sessionId, current.advisorEnabled)
                applyPreSpawnChoices(sessionId)
            }
        }
    }

    /**
     * The session the new-chat pane just created exists under [sessionId].
     * Hands the pane's unsaved picks over to the shared store before the chat
     * binds the id (the chat composer is a *different*
     * [ComposerControlsViewModel] instance) and applies the Fast/Slow toggles
     * `POST /api/agent/new` cannot carry.
     */
    fun onSessionCreated(sessionId: String) {
        if (sessionId.isBlank() || _state.value.sessionId != null) return
        settings.markSessionCreated(sessionId, _state.value.advisorEnabled)
        applyPreSpawnChoices(sessionId)
    }

    /**
     * The session file's `thinkingLevel`, shown until omp reports the live one
     * (an idle session has no process to ask). Ignored once a live answer arrived.
     */
    fun onSessionThinking(level: String?) {
        if (liveThinkingReceived) return
        val normalized = normalizeThinkingLevel(level)
        _state.update { it.copy(thinkingLevel = normalized) }
    }

    /** The session file's model entry, for the trigger before any omp process runs. */
    fun onSessionModel(provider: String, modelId: String, name: String? = null) {
        if (provider.isBlank() || modelId.isBlank()) return
        sessionModel = ModelKey(provider, modelId)
        sessionModelName = name?.takeIf { it.isNotBlank() }
        refreshDerived()
    }

    /**
     * One `get_state` snapshot: `GET /api/agent/{id}` (`{running, alive, state}`,
     * also with `state` missing) or a bare state object. Call it for every
     * snapshot the chat receives.
     */
    fun onAgentState(payload: JsonObject) {
        val stateObject = payload["state"] as? JsonObject
        val token = beginSync()
        if (stateObject == null) {
            // No omp process: the catalog backs Slow again, as on the web.
            liveSlowSupported = null
            refreshDerived()
            return
        }
        applyConfig(parseAgentConfig(payload), childAlive(payload, stateObject), token)
    }

    /**
     * One session SSE frame. Only the config-shaped frames matter here; every
     * other frame is the chat's business.
     */
    fun onFrame(frame: JsonObject) {
        when (frame.string("type")) {
            "thinking_level_changed" -> {
                syncSeq += 1
                liveThinkingReceived = true
                val level = normalizeThinkingLevel(frame.string("thinkingLevel"))
                _state.update { it.copy(thinkingLevel = level) }
            }

            "model_changed" -> {
                val sessionId = _state.value.sessionId
                if (sessionId != null) refreshLiveState(sessionId)
            }

            "config_update" -> {
                val model = parseThinkingModel(frame["model"])
                if (model != null) {
                    syncSeq += 1
                    applyAuthoritativeModel(model)
                } else if (frame.containsKey("thinkingLevel")) {
                    syncSeq += 1
                }
                frame.string("thinkingLevel")?.let { level ->
                    liveThinkingReceived = true
                    _state.update { it.copy(thinkingLevel = normalizeThinkingLevel(level)) }
                }
                refreshDerived()
            }

            "auto_compaction_start" -> {
                _state.update {
                    it.copy(isCompacting = true, compactError = null, compactResult = null)
                }
            }

            "auto_compaction_end" -> {
                val error = frame.string("errorMessage")?.takeIf { it.isNotBlank() }
                val finished = frame.boolean("aborted") != true && frame.boolean("skipped") != true
                _state.update {
                    when {
                        error != null -> it.copy(
                            isCompacting = false,
                            compactError = error,
                            compactResult = null,
                        )

                        finished -> it.copy(
                            isCompacting = false,
                            compactResult = readCompactResult(frame["result"], "auto"),
                        )

                        else -> it.copy(isCompacting = false)
                    }
                }
                if (finished) refreshSessionStats()
            }
        }
    }

    // --- Model -------------------------------------------------------------

    fun onSelectModel(provider: String, modelId: String) {
        if (provider.isBlank() || modelId.isBlank()) return
        val key = ModelKey(provider, modelId)
        pickedModel = key
        _state.update { it.copy(model = key, modelName = null, error = null) }
        refreshDerived()
        val sessionId = _state.value.sessionId ?: return
        scope.launch {
            try {
                send(
                    sessionId,
                    buildJsonObject {
                        put("type", "set_model")
                        put("provider", provider)
                        put("modelId", modelId)
                    },
                )
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            } finally {
                // A command against an idle-disposed session restarts omp, which
                // re-resolves the model: the composer must show what actually runs.
                if (_state.value.sessionId == sessionId) refreshLiveState(sessionId)
            }
        }
    }

    // --- Thinking ----------------------------------------------------------

    fun onThinkingLevelChange(level: String) {
        val normalized = normalizeThinkingLevel(level)
        _state.update { it.copy(thinkingLevel = normalized, error = null) }
        // "auto" leaves omp's own setting untouched, exactly like the web.
        if (normalized == "auto") return
        val sessionId = _state.value.sessionId ?: return
        scope.launch {
            try {
                send(
                    sessionId,
                    buildJsonObject {
                        put("type", "set_thinking_level")
                        put("level", normalized)
                    },
                )
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            } finally {
                if (_state.value.sessionId == sessionId) refreshLiveState(sessionId)
            }
        }
    }

    /**
     * Ctrl/Cmd+Alt+M: `cycle_model` passthrough (web `rpc-manager`
     * `PASSTHROUGH_COMMANDS`); omp picks the next model and the live refresh
     * shows what it chose.
     */
    fun cycleModel() {
        val sessionId = _state.value.sessionId ?: return
        scope.launch {
            try {
                send(sessionId, buildJsonObject { put("type", "cycle_model") })
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            } finally {
                if (_state.value.sessionId == sessionId) refreshLiveState(sessionId)
            }
        }
    }

    /** Ctrl/Cmd+Alt+T: `cycle_thinking_level` passthrough. */
    fun cycleThinkingLevel() {
        val sessionId = _state.value.sessionId ?: return
        scope.launch {
            try {
                send(sessionId, buildJsonObject { put("type", "cycle_thinking_level") })
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            } finally {
                if (_state.value.sessionId == sessionId) refreshLiveState(sessionId)
            }
        }
    }

    // --- Fast / Slow -------------------------------------------------------

    fun onFastModeChange(enabled: Boolean) {
        _state.update { it.copy(fastModeEnabled = enabled, error = null) }
        val sessionId = _state.value.sessionId
        if (sessionId == null) {
            preSpawnFast = enabled
            return
        }
        scope.launch {
            try {
                val result = send(
                    sessionId,
                    buildJsonObject {
                        put("type", "set_fast_mode")
                        put("enabled", enabled)
                    },
                )
                val root = result as? JsonObject
                _state.update {
                    it.copy(
                        fastModeEnabled = root.boolean("enabled") ?: enabled,
                        fastModeActive = root.boolean("active") ?: it.fastModeActive,
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            } finally {
                if (_state.value.sessionId == sessionId) refreshLiveState(sessionId)
            }
        }
    }

    fun onSlowModeChange(enabled: Boolean) {
        _state.update { it.copy(slowModeEnabled = enabled, error = null) }
        val sessionId = _state.value.sessionId
        if (sessionId == null) {
            preSpawnSlow = enabled
            return
        }
        scope.launch {
            try {
                val result = send(
                    sessionId,
                    buildJsonObject {
                        put("type", "set_slow_mode")
                        put("enabled", enabled)
                    },
                )
                val applied = (result as? JsonObject).boolean("enabled") ?: enabled
                preSpawnSlow = null
                _state.update { it.copy(slowModeEnabled = applied) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            } finally {
                if (_state.value.sessionId == sessionId) refreshLiveState(sessionId)
            }
        }
    }

    // --- Advisor / tool preset ---------------------------------------------

    fun onAdvisorChange(enabled: Boolean) {
        _state.update { it.copy(advisorEnabled = enabled) }
        val sessionId = _state.value.sessionId ?: return
        scope.launch { settings.setAdvisorEnabled(sessionId, enabled) }
    }

    fun onToolPresetChange(preset: ToolPreset) {
        _state.update { it.copy(toolPreset = preset) }
        scope.launch { settings.setToolPreset(preset) }
    }

    // --- Context sheet -----------------------------------------------------

    fun openContextSheet() {
        _state.update { it.copy(contextSheetOpen = true) }
        refreshSessionStats()
    }

    fun closeContextSheet() {
        _state.update { it.copy(contextSheetOpen = false) }
    }

    fun refreshSessionStats() {
        val sessionId = _state.value.sessionId ?: return
        statsJob?.cancel()
        _state.update { it.copy(statsLoading = true) }
        statsJob = scope.launch {
            try {
                val payload = send(sessionId, buildJsonObject { put("type", "get_session_stats") })
                if (_state.value.sessionId != sessionId) return@launch
                _state.update {
                    it.copy(
                        sessionStats = parseSessionStats(payload) ?: it.sessionStats,
                        statsLoading = false,
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (_state.value.sessionId == sessionId) {
                    _state.update { it.copy(statsLoading = false, error = e.userMessage()) }
                }
            }
        }
    }

    fun compact() {
        val sessionId = _state.value.sessionId ?: return
        if (_state.value.isCompacting) return
        _state.update {
            it.copy(isCompacting = true, compactError = null, compactResult = null, error = null)
        }
        scope.launch {
            try {
                val result = send(sessionId, buildJsonObject { put("type", "compact") })
                if (_state.value.sessionId != sessionId) return@launch
                _state.update {
                    it.copy(
                        isCompacting = false,
                        compactResult = readCompactResult(result, "manual"),
                    )
                }
                refreshSessionStats()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (_state.value.sessionId == sessionId) {
                    _state.update {
                        it.copy(isCompacting = false, compactError = e.userMessage())
                    }
                }
            }
        }
    }

    fun abortCompaction() {
        val sessionId = _state.value.sessionId ?: return
        scope.launch {
            try {
                send(sessionId, buildJsonObject { put("type", "abort_compaction") })
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            }
        }
    }

    // --- Spawn -------------------------------------------------------------

    /**
     * What `POST /api/agent/new` must carry so the new omp child starts with
     * the composer's choices (the route applies both via RPC after spawn).
     */
    fun pendingSpawnOptions(): SpawnOptions {
        val current = _state.value
        return SpawnOptions(
            provider = current.model?.provider,
            modelId = current.model?.modelId,
            thinkingLevel = current.thinkingLevel.takeIf { it != "auto" },
            toolNames = current.toolPreset.toolNames(),
            advisor = current.advisorEnabled,
        )
    }

    fun clearError() {
        _state.update { it.copy(error = null) }
    }

    /** The chat consumed the ownership refusal (banner + message shown). */
    fun clearForeignRefusal() {
        _state.update { it.copy(foreignRefusal = null) }
    }

    // --- Internals ---------------------------------------------------------

    private fun resetLive() {
        liveModel = null
        liveSlowSupported = null
        liveSlowEnabled = null
        liveSlowScope = null
    }

    private fun beginSync(): Int = ++syncSeq

    /**
     * Whether an omp child exists for the session: `alive` says the process is
     * there, `running` whether a turn is in flight. A server that predates the
     * split reports no `alive`; its `running` (then a bare state object) was the
     * "a child answers" signal, so it stays the fallback.
     */
    private fun childAlive(payload: JsonObject, stateObject: JsonObject?): Boolean =
        payload.boolean("alive") ?: payload.boolean("running") ?: (stateObject != null)

    private fun refreshLiveState(sessionId: String? = _state.value.sessionId) {
        if (sessionId == null) return
        liveJob?.cancel()
        val token = beginSync()
        liveJob = scope.launch {
            try {
                val payload = api.agentState(sessionId)
                if (_state.value.sessionId != sessionId) return@launch
                applyConfig(
                    parseAgentConfig(payload),
                    childAlive(payload, payload["state"] as? JsonObject),
                    token,
                )
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Best effort: keep the last known values; the next snapshot corrects them.
            }
        }
    }

    private fun applyConfig(config: AgentConfigSnapshot, alive: Boolean, token: Int) {
        if (token != syncSeq) return
        syncSeq += 1
        if (config.thinkingLevel != null) liveThinkingReceived = true
        config.model?.let { applyAuthoritativeModel(it) }
        _state.update { current ->
            var next = current
            if (config.fastModeEnabled != null) next = next.copy(fastModeEnabled = config.fastModeEnabled)
            if (config.fastModeActive != null) next = next.copy(fastModeActive = config.fastModeActive)
            next.copy(
                thinkingLevel = config.thinkingLevel?.let(::normalizeThinkingLevel) ?: next.thinkingLevel,
                usageLimit = config.usageLimit,
                contextUsage = config.contextUsage,
                isCompacting = config.isCompacting ?: next.isCompacting,
            )
        }
        // `alive` (the child exists), not `running` (a turn is in flight): an
        // idle wrapper still answers `get_state`, so its Slow support is the
        // live value — the catalog only backs a session without a child.
        liveSlowSupported = if (alive) (config.slowModeSupported ?: false) else null
        liveSlowEnabled = config.slowModeEnabled ?: false
        liveSlowScope = config.slowModeScope
        applySpeed(config.tokensPerSecond)
        refreshDerived()
    }

    /**
     * A runtime model switch (retry fallback, prewalk hand-off, `/model`)
     * supersedes the user's last pick; the composer shows what omp actually runs.
     */
    private fun applyAuthoritativeModel(model: ThinkingModelMeta) {
        liveModel = model
        val pick = pickedModel
        if (pick != null && (pick.provider != model.provider || pick.modelId != model.modelId)) {
            pickedModel = null
        }
    }

    private fun applySpeed(reported: Double?) {
        if (reported == null || !reported.isFinite() || reported <= 0.0) {
            if (lastReportedSpeed != null) {
                lastReportedSpeed = null
                _state.update { it.copy(tokensPerSecond = null) }
            }
            return
        }
        // Distinct reported values feed the rolling average; repeated polls of
        // the same value are ignored (web `ChatWindow` speed samples).
        val quantized = round(reported * 10) / 10.0
        if (quantized == lastReportedSpeed) return
        lastReportedSpeed = quantized
        speedSamples.addLast(quantized)
        while (speedSamples.size > SPEED_SAMPLE_WINDOW) speedSamples.removeFirst()
        _state.update {
            it.copy(
                tokensPerSecond = quantized,
                speedAverage = speedSamples.average(),
            )
        }
    }

    private fun loadCatalog(cwd: String) {
        catalogJob?.cancel()
        val fence = ++catalogFence
        _state.update { it.copy(modelsLoading = true, modelsError = null) }
        catalogJob = scope.launch {
            try {
                val response = api.models(cwd)
                if (fence != catalogFence) return@launch
                catalog = response
                catalogLoaded = true
                refreshDerived()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (fence == catalogFence) {
                    _state.update {
                        it.copy(modelsLoading = false, modelsError = e.userMessage())
                    }
                }
            }
        }
    }

    /** Recomputes every value that depends on (catalog, live state, picks). */
    private fun refreshDerived() {
        val current = _state.value
        val visible = buildModelOptions(
            catalog.modelList.map { ModelOption(it.provider, it.id, it.name) },
            settings.snapshot.value.composerModels,
        )
        val displayKey = pickedModel
            ?: liveModel?.let { ModelKey(it.provider, it.modelId) }
            ?: sessionModel
            ?: if (current.sessionId == null) defaultCatalogModel() else null
        val entry = displayKey?.let { key ->
            catalog.modelList.firstOrNull { it.provider == key.provider && it.id == key.modelId }
        }
        val live = liveModel
        val liveName = if (live != null && displayKey != null &&
            live.provider == displayKey.provider && live.modelId == displayKey.modelId
        ) {
            live.name?.takeIf { it.isNotBlank() }
        } else {
            null
        }
        val modelName = liveName
            ?: entry?.name?.takeIf { it.isNotBlank() }
            ?: sessionModelName?.takeIf { displayKey == sessionModel }
        val catalogLevels = displayKey?.let { catalog.thinkingLevels["${it.provider}:${it.modelId}"] }
        val availableLevels = displayKey?.let { key ->
            resolveAvailableThinkingLevels(catalogLevels, key, live)
        }
        // Pre-spawn (or executable) fallback: omp answers Slow support per model.
        val catalogSlow = if (liveSlowSupported == null) entry?.takeIf { it.supportsSlowMode } else null
        val slowSupported = liveSlowSupported ?: (catalogSlow != null)
        val slowEnabled = when {
            preSpawnSlow != null -> preSpawnSlow!!
            catalogSlow != null -> catalogSlow.provider == "anthropic" && catalog.anthropicSlowMode
            else -> liveSlowEnabled ?: false
        }
        val slowScope = when {
            catalogSlow != null -> if (catalogSlow.provider == "anthropic") "global" else "session"
            else -> liveSlowScope
        }
        val capacity = entry?.let {
            if ((it.contextWindow ?: 0) > 0 || (it.maxTokens ?: 0) > 0) {
                ModelCapacity(it.contextWindow, it.maxTokens)
            } else {
                null
            }
        }
        _state.value = current.copy(
            models = visible,
            modelsLoading = if (catalogLoaded) false else current.modelsLoading,
            model = displayKey,
            modelName = modelName,
            availableThinkingLevels = availableLevels,
            fastModeSupported = entry?.supportsFastMode == true,
            slowModeSupported = slowSupported,
            slowModeEnabled = slowEnabled,
            slowModeScope = slowScope,
            modelCapacity = capacity,
        )
    }

    private fun defaultCatalogModel(): ModelKey? {
        val preferred = catalog.defaultModel?.let { fallback ->
            catalog.modelList.firstOrNull {
                it.provider == fallback.provider && it.id == fallback.modelId
            }
        }
        val entry = preferred ?: catalog.modelList.firstOrNull()
        return entry?.let { ModelKey(it.provider, it.id) }
    }

    /**
     * A new chat that just got its session id: apply the Fast/Slow toggles no
     * spawn field covers (`POST /api/agent/new` only takes
     * model/thinking/tools/advisor). The advisor choice travels through
     * [ChatSettings.markSessionCreated] instead; the commands name
     * [sessionId] explicitly, so the pane that created it still applies them
     * after the chat took over.
     */
    private fun applyPreSpawnChoices(sessionId: String) {
        val fast = preSpawnFast
        val slow = preSpawnSlow
        preSpawnFast = null
        preSpawnSlow = null
        if (fast == null && slow == null) return
        scope.launch {
            try {
                if (fast != null) {
                    send(
                        sessionId,
                        buildJsonObject {
                            put("type", "set_fast_mode")
                            put("enabled", fast)
                        },
                    )
                }
                if (slow != null) {
                    send(
                        sessionId,
                        buildJsonObject {
                            put("type", "set_slow_mode")
                            put("enabled", slow)
                        },
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            } finally {
                if (_state.value.sessionId == sessionId) refreshLiveState(sessionId)
            }
        }
    }

    private suspend fun send(sessionId: String, payload: JsonObject): JsonElement? =
        api.agentCommand(sessionId, payload, _state.value.advisorEnabled)

    private fun fail(error: Throwable) {
        // Another omp process owns the chat: the shell shows the ownership
        // banner and says the command was not applied. The generic message
        // ("your message was not sent") is send wording and would be wrong here.
        if (error is ApiError.SessionRunningElsewhere) {
            _state.update { it.copy(foreignRefusal = ForeignCommandRefusal(error.elsewhere)) }
            return
        }
        _state.update { it.copy(error = error.userMessage()) }
    }

    private companion object {
        /** Web `ChatWindow` keeps the last 32 distinct throughput samples. */
        const val SPEED_SAMPLE_WINDOW = 32
    }
}

private fun JsonObject?.boolean(key: String): Boolean? =
    (this?.get(key) as? JsonPrimitive)?.booleanOrNull

private fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
