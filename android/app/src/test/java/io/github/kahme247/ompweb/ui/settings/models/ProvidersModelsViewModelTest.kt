package io.github.kahme247.ompweb.ui.settings.models

import io.github.kahme247.ompweb.domain.ModelConfig
import io.github.kahme247.ompweb.domain.ModelsFileConfig
import io.github.kahme247.ompweb.domain.OAuthFrame
import io.github.kahme247.ompweb.domain.ProviderConfig
import io.github.kahme247.ompweb.domain.withThinkingLevel
import io.github.kahme247.ompweb.net.ApiError
import io.github.kahme247.ompweb.net.ApiKeyProvider
import io.github.kahme247.ompweb.net.ApiKeyStatus
import io.github.kahme247.ompweb.net.AuthApi
import io.github.kahme247.ompweb.net.CatalogModel
import io.github.kahme247.ompweb.net.ConnectedProvider
import io.github.kahme247.ompweb.net.ModelEntry
import io.github.kahme247.ompweb.net.ModelRolesDocument
import io.github.kahme247.ompweb.net.ModelTestResult
import io.github.kahme247.ompweb.net.ModelsConfigApi
import io.github.kahme247.ompweb.net.ModelsConfigDocument
import io.github.kahme247.ompweb.net.ModelsResponse
import io.github.kahme247.ompweb.net.OAuthProvider
import io.github.kahme247.ompweb.net.OmpSettingsDocument
import io.github.kahme247.ompweb.net.ProviderAccount
import io.github.kahme247.ompweb.net.ProviderAccounts
import io.github.kahme247.ompweb.testutil.FakeChatSettings
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.JsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * B23: the provider actions the Connected and Custom sub-tabs fire — account
 * disconnect, the API-key status card, the model test button, the thinking
 * editor and the model catalog — against a fake API so every branch (success,
 * server refusal, blank input) is observable without a device.
 *
 * The fakes answer without suspension; the view model runs on a plain
 * coroutine scope, so [waitFor] polls the state flow instead of the dispatcher.
 */
class ProvidersModelsViewModelTest {

    private val api = FakeModelsConfigApi()
    private val auth = FakeAuthApi()
    private val settings = FakeChatSettings()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val viewModel = ProvidersModelsViewModel(api, auth, settings, scope)

    @After
    fun tearDown() {
        scope.cancel()
    }

