package io.github.kahme247.ompweb.ui.settings.models

import io.github.kahme247.ompweb.data.ChatSettings
import io.github.kahme247.ompweb.domain.ModelConfig
import io.github.kahme247.ompweb.domain.ModelCostConfig
import io.github.kahme247.ompweb.domain.ModelsFileConfig
import io.github.kahme247.ompweb.domain.ProviderConfig
import io.github.kahme247.ompweb.domain.addFallbackModel
import io.github.kahme247.ompweb.domain.addModelDraft
import io.github.kahme247.ompweb.domain.composeModelRoleSelector
import io.github.kahme247.ompweb.domain.modelsConfigConflict
import io.github.kahme247.ompweb.domain.moveFallbackModel
import io.github.kahme247.ompweb.domain.nativeSettingsWritable
import io.github.kahme247.ompweb.domain.orderedRegistryProviders
import io.github.kahme247.ompweb.domain.removeFallbackModel
import io.github.kahme247.ompweb.domain.renameProvider
import io.github.kahme247.ompweb.domain.parseModelRoleSelector
import io.github.kahme247.ompweb.domain.registryKey
import io.github.kahme247.ompweb.domain.registryProviderIds
import io.github.kahme247.ompweb.domain.toggleComposerModelVisibility
import io.github.kahme247.ompweb.domain.toggleComposerProviderVisibility
import io.github.kahme247.ompweb.domain.toggleDisabledProvider
import io.github.kahme247.ompweb.domain.toggleEnabledModel
import io.github.kahme247.ompweb.domain.toggleModelAllowList
import io.github.kahme247.ompweb.domain.uniqueProviderName
import io.github.kahme247.ompweb.domain.validateModelsConfig
import io.github.kahme247.ompweb.domain.visibleComposerModelCount
import io.github.kahme247.ompweb.domain.withModel
import io.github.kahme247.ompweb.domain.withProvider
import io.github.kahme247.ompweb.domain.withoutModel
import io.github.kahme247.ompweb.domain.withoutProvider
import io.github.kahme247.ompweb.net.ApiError
import io.github.kahme247.ompweb.net.ApiKeyProvider
import io.github.kahme247.ompweb.net.ApiKeyStatus
import io.github.kahme247.ompweb.net.AuthApi
import io.github.kahme247.ompweb.net.CatalogModel
import io.github.kahme247.ompweb.net.ConnectedProvider
import io.github.kahme247.ompweb.net.ModelEntry
import io.github.kahme247.ompweb.net.ModelsConfigApi
import io.github.kahme247.ompweb.net.OAuthProvider
import io.github.kahme247.ompweb.net.ProviderAccounts
import io.github.kahme247.ompweb.net.captureApi
import io.github.kahme247.ompweb.net.userMessage
import io.github.kahme247.ompweb.domain.OAuthFrame
import io.github.kahme247.ompweb.domain.OAuthLoginMachine
import io.github.kahme247.ompweb.domain.ModelOption
import io.github.kahme247.ompweb.domain.isWorking
import io.github.kahme247.ompweb.domain.submitToken
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

/** The web's three sub-tabs of Providers & models. */
enum class ModelsSubTab { CONNECTED, CUSTOM, SYSTEM }

/** The System sub-tab's four pages. */
enum class SystemPage { REGISTRY, PICKER, ROLES, FALLBACKS }

/** What the detail pane shows. */
sealed interface ModelsSelection {
    data class OAuth(val providerId: String) : ModelsSelection
    data class ApiKey(val providerId: String) : ModelsSelection
    data class Provider(val name: String) : ModelsSelection
    data class Model(val providerName: String, val index: Int) : ModelsSelection
}

enum class ModelTestPhase { IDLE, TESTING, SUCCESS, ERROR }

/** `POST /api/models-config/test` result for the open model editor. */
data class ModelTestState(
    val phase: ModelTestPhase = ModelTestPhase.IDLE,
    val message: String? = null,
    val latencyMs: Long? = null,
    val responseText: String? = null,
    val key: String? = null,
)

