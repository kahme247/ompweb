package io.github.kahme247.ompweb.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.viewModelScope
import io.github.kahme247.ompweb.AppContainer
import io.github.kahme247.ompweb.net.agentsApi
import io.github.kahme247.ompweb.net.authApi
import io.github.kahme247.ompweb.net.modelsConfigApi
import io.github.kahme247.ompweb.ui.settings.agents.AgentsViewModel
import io.github.kahme247.ompweb.ui.settings.models.ProvidersModelsViewModel
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch

/**
 * Owns the store of every view model that belongs to one Settings session.
 *
 * The store hangs off this activity-scoped [ViewModel], so rotating the phone
 * keeps unsaved models.yml edits and loaded accounts. Closing Settings calls
 * [clear]; signing out or changing the server clears it too (through
 * [AppContainer.sessionEpoch]), which cancels every collector and drops the
 * loaded models.yml (including plaintext API keys) from the heap.
 */
class SettingsHostViewModel(container: AppContainer) : ViewModel() {

    private val store = ViewModelStore()

    /** Owner for the settings-scoped view models; empty until Settings opens. */
    val owner: ViewModelStoreOwner = object : ViewModelStoreOwner {
        override val viewModelStore: ViewModelStore
            get() = store
    }

    init {
        viewModelScope.launch {
            // The current epoch is the one this host was created in; only a
            // later sign-out/server switch invalidates the stored settings.
            container.sessionEpoch.drop(1).collect { clear() }
        }
    }

    /** Drops every settings view model; the next open constructs fresh ones. */
    fun clear() {
        store.clear()
    }

    override fun onCleared() {
        store.clear()
    }
}

/**
 * [ProvidersModelsViewModel] is not a [ViewModel] itself: this holder gives it
 * a lifecycle scope (cancelled with the settings store) and lets
 * `viewModel()` retain it across rotation. Construction is deferred until
 * Settings is opened, so models.yml is not loaded for a signed-in app that
 * never opens Settings.
 */
class SettingsProvidersHostViewModel(container: AppContainer) : ViewModel() {
    val viewModel = ProvidersModelsViewModel(
        api = container.api.modelsConfigApi(),
        auth = container.api.authApi(),
        settings = container.settings,
        scope = viewModelScope,
    )
}

/** Lifecycle holder for [AgentsViewModel]; see [SettingsProvidersHostViewModel]. */
class SettingsAgentsHostViewModel(container: AppContainer) : ViewModel() {
    val viewModel = AgentsViewModel(container.api.agentsApi(), viewModelScope)
}