    private fun waitFor(what: String, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return
            Thread.sleep(10)
        }
        throw AssertionError("timed out waiting for $what")
    }

    private fun loaded() {
        waitFor("the initial refresh") {
            val state = viewModel.state.value
            !state.loading && state.config.providers.isNotEmpty()
        }
    }

    // ------------------------------------------------------ account disconnect

    @Test
    fun `disconnect removes the credential and reloads the account card`() {
        loaded()
        viewModel.refreshAccounts("deepseek")
        waitFor("the account card") {
            viewModel.state.value.apiKeyStatus?.configured == true &&
                viewModel.state.value.accounts?.accounts?.size == 2
        }
        assertEquals("Get a key at platform.example", viewModel.state.value.apiKeyGuidance)

        viewModel.disconnectAccount("deepseek", credentialId = 42L)

        waitFor("the disconnect request") { auth.disconnected.any { it == "deepseek" to 42L } }
        waitFor("the reloaded card") { viewModel.state.value.accounts?.accounts?.size == 1 }
        assertEquals(listOf("default"), viewModel.state.value.accounts!!.accounts.map { it.label })
        assertTrue("the card refetches the status after a disconnect", auth.statusCalls.count { it == "deepseek" } >= 2)
    }

    @Test
    fun `a refused disconnect keeps the account and shows the server message`() {
        loaded()
        auth.disconnectError = ApiError.ServerResponse(500, "credential_store", "Could not remove the credential")
        viewModel.refreshAccounts("deepseek")
        waitFor("the account card") { viewModel.state.value.accounts?.accounts?.size == 2 }

        viewModel.disconnectAccount("deepseek", credentialId = 42L)

        waitFor("the error message") {
            val state = viewModel.state.value
            state.messageIsError && !state.message.isNullOrBlank()
        }
        assertEquals(2, viewModel.state.value.accounts?.accounts?.size)
        assertEquals("Could not remove the credential", viewModel.state.value.message)
    }

    // ------------------------------------------------------------ API-key card

    @Test
    fun `api key status reports the configured provider and its guidance`() {
        loaded()

        viewModel.refreshAccounts("deepseek")

        waitFor("the status card") { viewModel.state.value.apiKeyStatus != null }
        val state = viewModel.state.value
        assertFalse(state.accountsLoading)
        assertEquals("DeepSeek", state.apiKeyStatus!!.displayName)
        assertEquals(4, state.apiKeyStatus!!.models)
        assertEquals(ProviderAccounts(supported = true, accounts = state.accounts!!.accounts), state.accounts)
    }

    @Test
    fun `a failing api key status surfaces the error and keeps the draft usable`() {
        loaded()
        auth.statusError = ApiError.Network(java.io.IOException("boom"))

        viewModel.refreshAccounts("deepseek")

        waitFor("the error message") {
            val state = viewModel.state.value
            state.messageIsError && !state.message.isNullOrBlank()
        }
        assertFalse(viewModel.state.value.accountsLoading)
        assertNull(viewModel.state.value.apiKeyStatus)
        assertEquals("Cannot reach the server", viewModel.state.value.message)
        assertTrue(viewModel.state.value.message.orEmpty().isNotBlank())
    }

    // ------------------------------------------------------------- model test

    @Test
    fun `test model reports latency and response for a working model`() {
        loaded()
        viewModel.select(ModelsSelection.Model("custom", 0))

        viewModel.testModel("custom", 0)

        waitFor("the test result") { viewModel.state.value.modelTest.phase == ModelTestPhase.SUCCESS }
        val test = viewModel.state.value.modelTest
        assertEquals(120L, test.latencyMs)
        assertEquals("pong", test.responseText)
        assertEquals("custom:0:local-1", test.key)
        assertEquals(listOf("custom" to "local-1"), api.tested)
    }

    @Test
    fun `a model test failure shows the server's reason`() {
        loaded()
        api.testReply = ModelTestResult(ok = false, error = "The provider answered 401", latencyMs = 40)

        viewModel.testModel("custom", 0)

        waitFor("the failed test") { viewModel.state.value.modelTest.phase == ModelTestPhase.ERROR }
        assertEquals("The provider answered 401", viewModel.state.value.modelTest.message)
        assertEquals(40L, viewModel.state.value.modelTest.latencyMs)
    }

    @Test
    fun `a blank model id never reaches the server`() {
        loaded()
        viewModel.updateModel("custom", 0) { it.copy(id = "") }

        viewModel.testModel("custom", 0)

        waitFor("the validation message") { viewModel.state.value.message != null }
        assertEquals("Model ID is required.", viewModel.state.value.message)
        assertTrue(viewModel.state.value.messageIsError)
        assertTrue("no request for a blank id", api.tested.isEmpty())
        assertEquals(ModelTestPhase.IDLE, viewModel.state.value.modelTest.phase)
    }

    // -------------------------------------------------------- thinking editor

    @Test
    fun `the thinking editor updates the model and marks the file dirty`() {
        loaded()
        assertNull(viewModel.state.value.config.providers["custom"]!!.models[0].thinking)

        // Both editor actions: drop one level, then pin a custom effort on another.
        viewModel.updateModel("custom", 0) {
            it.copy(thinking = withThinkingLevel(it.thinking, "xhigh", included = false, customEffort = null))
        }
        viewModel.updateModel("custom", 0) {
            it.copy(thinking = withThinkingLevel(it.thinking, "high", included = true, customEffort = "8192"))
        }

        val thinking = viewModel.state.value.config.providers["custom"]!!.models[0].thinking
        assertNotNull(thinking)
        assertFalse("xhigh", thinking!!.efforts!!.contains("xhigh"))
        assertTrue("high", thinking.efforts.contains("high"))
        assertEquals("8192", thinking.effortMap!!["high"])
        assertTrue("unsaved edits must survive a reload", viewModel.state.value.dirty)
    }

    // ---------------------------------------------------------- model catalog

    @Test
    fun `catalog search passes the query and base url and adds the picked model`() {
        loaded()
        api.catalogReply = listOf(
            CatalogModel(
                key = "acme/claude-x",
                id = "claude-x",
                name = "Claude X",
                reasoning = true,
                input = listOf("text", "image"),
                contextWindow = 200_000,
                maxTokens = 8_192,
            ),
        )
        viewModel.openCatalog("custom")

        viewModel.setCatalogQuery("claude")

        waitFor("the catalog answer") { viewModel.state.value.catalogResults.size == 1 }
        assertFalse(viewModel.state.value.catalogLoading)
        assertEquals(listOf(Triple("claude", "custom", "http://127.0.0.1:1234/v1")), api.catalogCalls)

        viewModel.addCatalogModel("custom", api.catalogReply.single(), baseUrl = "http://127.0.0.1:1234/v1")

        val state = viewModel.state.value
        val provider = state.config.providers["custom"]!!
        assertEquals(listOf("local-1", "claude-x"), provider.models.map { it.id })
        assertEquals("Claude X", provider.models.last().name)
        assertEquals(200_000, provider.models.last().contextWindow)
        assertNull("the picker closes after adding", state.catalogProvider)
        assertTrue(state.dirty)
        assertEquals("Added claude-x.", state.message)
        assertFalse(state.messageIsError)
    }

    @Test
    fun `a catalog failure keeps the picker open with the reason`() {
        loaded()
        api.catalogError = ApiError.ServerResponse(502, "catalog_unavailable", "models.dev is unreachable")
        viewModel.openCatalog("custom")

        viewModel.setCatalogQuery("gpt")

        waitFor("the catalog error") { viewModel.state.value.catalogError != null }
        assertEquals("models.dev is unreachable", viewModel.state.value.catalogError)
        assertEquals("custom", viewModel.state.value.catalogProvider)
        assertTrue(viewModel.state.value.catalogResults.isEmpty())
    }

    // --------------------------------------------------------------- fixtures

    private class FakeModelsConfigApi : ModelsConfigApi {
        val tested = CopyOnWriteArrayList<Pair<String, String>>()
        val catalogCalls = CopyOnWriteArrayList<Triple<String, String, String>>()
        var testReply = ModelTestResult(ok = true, latencyMs = 120, responseText = "pong")
        var catalogReply: List<CatalogModel> = emptyList()
        var catalogError: Throwable? = null

        private val document = ModelsConfigDocument(
            config = ModelsFileConfig(
                providers = mapOf(
                    "custom" to ProviderConfig(
                        baseUrl = "http://127.0.0.1:1234/v1",
                        api = "openai-completions",
                        models = listOf(ModelConfig(id = "local-1", name = "Local One")),
                    ),
                ),
            ),
            path = "/home/dev/.omp/models.yml",
        )

        override suspend fun loadModelsConfig(): ModelsConfigDocument = document

        override suspend fun saveModelsConfig(
            config: ModelsFileConfig,
            overwriteUnparseable: Boolean,
        ) = error("not used in this test")

        override suspend fun testModel(
            providerName: String,
            provider: ProviderConfig,
            model: ModelConfig,
        ): ModelTestResult {
            tested += providerName to model.id
            return testReply
        }

        override suspend fun catalog(
            query: String,
            provider: String,
            baseUrl: String,
            limit: Int,
        ): List<CatalogModel> {
            catalogCalls += Triple(query, provider, baseUrl)
            catalogError?.let { throw it }
            return catalogReply
        }

        override suspend fun modelRoles(): ModelRolesDocument = ModelRolesDocument()

        override suspend fun saveModelRoles(roles: Map<String, String>): Map<String, String> = roles

        override suspend fun enableProvider(provider: String) = Unit

        override suspend fun runtimeModels(): ModelsResponse = ModelsResponse(
            models = mapOf("custom" to "local-1"),
            modelList = listOf(ModelEntry(id = "local-1", name = "Local One", provider = "custom")),
            connectedProviders = listOf(ConnectedProvider(id = "custom", name = "Custom")),
        )

        override suspend fun ompSettings(): OmpSettingsDocument = OmpSettingsDocument()

        override suspend fun saveOmpSettings(settings: JsonObject): JsonObject = settings
    }

    private class FakeAuthApi : AuthApi {
        val statusCalls = CopyOnWriteArrayList<String>()
        val disconnected = CopyOnWriteArrayList<Pair<String, Long>>()
        var statusError: Throwable? = null
        var disconnectError: Throwable? = null
        var accounts = ProviderAccounts(
            supported = true,
            accounts = listOf(
                ProviderAccount(credentialId = 1L, label = "default", detail = "sk-…abcd", type = "api_key"),
                ProviderAccount(credentialId = 42L, label = "work", detail = "sk-…wxyz", type = "api_key"),
            ),
        )

        override suspend fun oauthProviders(): List<OAuthProvider> = listOf(
            OAuthProvider(id = "anthropic", name = "Anthropic", loggedIn = true),
        )

        override suspend fun apiKeyProviders(): List<ApiKeyProvider> = listOf(
            ApiKeyProvider(id = "deepseek", displayName = "DeepSeek", configured = true, modelCount = 4),
        )

        override suspend fun apiKeyStatus(provider: String): ApiKeyStatus {
            statusCalls += provider
            statusError?.let { throw it }
            return ApiKeyStatus(provider = provider, displayName = "DeepSeek", configured = true, models = 4)
        }

        override suspend fun apiKeyGuidance(provider: String): String? = "Get a key at platform.example"

        override suspend fun accounts(provider: String): ProviderAccounts = accounts

        override suspend fun disconnectAccount(provider: String, credentialId: Long) {
            disconnectError?.let { throw it }
            disconnected += provider to credentialId
            accounts = ProviderAccounts(
                supported = accounts.supported,
                accounts = accounts.accounts.filterNot { it.credentialId == credentialId },
            )
        }

        override suspend fun login(provider: String, onFrame: (OAuthFrame) -> Unit) =
            error("not used in this test")

        override suspend fun submitLogin(provider: String, token: String, value: String) =
            error("not used in this test")
    }
}