data class ProvidersModelsState(
    val subTab: ModelsSubTab = ModelsSubTab.CONNECTED,
    val systemPage: SystemPage = SystemPage.REGISTRY,
    val loading: Boolean = false,
    val savingConfig: Boolean = false,
    val config: ModelsFileConfig = ModelsFileConfig(),
    val configPath: String? = null,
    val dirty: Boolean = false,
    /** The JSON the editor loaded; [configConflict] compares it with a fresh read before a save. */
    val configRaw: JsonObject? = null,
    /** Set when models.yml changed on the server since it was loaded. */
    val configConflict: Boolean = false,
    /** Set when models.yml is on disk but unparseable: the editor is blocked. */
    val parseError: String? = null,
    val message: String? = null,
    val messageIsError: Boolean = false,
    val selection: ModelsSelection? = null,
    val connectFilter: String = "",
    val oauthProviders: List<OAuthProvider> = emptyList(),
    val apiKeyProviders: List<ApiKeyProvider> = emptyList(),
    val runtimeModels: List<ModelEntry> = emptyList(),
    val runtimeLoading: Boolean = false,
    val connectedProviders: List<ConnectedProvider> = emptyList(),
    val accounts: ProviderAccounts? = null,
    val accountsLoading: Boolean = false,
    val apiKeyStatus: ApiKeyStatus? = null,
    val apiKeyGuidance: String? = null,
    val login: OAuthLoginMachine = OAuthLoginMachine(),
    val loginProviderId: String? = null,
    val modelTest: ModelTestState = ModelTestState(),
    val catalogProvider: String? = null,
    val catalogQuery: String = "",
    val catalogResults: List<CatalogModel> = emptyList(),
    val catalogLoading: Boolean = false,
    val catalogError: String? = null,
    val ompSettings: JsonObject? = null,
    val settingsPath: String? = null,
    val settingsLoading: Boolean = false,
    val settingsSaving: Boolean = false,
    val settingsError: String? = null,
    val registryReadOnly: Boolean = false,
    val enabledModels: List<String> = emptyList(),
    val disabledProviders: List<String> = emptyList(),
    val providerOrder: List<String> = emptyList(),
    val fallbackRole: String = "default",
    val fallbackChains: Map<String, List<String>> = emptyMap(),
    val retryEnabled: Boolean = true,
    val modelFallback: Boolean = true,
    val maxRetries: Int = 10,
    val revertPolicy: String = "cooldown-expiry",
    val retryExtra: JsonObject = JsonObject(emptyMap()),
    val roles: Map<String, String> = emptyMap(),
    val rolesPath: String? = null,
    val rolesLoading: Boolean = false,
    val rolesSaving: Boolean = false,
    val rolesDirty: Boolean = false,
    val composerModels: Set<String>? = null,
) {
    val allowListEnabled: Boolean get() = enabledModels.isNotEmpty()
    val activeOAuth: List<OAuthProvider> get() = oauthProviders.filter { it.loggedIn }
    val activeApiKeys: List<ApiKeyProvider> get() = apiKeyProviders.filter { it.configured }
    val modelOptions: List<ModelOption>
        get() = runtimeModels.map { ModelOption(provider = it.provider, modelId = it.id, name = it.name) }
    val fallbackChain: List<String> get() = fallbackChains[fallbackRole].orEmpty()
    val visibleModelCount: Int get() = visibleComposerModelCount(composerModels, modelOptions)
    val registryProviders: List<String>
        get() = orderedRegistryProviders(
            providerOrder,
            registryProviderIds(
                runtimeModels.map { it.provider },
                connectedProviders.map { it.id },
                disabledProviders,
            ),
        )
}

/**
 * State and actions of the Providers & models tab (web `ModelsConfig.tsx` and
 * `ModelsConfig-panels.tsx`).
 *
 * The whole models.yml is edited in memory ([ProvidersModelsState.config]) and
 * written with one Save; the registry/fallback switches write through
 * `/api/omp-settings` immediately, serialized so an older snapshot can never
 * overwrite a newer one (the web keeps the same latest-wins queue).
 */
