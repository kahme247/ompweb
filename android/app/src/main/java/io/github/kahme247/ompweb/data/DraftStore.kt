package io.github.kahme247.ompweb.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import io.github.kahme247.ompweb.domain.AttachedTextFile
import io.github.kahme247.ompweb.domain.ComposerImage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.contentOrNull

private val Context.draftsDataStore: DataStore<Preferences> by preferencesDataStore(name = "ompweb-drafts")

/** Everything the composer holds for one draft key (session id or `new:<cwd>`). */
data class ChatDraft(
    val value: String = "",
    val images: List<ComposerImage> = emptyList(),
    val files: List<AttachedTextFile> = emptyList(),
) {
    val hasAttachments: Boolean get() = images.isNotEmpty() || files.isNotEmpty()

    fun isEmpty(): Boolean = value.isEmpty() && !hasAttachments
}

/**
 * Content to put back into a composer. `replace` merges a later recovery with
 * an earlier one in order: while the draft still starts with `lead` (the
 * earlier block), it becomes `text`; otherwise only `fallback` is prepended
 * (web `DraftRecovery`).
 */
data class DraftRecovery(
    val text: String,
    val replace: Replace? = null,
    val images: List<ComposerImage> = emptyList(),
) {
    data class Replace(val lead: String, val fallback: String)

    val isEmpty: Boolean get() = text.isEmpty() && images.isEmpty()
}

data class DraftRecoveryEvent(val key: String, val recovery: DraftRecovery)

/**
 * The composer-facing surface of [DraftStore]. View models depend on this so
 * JVM tests can keep drafts in memory without DataStore/Android.
 */
interface ComposerDraftStore {
    val state: StateFlow<Map<String, ChatDraft>>
    val recoveries: SharedFlow<DraftRecoveryEvent>

    fun getDraft(key: String): ChatDraft?
    fun setDraft(key: String, draft: ChatDraft)
    fun clearDraft(key: String)
    fun recoverDraft(key: String, recovery: DraftRecovery)

    /** Drop every draft, e.g. on logout or a server switch. */
    fun clearAll()
}

/** Web `mergeRecoveredText`. */
fun mergeRecoveredText(current: String, recovery: DraftRecovery): String {
    if (recovery.text.isEmpty()) return current
    val replace = recovery.replace
    if (replace != null && current.startsWith(replace.lead)) {
        return recovery.text + current.substring(replace.lead.length)
    }
    val lead = replace?.fallback ?: recovery.text
    return if (current.isEmpty()) lead else "$lead\n\n$current"
}

/**
 * In-memory draft table with the web's eviction rules: at most [maxDrafts]
 * drafts, the first-inserted one is evicted when a new key arrives, and only
 * text is persisted (attachment payloads would exhaust storage quotas).
 *
 * Insertion order is deliberately kept (a re-set keeps its slot), matching
 * JavaScript `Map` semantics of `lib/draft-store.ts`.
 */
class DraftRegistry(initial: List<Pair<String, String>> = emptyList(), private val maxDrafts: Int = MAX_DRAFTS) {
    private val drafts = LinkedHashMap<String, ChatDraft>()

    init {
        for ((key, text) in initial) {
            if (key.isEmpty() || text.isEmpty()) continue
            if (drafts.size >= maxDrafts) {
                // Overflow from an older/foreign store: drop it, like the web reader.
                continue
            }
            drafts[key] = ChatDraft(value = text)
        }
    }

    fun get(key: String): ChatDraft? = drafts[key]?.let(::cloneDraft)

    fun set(key: String, draft: ChatDraft) {
        if (key.isEmpty()) return
        if (draft.isEmpty()) {
            clear(key)
            return
        }
        if (!drafts.containsKey(key) && drafts.size >= maxDrafts) {
            drafts.keys.firstOrNull()?.let { drafts.remove(it) }
        }
        drafts[key] = cloneDraft(draft)
    }

