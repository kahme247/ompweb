package io.github.kahme247.ompweb.testutil

import io.github.kahme247.ompweb.data.ChatDraft
import io.github.kahme247.ompweb.data.ChatSettings
import io.github.kahme247.ompweb.data.ComposerDraftStore
import io.github.kahme247.ompweb.data.DraftRecovery
import io.github.kahme247.ompweb.data.DraftRecoveryEvent
import io.github.kahme247.ompweb.data.SettingsSnapshot
import io.github.kahme247.ompweb.domain.ActiveGoal
import io.github.kahme247.ompweb.domain.DictationStore
import io.github.kahme247.ompweb.domain.LocalRecording
import io.github.kahme247.ompweb.domain.SttClaim
import io.github.kahme247.ompweb.domain.SttJob
import io.github.kahme247.ompweb.domain.SttAfter
import io.github.kahme247.ompweb.domain.SubmitDuringRunBehavior
import io.github.kahme247.ompweb.domain.ToolPreset
import io.github.kahme247.ompweb.net.ComposerControlsApi
import io.github.kahme247.ompweb.net.ModelsResponse
import io.github.kahme247.ompweb.net.ServerAddress
import io.github.kahme247.ompweb.net.SttApi
import io.github.kahme247.ompweb.net.SttAudio
import io.github.kahme247.ompweb.net.SttRetryOutcome
import io.github.kahme247.ompweb.net.SttStartOutcome
import io.github.kahme247.ompweb.ui.composer.dictation.OnDeviceStt
import java.io.File
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject

/** In-memory drafts with the same surface as the DataStore-backed store. */
class MemoryDrafts(initial: Map<String, ChatDraft> = emptyMap()) : ComposerDraftStore {
    private val drafts = MutableStateFlow<Map<String, ChatDraft>>(initial)
    private val recoveryEvents = MutableSharedFlow<DraftRecoveryEvent>(extraBufferCapacity = 8)

    override val state: StateFlow<Map<String, ChatDraft>> = drafts
    override val recoveries: SharedFlow<DraftRecoveryEvent> = recoveryEvents.asSharedFlow()

    override fun getDraft(key: String): ChatDraft? = drafts.value[key]

    override fun setDraft(key: String, draft: ChatDraft) {
        drafts.update { it + (key to draft) }
    }

    override fun clearDraft(key: String) {
        drafts.update { it - key }
    }

    override fun clearAll() {
        drafts.value = emptyMap()
    }

    override fun recoverDraft(key: String, recovery: DraftRecovery) {
        val current = drafts.value[key] ?: ChatDraft()
        val text = io.github.kahme247.ompweb.data.mergeRecoveredText(current.value, recovery)
        val images = recovery.images + current.images
        drafts.update { it + (key to current.copy(value = text, images = images)) }
        recoveryEvents.tryEmit(DraftRecoveryEvent(key, recovery))
    }
}

