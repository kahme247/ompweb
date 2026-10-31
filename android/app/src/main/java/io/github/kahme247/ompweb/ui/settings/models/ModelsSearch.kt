package io.github.kahme247.ompweb.ui.settings.models

import io.github.kahme247.ompweb.domain.SettingsScope
import io.github.kahme247.ompweb.domain.SettingsSearchEntry
import io.github.kahme247.ompweb.domain.SettingsTab

/**
 * Search rows of the Providers & models tab (web `SettingsConfig.tsx` index).
 * [SettingsSearchEntry.id] values are the jump targets `ProvidersModelsTab`
 * resolves through `ProvidersModelsViewModel.applyHighlight`.
 */
fun providersModelsSearchEntries(): List<SettingsSearchEntry> = listOf(
    SettingsSearchEntry(
        id = "providers-connected",
        tab = SettingsTab.PROVIDERS,
        section = "Connected accounts",
        label = "Connected accounts",
        description = "Signed-in OAuth providers and configured API-key providers",
        scope = SettingsScope.NATIVE_OMP,
    ),
    SettingsSearchEntry(
        id = "providers-oauth",
        tab = SettingsTab.PROVIDERS,
        section = "Connected accounts",
        label = "OAuth login",
        description = "Sign in, paste the callback URL, device code and account selection",
        scope = SettingsScope.NATIVE_OMP,
    ),
    SettingsSearchEntry(
        id = "providers-api-key",
        tab = SettingsTab.PROVIDERS,
        section = "Connected accounts",
        label = "API key status",
        description = "Whether a provider has a key or models; keys are never shown",
        scope = SettingsScope.NATIVE_OMP,
    ),
    SettingsSearchEntry(
        id = "providers-accounts",
        tab = SettingsTab.PROVIDERS,
        section = "Connected accounts",
        label = "Stored accounts",
        description = "Accounts omp holds for a provider and disconnecting one",
        scope = SettingsScope.NATIVE_OMP,
    ),
    SettingsSearchEntry(
        id = "providers-custom",
        tab = SettingsTab.PROVIDERS,
        section = "Custom providers",
        label = "Custom providers",
        description = "Providers and models defined in models.yml",
        scope = SettingsScope.NATIVE_OMP,
    ),
    SettingsSearchEntry(
        id = "providers-add",
        tab = SettingsTab.PROVIDERS,
        section = "Custom providers",
        label = "Add provider",
        description = "Add an OAuth provider or define a custom endpoint",
        scope = SettingsScope.NATIVE_OMP,
    ),
    SettingsSearchEntry(
        id = "providers-catalog",
        tab = SettingsTab.PROVIDERS,
        section = "Custom providers",
        label = "Model catalog",
        description = "Search models.dev to prefill id, context window, limits and cost",
        scope = SettingsScope.NATIVE_OMP,
    ),
    SettingsSearchEntry(
        id = "providers-test",
        tab = SettingsTab.PROVIDERS,
        section = "Custom providers",
        label = "Test model configuration",
        description = "Resolve a model through a throwaway omp registry",
        scope = SettingsScope.NATIVE_OMP,
    ),
    SettingsSearchEntry(
        id = "providers-registry",
        tab = SettingsTab.PROVIDERS,
        section = "System",
        label = "Native model registry",
        description = "Allowed models, disabled providers and provider preference order",
        scope = SettingsScope.NATIVE_OMP,
    ),
    SettingsSearchEntry(
        id = "providers-picker",
        tab = SettingsTab.PROVIDERS,
        section = "System",
        label = "Composer model picker",
        description = "Models offered in the chat composer on this device",
        scope = SettingsScope.UI,
    ),
    SettingsSearchEntry(
        id = "providers-roles",
        tab = SettingsTab.PROVIDERS,
        section = "System",
        label = "Model roles",
        description = "Model and effort for omp's default, smol, plan and other roles",
        scope = SettingsScope.NATIVE_OMP,
    ),
    SettingsSearchEntry(
        id = "providers-fallbacks",
        tab = SettingsTab.PROVIDERS,
        section = "System",
        label = "Retry and model fallback",
        description = "Retry attempts, revert policy and per-role fallback chains",
        scope = SettingsScope.NATIVE_OMP,
    ),
)