    fun clear(key: String): Boolean = drafts.remove(key) != null

    fun clearAll() = drafts.clear()

    fun isEmpty(): Boolean = drafts.isEmpty()

    /** Persisted form: insertion-ordered `(key, text)` pairs, text-only. */
    fun textEntries(): List<Pair<String, String>> =
        drafts.entries.mapNotNull { (key, draft) -> draft.value.takeIf { it.isNotEmpty() }?.let { key to it } }

    fun snapshot(): Map<String, ChatDraft> = drafts.mapValues { (_, draft) -> cloneDraft(draft) }

    private fun cloneDraft(draft: ChatDraft): ChatDraft = ChatDraft(
        value = draft.value,
        images = draft.images.toList(),
        files = draft.files.toList(),
    )

    companion object {
        const val MAX_DRAFTS: Int = 50
    }
}

/**
 * Per-session composer drafts. Text survives process death (DataStore), while
 * images and attached files stay in memory exactly like the web's
 * `sessionStorage`-text-only rule.
 */
class DraftStore(context: Context, private val scope: CoroutineScope) : ComposerDraftStore {

    private val dataStore = context.applicationContext.draftsDataStore
    private val registry = DraftRegistry()
    private val _state = MutableStateFlow<Map<String, ChatDraft>>(emptyMap())
    private val _recoveries = MutableSharedFlow<DraftRecoveryEvent>(extraBufferCapacity = 8)
    private val persistenceRequests = Channel<Unit>(Channel.CONFLATED)
    /** A clear that arrived before the disk read finished must not be undone by it. */
    private var clearedBeforeHydration = false

    /** The draft table, for hosts that restore a draft when it arrives. */
    override val state: StateFlow<Map<String, ChatDraft>> = _state.asStateFlow()

    /** Recovery intents (stop/abort restoring queue entries); not replayed. */
    override val recoveries: SharedFlow<DraftRecoveryEvent> = _recoveries.asSharedFlow()

    init {
        scope.launch {
            val stored = loadStored()
            if (!clearedBeforeHydration) registry.mergeStored(stored)
            publish()
        }
        scope.launch {
            for (request in persistenceRequests) saveStored(registry.textEntries())
        }
    }

    override fun getDraft(key: String): ChatDraft? = registry.get(key)

    override fun setDraft(key: String, draft: ChatDraft) {
        registry.set(key, draft)
        publish()
        persistenceRequests.trySend(Unit)
    }

    override fun clearDraft(key: String) {
        if (registry.clear(key)) {
            publish()
            persistenceRequests.trySend(Unit)
        }
    }

    override fun clearAll() {
        clearedBeforeHydration = true
        registry.clearAll()
        publish()
        persistenceRequests.trySend(Unit)
    }

    override fun recoverDraft(key: String, recovery: DraftRecovery) {
        if (key.isNotEmpty() && !recovery.isEmpty) {
            val current = registry.get(key) ?: ChatDraft()
            registry.set(
                key,
                current.copy(
                    value = mergeRecoveredText(current.value, recovery),
                    images = current.images + recovery.images,
                ),
            )
            publish()
            persistenceRequests.trySend(Unit)
        }
        // Publish the intent separately: ordinary persistence must not reapply it,
        // and the mounted composer may have state updates still queued.
        _recoveries.tryEmit(DraftRecoveryEvent(key, recovery))
    }

    private fun publish() {
        _state.value = registry.snapshot()
    }

    private suspend fun loadStored(): List<Pair<String, String>> = try {
        val raw = dataStore.data.first()[DRAFTS]
        parseDraftEntries(raw)
    } catch (_: Exception) {
        emptyList()
    }

    private suspend fun saveStored(entries: List<Pair<String, String>>) {
        try {
            dataStore.edit { preferences ->
                if (entries.isEmpty()) preferences.remove(DRAFTS) else preferences[DRAFTS] = encodeDraftEntries(entries)
            }
        } catch (_: Exception) {
            // Keep the in-memory drafts; the next change retries.
        }
    }