/** Settings with a mutable snapshot; every persisted value is recorded. */
class FakeChatSettings(
    snapshot: SettingsSnapshot = SettingsSnapshot(loaded = true),
) : ChatSettings {
    private val state = MutableStateFlow(snapshot)
    override val snapshot: StateFlow<SettingsSnapshot> = state
    val scrollPositions = mutableMapOf<String, Int>()
    val goals = mutableMapOf<String, ActiveGoal?>()

    override suspend fun setChatScrollPosition(sessionId: String, rowIndex: Int) {
        scrollPositions[sessionId] = rowIndex
    }

    override fun persistChatScrollPosition(sessionId: String, rowIndex: Int) {
        scrollPositions[sessionId] = rowIndex
    }

    override suspend fun setSubmitDuringRun(behavior: SubmitDuringRunBehavior) {
        state.update { it.copy(submitDuringRun = behavior) }
    }

    /** "Change server" on the connect screen: the snapshot's origin moves. */
    fun setOrigin(origin: ServerAddress?) {
        state.update { it.copy(origin = origin) }
    }

    override suspend fun setWordCompletion(mode: String) {
        state.update { it.copy(wordCompletion = mode) }
    }

    override suspend fun setSoundEnabled(enabled: Boolean) {
        state.update { it.copy(soundEnabled = enabled) }
    }

    override suspend fun setActiveGoal(sessionId: String, goal: ActiveGoal?) {
        goals[sessionId] = goal
        state.update {
            it.copy(activeGoals = if (goal == null) it.activeGoals - sessionId else it.activeGoals + (sessionId to goal))
        }
    }

    override suspend fun setToolPreset(preset: ToolPreset) {
        state.update { it.copy(toolPreset = preset.wireName) }
    }

    override suspend fun setComposerTodoCollapsed(collapsed: Boolean) {
        state.update { it.copy(composerTodoCollapsed = collapsed) }
    }

    override suspend fun setComposerSubagentsCollapsed(collapsed: Boolean) {
        state.update { it.copy(composerSubagentsCollapsed = collapsed) }
    }

    override suspend fun setComposerModels(models: Set<String>?) {
        state.update { it.copy(composerModels = models) }
    }

    override suspend fun setOpenUrlAutomatically(enabled: Boolean) {
        state.update { it.copy(openUrlAutomatically = enabled) }
    }

    override suspend fun setAdvisorEnabled(sessionId: String, enabled: Boolean) {
        state.update {
            it.copy(advisorSessions = if (enabled) it.advisorSessions + sessionId else it.advisorSessions - sessionId)
        }
    }

    override fun markSessionCreated(sessionId: String, advisor: Boolean) {
        state.update {
            it.copy(advisorSessions = if (advisor) it.advisorSessions + sessionId else it.advisorSessions - sessionId)
        }
    }
}

/** Composer controls API that answers with empty catalogs. */
class FakeComposerApi : ComposerControlsApi {
    var modelsCalls = mutableListOf<String?>()
    var modelsResponse = ModelsResponse()
    /** Failure for every control command (the ownership gate's 409). */
    var commandFailure: Exception? = null

    override suspend fun models(cwd: String?): ModelsResponse {
        modelsCalls += cwd
        return modelsResponse
    }

    override suspend fun agentState(sessionId: String): JsonObject =
        buildJsonObject { }

    override suspend fun agentCommand(
        sessionId: String,
        command: JsonObject,
        advisor: Boolean,
        force: Boolean,
    ): JsonElement? {
        commandFailure?.let { throw it }
        return null
    }
}

/** Dictation API that never produces a job. */
class FakeSttApi : SttApi {
    override suspend fun start(
        scope: String?,
        owner: String,
        after: SttAfter?,
        audio: ByteArray,
        fileName: String,
        mimeType: String,
    ): SttStartOutcome = SttStartOutcome.Rejected("not configured")

    override suspend fun jobs(scope: String): List<SttJob> = emptyList()

    override suspend fun job(jobId: String): SttJob? = null

    override suspend fun claim(jobId: String, claimToken: String, ownerToken: String): SttClaim? = null

    override suspend fun discard(jobId: String) = Unit

    override suspend fun retry(jobId: String, ownerToken: String): SttRetryOutcome =
        SttRetryOutcome.Missing

    override suspend fun audio(jobId: String): SttAudio? = null
}

/** Scratch files in the JVM temp directory. */
class MemoryDictationStore : DictationStore {
    private var recording: LocalRecording? = null
    private var keptScope: String? = null

    override fun ownerToken(): String = "test-owner"

    override fun scratchFile(name: String): File = File.createTempFile("dictation-", ".m4a").apply { deleteOnExit() }

    override fun keepRecording(scope: String, file: File, mimeType: String, after: SttAfter) {
        keptScope = scope
        recording = LocalRecording(file, mimeType, after)
    }

    override fun savedRecording(scope: String): LocalRecording? =
        recording.takeIf { keptScope == scope }

    override fun clearRecording() {
        recording = null
        keptScope = null
    }
}

/** On-device recognizer that records what the view model asks of it. */
class FakeOnDeviceStt(var available: Boolean = true) : OnDeviceStt {
    var listener: OnDeviceStt.Listener? = null
    var language: String? = null
    var started = false
    var stopped = false
    var cancelled = false
    var released = false

    override fun isOnDeviceAvailable(): Boolean = available

    override fun start(languageTag: String, listener: OnDeviceStt.Listener) {
        started = true
        language = languageTag
        this.listener = listener
    }

    override fun stop() {
        stopped = true
    }

    override fun cancel() {
        cancelled = true
    }

    override fun release() {
        released = true
    }
}