class ProvidersModelsViewModel(
    private val api: ModelsConfigApi,
    private val auth: AuthApi,
    private val settings: ChatSettings,
    private val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow(ProvidersModelsState())
    val state: StateFlow<ProvidersModelsState> = _state.asStateFlow()

    private var loginJob: Job? = null
    private var settingsSaveJob: Job? = null
    private var pendingSettings: AtomicReference<JsonObject?> = AtomicReference(null)

    init {
        refresh()
        scope.launch {
            settings.snapshot.collect { snapshot ->
                _state.update { if (it.composerModels == snapshot.composerModels) it else it.copy(composerModels = snapshot.composerModels) }
            }
        }
    }

    // ── Navigation ───────────────────────────────────────────────────────────

    /** Jump target of a settings-search row (`providersModelsSearchEntries`). */
    fun applyHighlight(id: String) {
        when (id) {
            "providers-connected", "providers-oauth", "providers-api-key", "providers-accounts" -> {
                cancelLogin()
                _state.update { it.copy(subTab = ModelsSubTab.CONNECTED, selection = null) }
            }
            "providers-custom", "providers-add", "providers-catalog", "providers-test" -> {
                cancelLogin()
                _state.update { it.copy(subTab = ModelsSubTab.CUSTOM, selection = null) }
            }
            "providers-registry", "providers-picker", "providers-roles", "providers-fallbacks" -> {
                cancelLogin()
                val page = when (id) {
                    "providers-picker" -> SystemPage.PICKER
                    "providers-roles" -> SystemPage.ROLES
                    "providers-fallbacks" -> SystemPage.FALLBACKS
                    else -> SystemPage.REGISTRY
                }
                _state.update { it.copy(subTab = ModelsSubTab.SYSTEM, systemPage = page, selection = null) }
                loadSystem(page)
            }
        }
    }

    fun selectSubTab(tab: ModelsSubTab) {
        _state.update { it.copy(subTab = tab, selection = null) }
        when (tab) {
            ModelsSubTab.SYSTEM -> loadSystem(state.value.systemPage)
            ModelsSubTab.CUSTOM, ModelsSubTab.CONNECTED -> Unit
        }
    }

    fun selectSystemPage(page: SystemPage) {
        _state.update { it.copy(systemPage = page) }
        loadSystem(page)
    }

    fun select(selection: ModelsSelection?) {
        if (selection !is ModelsSelection.OAuth && selection !is ModelsSelection.ApiKey) cancelLogin()
        _state.update { it.copy(selection = selection, modelTest = ModelTestState()) }
        when (selection) {
            is ModelsSelection.OAuth -> startLogin(selection.providerId)
            is ModelsSelection.ApiKey -> loadApiKeyDetail(selection.providerId)
            else -> Unit
        }
    }

    fun back() {
        cancelLogin()
        _state.update { it.copy(selection = null, modelTest = ModelTestState()) }
    }

    fun setConnectFilter(value: String) = _state.update { it.copy(connectFilter = value) }

    fun dismissMessage() = _state.update { it.copy(message = null, messageIsError = false) }

    // ── Loading ──────────────────────────────────────────────────────────────

    fun refresh() {
        if (state.value.loading) return
        _state.update { it.copy(loading = true, message = null) }
        scope.launch {
            val configResult = captureApi { api.loadModelsConfig() }
            val oauthResult = captureApi { auth.oauthProviders() }
            val apiKeyResult = captureApi { auth.apiKeyProviders() }
            val runtimeResult = captureApi { api.runtimeModels() }
            _state.update { current ->
                val document = configResult.getOrNull()
                current.copy(
                    loading = false,
                    config = when {
                        document?.config != null -> document.config!!
                        document != null -> ModelsFileConfig()
                        else -> current.config
                    },
                    parseError = document?.parseError ?: if (document != null) null else current.parseError,
                    configPath = document?.path ?: current.configPath,
                    dirty = if (document?.config != null) false else current.dirty,
                    configRaw = if (document?.config != null) document.raw else current.configRaw,
                    configConflict = if (document?.config != null) false else current.configConflict,
                    oauthProviders = oauthResult.getOrNull() ?: current.oauthProviders,
                    apiKeyProviders = apiKeyResult.getOrNull() ?: current.apiKeyProviders,
                    runtimeModels = runtimeResult.getOrNull()?.modelList ?: current.runtimeModels,
                    connectedProviders = runtimeResult.getOrNull()?.connectedProviders ?: current.connectedProviders,
                    messageIsError = true,
                    message = listOfNotNull(
                        configResult.exceptionOrNull(),
                        oauthResult.exceptionOrNull(),
                        apiKeyResult.exceptionOrNull(),
                        runtimeResult.exceptionOrNull(),
                    ).firstOrNull()?.userMessage(),
                )
            }
            // A rename/delete may have removed the open provider while reloading.
            _state.update { current ->
                val stillThere = when (val selection = current.selection) {
                    is ModelsSelection.Provider -> current.config.providers.containsKey(selection.name)
                    is ModelsSelection.Model -> current.config.providers[selection.providerName]?.models
                        ?.let { selection.index in it.indices } == true
                    else -> true
                }
                if (stillThere) current else current.copy(selection = null)
            }
        }
    }

    fun refreshRuntimeModels() {
        if (state.value.runtimeLoading) return
        _state.update { it.copy(runtimeLoading = true) }
        scope.launch {
            val result = captureApi { api.runtimeModels() }
            _state.update { current ->
                current.copy(
                    runtimeLoading = false,
                    runtimeModels = result.getOrNull()?.modelList ?: current.runtimeModels,
                    connectedProviders = result.getOrNull()?.connectedProviders ?: current.connectedProviders,
                    message = result.exceptionOrNull()?.userMessage() ?: current.message,
                    messageIsError = result.isFailure || current.messageIsError,
                )
            }
        }
    }

    private fun loadSystem(page: SystemPage) {
        when (page) {
            SystemPage.REGISTRY -> if (state.value.ompSettings == null) loadOmpSettings()
            SystemPage.FALLBACKS -> if (state.value.ompSettings == null) loadOmpSettings()
            SystemPage.ROLES -> if (state.value.roles.isEmpty()) loadRoles()
            SystemPage.PICKER -> if (state.value.runtimeModels.isEmpty()) refreshRuntimeModels()
        }
    }

    /**
     * Refreshes the file when the tab is (re)opened. The view model survives a
     * close/reopen, so this is the only chance to pick up an external edit; a
     * dirty editor is left alone and the save conflict check covers it.
     */
    fun onOpen() {
        val current = state.value
        if (current.dirty || current.savingConfig || current.loading) return
        refresh()
    }

    /** "File changed externally — reload": drops the local edits for the server state. */
    fun reloadAfterConflict() {
        _state.update { it.copy(configConflict = false) }
        refresh()
    }

    fun dismissConflict() = _state.update { it.copy(configConflict = false) }

    fun reloadModelsConfig() = refresh()

    // ── models.yml editing ───────────────────────────────────────────────────

    fun addProvider() {
        _state.update { current ->
            val name = uniqueProviderName(current.config.providers)
            val provider = ProviderConfig(api = "openai-completions")
            current.copy(
                config = current.config.withProvider(name, provider),
                subTab = ModelsSubTab.CUSTOM,
                selection = ModelsSelection.Provider(name),
                dirty = true,
            )
        }
    }

    fun updateProvider(name: String, transform: (ProviderConfig) -> ProviderConfig) {
        _state.update { current ->
            val provider = current.config.providers[name] ?: return@update current
            current.copy(
                config = current.config.withProvider(name, transform(provider)),
                dirty = true,
            )
        }
    }

    fun renameProvider(from: String, to: String) {
        val trimmed = to.trim()
        if (trimmed.isEmpty()) {
            message("Provider name is required.", error = true)
            return
        }
        val state = state.value
        if (trimmed != from && state.config.providers.containsKey(trimmed)) {
            message("\"$trimmed\" already exists.", error = true)
            return
        }
        _state.update { current ->
            val selection = current.selection
            current.copy(
                config = current.config.renameProvider(from, trimmed),
                selection = if (selection is ModelsSelection.Provider && selection.name == from) {
                    ModelsSelection.Provider(trimmed)
                } else {
                    selection
                },
                dirty = true,
            )
        }
    }

    fun removeProvider(name: String) {
        _state.update { current ->
            current.copy(
                config = current.config.withoutProvider(name),
                selection = current.selection.takeUnless {
                    (it is ModelsSelection.Provider && it.name == name) ||
                        (it is ModelsSelection.Model && it.providerName == name)
                },
                dirty = true,
            )
        }
    }

    fun addModel(providerName: String) {
        _state.update { current ->
            val (config, index) = current.config.addModelDraft(providerName)
            current.copy(
                config = config,
                selection = ModelsSelection.Model(providerName, index),
                dirty = true,
                modelTest = ModelTestState(),
            )
        }
    }

    fun updateModel(providerName: String, index: Int, transform: (ModelConfig) -> ModelConfig) {
        _state.update { current ->
            val model = current.config.providers[providerName]?.models?.getOrNull(index) ?: return@update current
            current.copy(
                config = current.config.withModel(providerName, index, transform(model)),
                dirty = true,
            )
        }
    }

    fun removeModel(providerName: String, index: Int) {
        _state.update { current ->
            val selection = current.selection
            current.copy(
                config = current.config.withoutModel(providerName, index),
                dirty = true,
                modelTest = ModelTestState(),
                selection = when {
                    selection !is ModelsSelection.Model || selection.providerName != providerName -> selection
                    selection.index == index -> null
                    selection.index > index -> ModelsSelection.Model(providerName, selection.index - 1)
                    else -> selection
                },
            )
        }
    }

    fun addCatalogModel(providerName: String, model: CatalogModel, baseUrl: String?) {
        _state.update { current ->
            val provider = current.config.providers[providerName] ?: ProviderConfig()
            val hasPrice = model.cost.input != null && model.cost.output != null
            val entry = ModelConfig(
                id = model.id,
                name = model.name.takeIf { it.isNotBlank() && it != model.id },
                reasoning = model.reasoning,
                input = model.input,
                contextWindow = model.contextWindow,
                maxTokens = model.maxTokens,
                cost = if (hasPrice) {
                    ModelCostConfig(
                        input = model.cost.input,
                        output = model.cost.output,
                        cacheRead = model.cost.cacheRead ?: 0.0,
                        cacheWrite = model.cost.cacheWrite ?: 0.0,
                    )
                } else {
                    null
                },
            )
            val models = if (provider.models.any { it.id == entry.id }) provider.models else provider.models + entry
            val updated = provider.copy(
                baseUrl = provider.baseUrl ?: baseUrl?.takeIf { it.isNotBlank() },
                models = models,
            )
            current.copy(
                config = current.config.withProvider(providerName, updated),
                dirty = true,
                catalogProvider = null,
                catalogQuery = "",
                catalogResults = emptyList(),
                message = "Added ${model.id}.",
                messageIsError = false,
            )
        }
    }

    fun saveConfig() {
        val current = state.value
        if (current.parseError != null || current.savingConfig || !current.dirty) return
        if (current.config.unparsedEntries.isNotEmpty()) {
            message(
                "Saving is blocked: ${current.config.unparsedEntries.joinToString(", ")} cannot be edited here.",
                error = true,
            )
            return
        }
        val saveable = current.config.forSave()
        validateModelsConfig(saveable)?.let { error ->
            message(error, error = true)
            return
        }
        _state.update { it.copy(savingConfig = true, message = null) }
        scope.launch {
            // The route has no ETag: compare the file this editor loaded with a
            // fresh read so an external edit is never overwritten silently.
            val fresh = captureApi { api.loadModelsConfig() }
            if (fresh.isFailure) {
                _state.update {
                    it.copy(
                        savingConfig = false,
                        message = fresh.exceptionOrNull()?.userMessage(),
                        messageIsError = true,
                    )
                }
                return@launch
            }
            if (modelsConfigConflict(current.configRaw, fresh.getOrNull()?.raw)) {
                _state.update { it.copy(savingConfig = false, configConflict = true) }
                return@launch
            }
            val result = captureApi { api.saveModelsConfig(saveable) }
            result.fold(
                onSuccess = {
                    _state.update { it.copy(savingConfig = false, message = "models.yml saved.", messageIsError = false) }
                    refresh()
                },
                onFailure = { error ->
                    val message = error.userMessage()
                    val unparseable = error is ApiError.ServerResponse && error.code == "models_config_unparseable"
                    _state.update {
                        it.copy(
                            savingConfig = false,
                            parseError = if (unparseable) message else it.parseError,
                            message = message,
                            messageIsError = true,
                        )
                    }
                },
            )
        }
    }

    /** Explicit "overwrite anyway" after the parse-error screen warned the user. */
    fun overwriteUnparseable() {
        if (state.value.savingConfig) return
        _state.update { it.copy(savingConfig = true, message = null) }
        scope.launch {
            val result = captureApi { api.saveModelsConfig(state.value.config.forSave(), overwriteUnparseable = true) }
            result.fold(
                onSuccess = {
                    _state.update {
                        it.copy(savingConfig = false, parseError = null, message = "models.yml overwritten.", messageIsError = false)
                    }
                    refresh()
                },
                onFailure = { error ->
                    _state.update {
                        it.copy(savingConfig = false, message = error.userMessage(), messageIsError = true)
                    }
                },
            )
        }
    }

    // ── OAuth login ──────────────────────────────────────────────────────────

    fun startLogin(providerId: String) {
        loginJob?.cancel()
        _state.update { it.copy(loginProviderId = providerId, login = OAuthLoginMachine().start()) }
        loginJob = scope.launch {
            try {
                auth.login(providerId) { frame -> onLoginFrame(providerId, frame) }
                _state.update { it.copy(login = it.login.streamEnded()) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _state.update { it.copy(login = it.login.streamFailed(error.userMessage())) }
            }
        }
    }

    private fun onLoginFrame(providerId: String, frame: OAuthFrame) {
        _state.update { it.copy(login = it.login.onFrame(frame)) }
        if (frame is OAuthFrame.Success) reloadConnected()
    }

    fun cancelLogin() {
        loginJob?.cancel()
        loginJob = null
        _state.update { it.copy(login = it.login.cancel()) }
    }

    fun submitLogin(value: String) {
        val current = state.value
        val providerId = current.loginProviderId ?: return
        val token = current.login.state.submitToken ?: return
        if (!current.login.state.isWorking) return
        _state.update { it.copy(login = it.login.submitting()) }
        scope.launch {
            val result = captureApi { auth.submitLogin(providerId, token, value) }
            result.onFailure { error ->
                _state.update { it.copy(login = it.login.submitFailed(error.userMessage())) }
            }
        }
    }

    fun submitLoginOption(optionId: String) = submitLogin(optionId)

    private fun reloadConnected() {
        scope.launch {
            val oauth = captureApi { auth.oauthProviders() }
            val apiKeys = captureApi { auth.apiKeyProviders() }
            val runtime = captureApi { api.runtimeModels() }
            _state.update { current ->
                current.copy(
                    oauthProviders = oauth.getOrNull() ?: current.oauthProviders,
                    apiKeyProviders = apiKeys.getOrNull() ?: current.apiKeyProviders,
                    runtimeModels = runtime.getOrNull()?.modelList ?: current.runtimeModels,
                    connectedProviders = runtime.getOrNull()?.connectedProviders ?: current.connectedProviders,
                )
            }
        }
    }

    // ── API-key detail ───────────────────────────────────────────────────────

    private fun loadApiKeyDetail(provider: String) {
        _state.update { it.copy(accounts = null, apiKeyStatus = null, apiKeyGuidance = null, accountsLoading = true) }
        scope.launch {
            val status = captureApi { auth.apiKeyStatus(provider) }
            val accounts = captureApi { auth.accounts(provider) }
            val guidance = auth.apiKeyGuidance(provider)
            _state.update { current ->
                current.copy(
                    accountsLoading = false,
                    apiKeyStatus = status.getOrNull() ?: current.apiKeyStatus,
                    accounts = accounts.getOrNull() ?: current.accounts,
                    apiKeyGuidance = guidance ?: current.apiKeyGuidance,
                    message = (status.exceptionOrNull() ?: accounts.exceptionOrNull())?.userMessage() ?: current.message,
                    messageIsError = status.isFailure || accounts.isFailure || current.messageIsError,
                )
            }
        }
    }

    fun refreshAccounts(provider: String) = loadApiKeyDetail(provider)

    fun disconnectAccount(provider: String, credentialId: Long) {
        scope.launch {
            val result = captureApi { auth.disconnectAccount(provider, credentialId) }
            result.fold(
                onSuccess = { loadApiKeyDetail(provider); reloadConnected() },
                onFailure = { error -> message(error.userMessage(), error = true) },
            )
        }
    }

    // ── Model test ───────────────────────────────────────────────────────────

    fun testModel(providerName: String, index: Int) {
        val current = state.value
        val provider = current.config.providers[providerName] ?: return
        val model = provider.models.getOrNull(index) ?: return
        if (model.id.isBlank()) {
            message("Model ID is required.", error = true)
            return
        }
        val key = "$providerName:$index:${model.id}"
        _state.update { it.copy(modelTest = ModelTestState(phase = ModelTestPhase.TESTING, key = key)) }
        scope.launch {
            val result = captureApi { api.testModel(providerName, provider, model) }
            _state.update {
                it.copy(
                    modelTest = result.fold(
                        onSuccess = { reply ->
                            if (reply.ok) {
                                ModelTestState(
                                    phase = ModelTestPhase.SUCCESS,
                                    latencyMs = reply.latencyMs,
                                    responseText = reply.responseText,
                                    key = key,
                                )
                            } else {
                                ModelTestState(
                                    phase = ModelTestPhase.ERROR,
                                    message = reply.error ?: reply.code ?: "The model did not resolve.",
                                    latencyMs = reply.latencyMs,
                                    key = key,
                                )
                            }
                        },
                        onFailure = { error ->
                            ModelTestState(phase = ModelTestPhase.ERROR, message = error.userMessage(), key = key)
                        },
                    ),
                )
            }
        }
    }

    // ── Model catalog picker ─────────────────────────────────────────────────

    fun openCatalog(providerName: String) {
        _state.update { it.copy(catalogProvider = providerName, catalogQuery = "", catalogResults = emptyList(), catalogError = null) }
    }

    fun closeCatalog() = _state.update {
        it.copy(catalogProvider = null, catalogQuery = "", catalogResults = emptyList(), catalogError = null)
    }

    fun setCatalogQuery(query: String) {
        _state.update { it.copy(catalogQuery = query) }
        searchCatalog()
    }

    fun searchCatalog() {
        val current = state.value
        val providerName = current.catalogProvider ?: return
        val provider = current.config.providers[providerName]
        _state.update { it.copy(catalogLoading = true, catalogError = null) }
        scope.launch {
            val result = captureApi {
                api.catalog(
                    query = current.catalogQuery,
                    provider = providerName,
                    baseUrl = provider?.baseUrl.orEmpty(),
                )
            }
            _state.update {
                it.copy(
                    catalogLoading = false,
                    catalogResults = result.getOrNull() ?: it.catalogResults,
                    catalogError = result.exceptionOrNull()?.userMessage(),
                )
            }
        }
    }

    // ── /api/omp-settings: registry and fallbacks ────────────────────────────

    private fun loadOmpSettings(force: Boolean = false) {
        if (state.value.settingsLoading) return
        if (!force && state.value.ompSettings != null) return
        _state.update { it.copy(settingsLoading = true, settingsError = null) }
        scope.launch {
            val result = captureApi { api.ompSettings() }
            result.fold(
                onSuccess = { document ->
                    _state.update { it.copy(settingsLoading = false, settingsPath = document.path) }
                    applySettings(document.settings)
                },
                onFailure = { error ->
                    _state.update { it.copy(settingsLoading = false, settingsError = error.userMessage()) }
                },
            )
        }
    }

    /** Retry after a failed load or save (the registry/fallback pages stay locked otherwise). */
    fun reloadSettings() = loadOmpSettings(force = true)

    private fun applySettings(settings: JsonObject) {
        val retry = settings["retry"] as? JsonObject ?: JsonObject(emptyMap())
        val chainsRoot = retry["fallbackChains"] as? JsonObject
        val chains = LinkedHashMap<String, List<String>>()
        chainsRoot?.forEach { (role, value) ->
            val list = (value as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.contentOrNull }
            if (list != null) chains[role] = list
        }
        val retryExtra = LinkedHashMap<String, JsonElement>()
        retry.forEach { (key, value) ->
            if (key !in RETRY_KEYS) retryExtra[key] = value
        }
        _state.update {
            it.copy(
                ompSettings = settings,
                enabledModels = settings.stringList("enabledModels"),
                disabledProviders = settings.stringList("disabledProviders"),
                providerOrder = settings.stringList("modelProviderOrder"),
                registryReadOnly = settings.boolean("registryHasScopedEntries"),
                fallbackChains = chains,
                retryEnabled = retry.boolOrNull("enabled") ?: true,
                modelFallback = retry.boolOrNull("modelFallback") ?: true,
                maxRetries = retry.intValue("maxRetries") ?: 10,
                revertPolicy = retry.stringOrNull("fallbackRevertPolicy") ?: "cooldown-expiry",
                retryExtra = JsonObject(retryExtra),
            )
        }
    }

    private fun JsonObject.stringList(key: String): List<String> =
        (this[key] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.contentOrNull }.orEmpty()

    private fun JsonObject.boolean(key: String): Boolean =
        (this[key] as? JsonPrimitive)?.booleanOrNull == true

    private fun JsonObject.boolOrNull(key: String): Boolean? =
        (this[key] as? JsonPrimitive)?.booleanOrNull

    private fun JsonObject.stringOrNull(key: String): String? =
        (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

    private fun JsonObject.intValue(key: String): Int? = (this[key] as? JsonPrimitive)?.intOrNull

    /** Builds the full snapshot to PUT: every unknown key of the loaded settings is preserved. */
    private fun buildSettingsSnapshot(): JsonObject {
        val current = state.value
        val root = LinkedHashMap<String, JsonElement>(current.ompSettings ?: JsonObject(emptyMap()))
        if (current.enabledModels.isEmpty()) root.remove("enabledModels") else root["enabledModels"] = buildJsonArray {
            current.enabledModels.forEach { add(JsonPrimitive(it)) }
        }
        root["disabledProviders"] = buildJsonArray { current.disabledProviders.forEach { add(JsonPrimitive(it)) } }
        root["modelProviderOrder"] = buildJsonArray { current.providerOrder.forEach { add(JsonPrimitive(it)) } }
        val retry = LinkedHashMap<String, JsonElement>(current.retryExtra)
        retry["enabled"] = JsonPrimitive(current.retryEnabled)
        retry["modelFallback"] = JsonPrimitive(current.modelFallback)
        retry["maxRetries"] = JsonPrimitive(current.maxRetries)
        retry["fallbackRevertPolicy"] = JsonPrimitive(current.revertPolicy)
        retry["fallbackChains"] = buildJsonObject {
            current.fallbackChains.forEach { (role, chain) ->
                put(role, buildJsonArray { chain.forEach { add(JsonPrimitive(it)) } })
            }
        }
        root["retry"] = JsonObject(retry)
        return JsonObject(root)
    }

    /**
     * Optimistically applies the switch locally, then queues one serialized
     * PUT of the newest snapshot (the web's latest-wins drain loop).
     */
    private fun saveSettingsImmediately() {
        if (!settingsWritable()) return
        pendingSettings.set(buildSettingsSnapshot())
        if (settingsSaveJob?.isActive == true) return
        settingsSaveJob = scope.launch {
            var savedSomething = false
            while (true) {
                val next = pendingSettings.getAndSet(null) ?: break
                _state.update { it.copy(settingsSaving = true, settingsError = null) }
                val result = captureApi { api.saveOmpSettings(next) }
                if (result.isFailure) {
                    val error = result.exceptionOrNull()
                    _state.update {
                        it.copy(settingsSaving = false, settingsError = error?.userMessage())
                    }
                    break
                }
                applySettings(result.getOrThrow())
                _state.update { it.copy(settingsSaving = false) }
                savedSomething = true
            }
            // The registry changes which models omp reports.
            if (savedSomething) refreshRuntimeModels()
        }
    }

    /**
     * The snapshot is rebuilt from the loaded document; without it (or after a
     * failed load/save) a write would replace retry/registry keys with defaults.
     */
    private fun settingsWritable(): Boolean {
        val current = state.value
        if (nativeSettingsWritable(current.ompSettings, current.settingsError)) return true
        if (current.settingsError == null) {
            message("Settings are not loaded. Reload before changing the registry or fallbacks.", error = true)
        }
        return false
    }

    fun setAllowListEnabled(enabled: Boolean) {
        if (state.value.registryReadOnly || !settingsWritable()) return
        _state.update {
            it.copy(enabledModels = toggleModelAllowList(it.enabledModels, it.modelOptions.map { m -> m.registryKey }, enabled))
        }
        saveSettingsImmediately()
    }

    fun setModelEnabled(key: String, enabled: Boolean) {
        if (state.value.registryReadOnly || !settingsWritable()) return
        _state.update { it.copy(enabledModels = toggleEnabledModel(it.enabledModels, key, enabled)) }
        saveSettingsImmediately()
    }

    fun setProviderDisabled(provider: String, disabled: Boolean) {
        if (state.value.registryReadOnly || !settingsWritable()) return
        _state.update { it.copy(disabledProviders = toggleDisabledProvider(it.disabledProviders, provider, disabled)) }
        saveSettingsImmediately()
    }

    fun moveProvider(index: Int, offset: Int) {
        if (state.value.registryReadOnly || !settingsWritable()) return
        _state.update { current ->
            val ordered = current.registryProviders
            val target = index + offset
            if (index !in ordered.indices || target !in ordered.indices) return@update current
            val next = ordered.toMutableList().apply {
                val moved = this[index]
                this[index] = this[target]
                this[target] = moved
            }
            current.copy(providerOrder = next)
        }
        saveSettingsImmediately()
    }

    /**
     * `POST /api/providers/enable` — omp's own "enable this connected provider"
     * (not the registry's disabled list), used by the picker's hint for a
     * connected provider that reports no models.
     */
    fun enableProvider(provider: String) {
        _state.update { it.copy(message = null) }
        scope.launch {
            val result = captureApi { api.enableProvider(provider) }
            result.fold(
                onSuccess = {
                    _state.update { it.copy(message = "Enabled $provider in omp.", messageIsError = false) }
                    refreshRuntimeModels()
                },
                onFailure = { error ->
                    _state.update { it.copy(message = error.userMessage(), messageIsError = true) }
                },
            )
        }
    }

    // ── Fallback chains ──────────────────────────────────────────────────────

    fun setFallbackRole(role: String) = _state.update { it.copy(fallbackRole = role) }

    fun setRetryEnabled(enabled: Boolean) {
        if (!settingsWritable()) return
        _state.update { it.copy(retryEnabled = enabled) }
        saveSettingsImmediately()
    }

    fun setModelFallback(enabled: Boolean) {
        if (!settingsWritable()) return
        _state.update { it.copy(modelFallback = enabled) }
        saveSettingsImmediately()
    }

    fun setMaxRetries(count: Int) {
        if (!settingsWritable()) return
        _state.update { it.copy(maxRetries = count) }
        saveSettingsImmediately()
    }

    fun setRevertPolicy(policy: String) {
        if (!settingsWritable()) return
        _state.update { it.copy(revertPolicy = policy) }
        saveSettingsImmediately()
    }

    fun addFallback(selector: String) {
        if (!settingsWritable()) return
        _state.update { current ->
            current.copy(fallbackChains = current.fallbackChains + (current.fallbackRole to addFallbackModel(current.fallbackChain, selector)))
        }
        saveSettingsImmediately()
    }

    fun removeFallback(selector: String) {
        if (!settingsWritable()) return
        _state.update { current ->
            current.copy(fallbackChains = current.fallbackChains + (current.fallbackRole to removeFallbackModel(current.fallbackChain, selector)))
        }
        saveSettingsImmediately()
    }

    fun moveFallback(index: Int, offset: Int) {
        if (!settingsWritable()) return
        _state.update { current ->
            val moved = moveFallbackModel(current.fallbackChain, index, offset)
            if (moved == current.fallbackChain) current else current.copy(fallbackChains = current.fallbackChains + (current.fallbackRole to moved))
        }
        saveSettingsImmediately()
    }

    // ── Model roles ──────────────────────────────────────────────────────────

    fun loadRoles() {
        if (state.value.rolesLoading) return
        _state.update { it.copy(rolesLoading = true) }
        scope.launch {
            val result = captureApi { api.modelRoles() }
            _state.update {
                it.copy(
                    rolesLoading = false,
                    roles = result.getOrNull()?.roles ?: it.roles,
                    rolesPath = result.getOrNull()?.path ?: it.rolesPath,
                    rolesDirty = if (result.isSuccess) false else it.rolesDirty,
                    message = result.exceptionOrNull()?.userMessage() ?: it.message,
                    messageIsError = result.isFailure || it.messageIsError,
                )
            }
        }
    }

    fun setRoleModel(role: String, model: String) {
        _state.update { current ->
            val effort = parseModelRoleSelector(current.roles[role].orEmpty()).effort
            current.copy(roles = current.roles + (role to composeModelRoleSelector(model, effort)), rolesDirty = true)
        }
    }

    fun setRoleEffort(role: String, effort: String) {
        _state.update { current ->
            val model = parseModelRoleSelector(current.roles[role].orEmpty()).model
            current.copy(
                roles = current.roles + (role to composeModelRoleSelector(model, effort.ifBlank { null })),
                rolesDirty = true,
            )
        }
    }

    fun saveRoles() {
        if (state.value.rolesSaving) return
        _state.update { it.copy(rolesSaving = true) }
        scope.launch {
            val result = captureApi { api.saveModelRoles(state.value.roles) }
            result.fold(
                onSuccess = { saved ->
                    _state.update {
                        it.copy(rolesSaving = false, roles = saved, rolesDirty = false, message = "Model roles saved.", messageIsError = false)
                    }
                },
                onFailure = { error ->
                    _state.update { it.copy(rolesSaving = false, message = error.userMessage(), messageIsError = true) }
                },
            )
        }
    }

    // ── Composer visibility (`omp-composer-models`) ──────────────────────────

    fun setComposerModelVisible(key: String, visible: Boolean) {
        persistComposerVisibility(toggleComposerModelVisibility(state.value.composerModels, state.value.modelOptions, key, visible))
    }

    fun setComposerProviderVisible(provider: String, visible: Boolean) {
        persistComposerVisibility(toggleComposerProviderVisibility(state.value.composerModels, state.value.modelOptions, provider, visible))
    }

    private fun persistComposerVisibility(visible: Set<String>) {
        _state.update { it.copy(composerModels = visible) }
        scope.launch { settings.setComposerModels(visible) }
    }

    // ── Misc ─────────────────────────────────────────────────────────────────

    private fun message(text: String, error: Boolean) {
        _state.update { it.copy(message = text, messageIsError = error) }
    }

    private companion object {
        val RETRY_KEYS = setOf("enabled", "modelFallback", "maxRetries", "fallbackRevertPolicy", "fallbackChains")
    }
}