    private companion object {
        val DRAFTS = stringPreferencesKey("drafts")
        val json = Json { ignoreUnknownKeys = true }

        fun encodeDraftEntries(entries: List<Pair<String, String>>): String =
            buildJsonArray {
                entries.forEach { (key, text) ->
                    add(JsonArray(listOf(JsonPrimitive(key), JsonPrimitive(text))))
                }
            }.toString()

        fun parseDraftEntries(raw: String?): List<Pair<String, String>> {
            if (raw.isNullOrBlank()) return emptyList()
            return try {
                (json.parseToJsonElement(raw) as? JsonArray)
                    ?.mapNotNull { element ->
                        val pair = element as? JsonArray ?: return@mapNotNull null
                        val key = (pair.getOrNull(0) as? JsonPrimitive)?.contentOrNull
                        val text = (pair.getOrNull(1) as? JsonPrimitive)?.contentOrNull
                        if (key.isNullOrEmpty() || text.isNullOrEmpty()) null else key to text
                    }
                    ?: emptyList()
            } catch (_: Exception) {
                emptyList()
            }
        }
    }
}

/**
 * Merge drafts read from disk into the live table without clobbering a draft
 * the user already started typing: stored text only fills missing keys, and a
 * live key keeps its slot (and its attachments).
 */
internal fun DraftRegistry.mergeStored(stored: List<Pair<String, String>>) {
    for ((key, text) in stored) {
        if (get(key) == null) set(key, ChatDraft(value = text))
    }
}

/**
 * Scopes every draft key to the current server origin, so drafts, recovered
 * queue text and the exit guard never leak into another installation. The
 * origin is read on every call; the published [state] follows the origin, so
 * a server switch never leaves another installation's keys visible. Recovery
 * events are mapped back to plain keys and events from another origin are
 * dropped. [clearAll] clears every origin (logout / server switch).
 */
class OriginScopedDraftStore(
    private val delegate: ComposerDraftStore,
    scope: CoroutineScope,
    private val origin: StateFlow<String?>,
) : ComposerDraftStore {

    private val _state = MutableStateFlow<Map<String, ChatDraft>>(emptyMap())
    override val state: StateFlow<Map<String, ChatDraft>> = _state.asStateFlow()

    private val _recoveries = MutableSharedFlow<DraftRecoveryEvent>(extraBufferCapacity = 8)
    override val recoveries: SharedFlow<DraftRecoveryEvent> = _recoveries.asSharedFlow()

    init {
        scope.launch {
            combine(delegate.state, origin) { drafts, current ->
                if (current.isNullOrEmpty()) {
                    emptyMap()
                } else {
                    val prefix = prefixOf(current)
                    drafts.entries
                        .filter { it.key.startsWith(prefix) }
                        .associate { it.key.removePrefix(prefix) to it.value }
                }
            }.collect { _state.value = it }
        }
        scope.launch {
            delegate.recoveries.collect { event ->
                val prefix = prefix()
                if (event.key.startsWith(prefix)) {
                    _recoveries.tryEmit(event.copy(key = event.key.removePrefix(prefix)))
                }
            }
        }
    }

    private fun prefix(): String = prefixOf(origin.value)

    private fun prefixOf(value: String?): String =
        value?.takeIf { it.isNotEmpty() }?.let { "$it\u0000" }.orEmpty()

    private fun scoped(key: String): String = prefix() + key

    override fun getDraft(key: String): ChatDraft? = delegate.getDraft(scoped(key))

    override fun setDraft(key: String, draft: ChatDraft) = delegate.setDraft(scoped(key), draft)

    override fun clearDraft(key: String) = delegate.clearDraft(scoped(key))

    override fun recoverDraft(key: String, recovery: DraftRecovery) =
        delegate.recoverDraft(scoped(key), recovery)

    override fun clearAll() = delegate.clearAll()
}
