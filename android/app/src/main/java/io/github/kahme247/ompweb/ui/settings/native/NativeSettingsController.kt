package io.github.kahme247.ompweb.ui.settings.native

import io.github.kahme247.ompweb.domain.NativeSettingsDocument
import io.github.kahme247.ompweb.domain.NativeSettingsSaveQueue
import io.github.kahme247.ompweb.domain.validateNativeSettings
import io.github.kahme247.ompweb.net.NativeSettingsApi
import io.github.kahme247.ompweb.net.userMessage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** The native OMP settings page state (`GET` loaded, `PUT` in flight, failures). */
data class NativeSettingsState(
    val document: NativeSettingsDocument = NativeSettingsDocument(),
    val loading: Boolean = true,
    val saving: Boolean = false,
    val loaded: Boolean = false,
    val error: String? = null,
)

/**
 * Native OMP settings (`/api/omp-settings`) with the web's autosave semantics
 * (`components/SettingsConfig.tsx` `saveNativeSettings`): each change is
 * shown immediately, snapshots are PUT one at a time while intermediate edits
 * coalesce into the next request, and a failed PUT reverts the page to the
 * last snapshot the server confirmed (the server rejected the whole file).
 *
 * Every mutation runs on the caller's scope (the app's main scope in
 * production), so the queue needs no locking.
 */
class NativeSettingsController(
    private val api: NativeSettingsApi,
    private val scope: CoroutineScope,
) {
    private val queue = NativeSettingsSaveQueue()

    private val _state = MutableStateFlow(NativeSettingsState())
    val state: StateFlow<NativeSettingsState> = _state.asStateFlow()

    private var loadJob: Job? = null
    private var drainJob: Job? = null

    /** Loads once; [force] retries a failed load. Never clobbers unsaved edits. */
    fun load(force: Boolean = false) {
        val current = _state.value
        if (loadJob?.isActive == true) return
        if (!force && current.loaded && current.error == null) return
        if (queue.hasPending || current.saving) return
        loadJob = scope.launch {
            _state.update { it.copy(loading = true, error = null) }
            try {
                val snapshot = api.load()
                queue.confirm(snapshot.document)
                _state.update {
                    it.copy(
                        document = snapshot.document,
                        loading = false,
                        loaded = true,
                        error = null,
                    )
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                _state.update { it.copy(loading = false, error = error.userMessage()) }
            }
        }
    }

    /**
     * Applies one local change and queues the resulting snapshot. Ignored
     * before the first successful load: writing defaults over the user's
     * config file would destroy every key the server did not send.
     */
    fun edit(transform: (NativeSettingsDocument) -> NativeSettingsDocument) {
        if (!_state.value.loaded) return
        val current = _state.value.document
        val next = transform(current)
        if (next == current) return
        // The server validates the same shape; checking here keeps an invalid
        // edit out of the queue and shows the reason instead of a 400.
        val issues = validateNativeSettings(next)
        if (issues.isNotEmpty()) {
            _state.update { it.copy(error = issues.first()) }
            return
        }
        queue.edit(next)
        _state.update { it.copy(document = next, error = null) }
        startDrain()
    }

    /** Clears a save error without touching the (already reverted) document. */
    fun dismissError() {
        _state.update { it.copy(error = null) }
    }

    private fun startDrain() {
        if (drainJob?.isActive == true) return
        drainJob = scope.launch {
            _state.update { it.copy(saving = true) }
            while (true) {
                val next = queue.take()
                if (next == null) {
                    _state.update { it.copy(saving = false) }
                    return@launch
                }
                try {
                    val saved = api.save(next)
                    queue.confirm(saved.document)
                    _state.update { it.copy(document = queue.current, saving = queue.hasPending) }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Throwable) {
                    val reverted = queue.fail()
                    _state.update {
                        it.copy(document = reverted, saving = false, error = error.userMessage())
                    }
                    return@launch
                }
            }
        }
    }
}
