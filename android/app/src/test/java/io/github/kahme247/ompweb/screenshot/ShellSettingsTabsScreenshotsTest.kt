package io.github.kahme247.ompweb.screenshot

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import android.content.Context
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.test.core.app.ApplicationProvider
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.data.SettingsSnapshot
import io.github.kahme247.ompweb.data.SettingsViewPreferences
import io.github.kahme247.ompweb.domain.ModelConfig
import io.github.kahme247.ompweb.domain.ModelsFileConfig
import io.github.kahme247.ompweb.domain.NativeSettingsDocument
import io.github.kahme247.ompweb.domain.ProviderConfig
import io.github.kahme247.ompweb.domain.UpdateKind
import io.github.kahme247.ompweb.domain.UpdateNoticeState
import io.github.kahme247.ompweb.net.ApiKeyProvider
import io.github.kahme247.ompweb.net.ApiKeyStatus
import io.github.kahme247.ompweb.net.AuthApi
import io.github.kahme247.ompweb.net.CatalogModel
import io.github.kahme247.ompweb.net.ConnectedProvider
import io.github.kahme247.ompweb.net.McpApi
import io.github.kahme247.ompweb.net.McpSnapshot
import io.github.kahme247.ompweb.net.ModelEntry
import io.github.kahme247.ompweb.net.ModelRolesDocument
import io.github.kahme247.ompweb.net.ModelTestResult
import io.github.kahme247.ompweb.net.ModelsConfigApi
import io.github.kahme247.ompweb.net.ModelsConfigDocument
import io.github.kahme247.ompweb.net.ModelsResponse
import io.github.kahme247.ompweb.net.NativeSettingsApi
import io.github.kahme247.ompweb.net.NativeSettingsSnapshot
import io.github.kahme247.ompweb.domain.OAuthFrame
import io.github.kahme247.ompweb.net.OAuthProvider
import io.github.kahme247.ompweb.net.OmpSettingsDocument
import io.github.kahme247.ompweb.net.PluginAction
import io.github.kahme247.ompweb.net.PluginResourceCounts
import io.github.kahme247.ompweb.net.PluginsApi
import io.github.kahme247.ompweb.net.PluginsSnapshot
import io.github.kahme247.ompweb.net.ProviderAccounts
import io.github.kahme247.ompweb.net.SkillSearchResult
import io.github.kahme247.ompweb.net.SkillUpdateResult
import io.github.kahme247.ompweb.net.SkillsApi
import io.github.kahme247.ompweb.net.NativeSkillInfo
import io.github.kahme247.ompweb.net.AppUpdateInfo
import io.github.kahme247.ompweb.net.MobileAccessAddress
import io.github.kahme247.ompweb.net.MobileAccessBinding
import io.github.kahme247.ompweb.net.MobileAccessInfo
import io.github.kahme247.ompweb.net.MobileAccessMethod
import io.github.kahme247.ompweb.net.OmpUpdateInfo
import io.github.kahme247.ompweb.net.ProviderUsageSnapshot
import io.github.kahme247.ompweb.net.ReleaseNotes
import io.github.kahme247.ompweb.net.RestartSessionsResult
import io.github.kahme247.ompweb.net.SelfUpdatePrepare
import io.github.kahme247.ompweb.net.SelfUpdateStatus
import io.github.kahme247.ompweb.net.ServerAppInfo
import io.github.kahme247.ompweb.net.SystemApi
import io.github.kahme247.ompweb.net.UsageCostQuality
import io.github.kahme247.ompweb.net.UsageDaySummary
import io.github.kahme247.ompweb.net.UsageGranularity
import io.github.kahme247.ompweb.net.ModelUsageSummary
import io.github.kahme247.ompweb.net.UsageProjectSummary
import io.github.kahme247.ompweb.net.ProviderUsageSummary
import io.github.kahme247.ompweb.net.UsageReport
import io.github.kahme247.ompweb.net.UsageScanInfo
import io.github.kahme247.ompweb.net.UsageSummary
import io.github.kahme247.ompweb.net.UsageTimeRange
import io.github.kahme247.ompweb.net.UsageTimeSeriesPoint
import io.github.kahme247.ompweb.net.WebServerSettings
import io.github.kahme247.ompweb.net.WindowsServiceAction
import io.github.kahme247.ompweb.net.WindowsServiceActionInfo
import io.github.kahme247.ompweb.net.WindowsServiceInfo
import io.github.kahme247.ompweb.ui.notifications.NotificationBatteryState
import io.github.kahme247.ompweb.ui.notifications.NotificationConnectionState
import io.github.kahme247.ompweb.ui.notifications.NotificationPermissionState
import io.github.kahme247.ompweb.ui.notifications.NotificationSettingsActions
import io.github.kahme247.ompweb.ui.notifications.NotificationSettingsMessage
import io.github.kahme247.ompweb.ui.notifications.NotificationSettingsScreen
import io.github.kahme247.ompweb.ui.notifications.NotificationSettingsUiState
import io.github.kahme247.ompweb.ui.settings.ProviderUsagePoller
import io.github.kahme247.ompweb.ui.settings.SettingsViewModel
import io.github.kahme247.ompweb.ui.settings.SystemSettingsTab
import io.github.kahme247.ompweb.ui.settings.UpdateNoticeBanner
import io.github.kahme247.ompweb.ui.settings.UsageSettingsTab
import io.github.kahme247.ompweb.testutil.FakeChatSettings
import io.github.kahme247.ompweb.ui.settings.LocalNativeSettingsDependencies
import io.github.kahme247.ompweb.ui.settings.NativeSettingsDependencies
import io.github.kahme247.ompweb.ui.settings.NativeSettingsViewModel
import io.github.kahme247.ompweb.ui.settings.models.ProvidersModelsTab
import io.github.kahme247.ompweb.ui.settings.models.ProvidersModelsViewModel
import io.github.kahme247.ompweb.domain.NativeCategory
import io.github.kahme247.ompweb.ui.settings.native.NativeSettingsTab
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Test

/**
 * The settings content that does not fit into the category-list capture: one
 * native OMP tab and the providers/models screen (connected providers).
 *
 * Both view models run on `Dispatchers.Main.immediate` and their fakes answer
 * without suspension, so the first snapshot is already the loaded state when
 * the cell is captured.
 */
class ShellSettingsTabsScreenshotsTest : ScreenshotTest() {

    @Test
    fun nativeGeneralTab() {
        // Built outside the composable: lint forbids ViewModel construction
        // inside @Composable code, and the matrix recomposes once per cell.
        val viewModel = NativeSettingsViewModel(
            settingsApi = FakeNativeSettingsApi,
            mcpApi = UnusedMcpApi,
            skillsApi = UnusedSkillsApi,
            pluginsApi = UnusedPluginsApi,
        )
        composeRule.verifyScreenshotMatrix("shell-settings-native") {
            CompositionLocalProvider(
                LocalNativeSettingsDependencies provides NativeSettingsDependencies(
                    viewModel = viewModel,
                ),
            ) {
                NativeSettingsTab(
                    category = NativeCategory.GENERAL,
                    cwd = "/home/dev/projects/ompweb",
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
    }

    @Test
    fun providers() {
        val viewModel = ProvidersModelsViewModel(
            api = FakeModelsConfigApi,
            auth = FakeAuthApi,
            settings = FakeChatSettings(),
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
        )
        composeRule.verifyScreenshotMatrix("shell-settings-providers") {
            ProvidersModelsTab(
                vm = viewModel,
                modifier = Modifier.fillMaxSize(),
            )
        }
    }

    // ── B20 / B31 / B27 / A11: the settings surfaces the report named ────────

    /**
     * B20/T5E: the usage tab with a synthetic report. The tall surface exists
     * so the cell shows the summary, both provider share bars, the chart with
     * the third bar selected and the model breakdown table, not just the
     * controls card.
     */
    @Test
    fun usageTab() {
        val viewModel = systemViewModel()
        viewModel.loadUsage()
        check(viewModel.usageState.value.report != null) { "the fake /api/usage answer must be loaded" }
        viewModel.toggleUsagePoint(2)
        check(viewModel.usageState.value.selectedPointIndex == 2) {
            "the golden captures the third bar as selected"
        }
        check(!viewModel.usageState.value.loading) { "the golden captures the loaded report" }

        composeRule.verifyScreenshotMatrix("shell-settings-usage", heightDp = 1500) {
            UsageSettingsTab(viewModel = viewModel, modifier = Modifier.fillMaxSize())
        }
    }

    /**
     * B31: the Windows service card. The server reports `isWindows=true`; the
     * capture scrolls the page to the card (it sits below the updates and
     * mobile cards) and asserts the "Running on port" fact is on screen before
     * the pixels are taken.
     */
    @Test
    fun systemWindowsTab() {
        val viewModel = systemViewModel()
        viewModel.loadSystem()
        viewModel.checkOmpUpdate()
        check(viewModel.systemState.value.windowsService?.isWindows == true) {
            "the fake server must report Windows"
        }
        val windowsStatus = ApplicationProvider.getApplicationContext<Context>()
            .getString(R.string.system_windows_running, 30177)

        composeRule.verifyScreenshotMatrix(
            "shell-settings-system-windows",
            heightDp = 1200,
            // The card scrolls itself into view; fail loudly if a cell would
            // capture a frame without it instead of comparing a wrong golden.
            interact = {
                composeRule.onAllNodes(hasScrollAction())[0]
                    .performScrollToNode(hasText(windowsStatus))
                composeRule.onNodeWithText(windowsStatus, useUnmergedTree = true).assertIsDisplayed()
            },
        ) {
            SystemSettingsTab(
                viewModel = viewModel,
                onSignOut = {},
                onChangeServer = {},
                modifier = Modifier.fillMaxSize(),
                highlight = "windows-service-autostart",
            )
        }
    }

    /**
     * B27: the notifications settings surface with the "Send test" button and
     * the answer it shows after a test notification was sent.
     */
    @Test
    fun notificationSettingsTab() {
        val sendTest = ApplicationProvider.getApplicationContext<Context>()
            .getString(R.string.notify_ui_send_test)
        composeRule.verifyScreenshotMatrix(
            "shell-settings-notifications",
            heightDp = 1500,
            // B27: the cell must show the "Send test" button, not just the toggles.
            interact = {
                composeRule.onNodeWithText(sendTest).performScrollTo().assertIsDisplayed()
            },
        ) {
            NotificationSettingsScreen(
                state = NotificationState,
                actions = NoopNotificationActions,
                modifier = Modifier.fillMaxSize(),
            )
        }
    }

    /** A11: the shell banner for an omp-web update with self-update support. */
    @Test
    fun updateBanner() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val bannerTitle = context.getString(R.string.update_banner_app_title)
        // The version is the news: the summary leads with it, so every cell
        // (320 dp/100 % included) must carry it (see UpdateNoticeBannerTest for
        // the rendered-clipping check).
        val bannerVersion = context.getString(R.string.update_banner_version, "0.5.2", "0.6.0")
        composeRule.verifyScreenshotMatrix(
            "shell-update-banner",
            heightDp = 260,
            interact = {
                composeRule.onNodeWithText(bannerVersion, substring = true).assertIsDisplayed()
                composeRule.onNodeWithText(bannerTitle, substring = true).assertIsDisplayed()
            },
        ) {
            Column(Modifier.fillMaxSize().padding(16.dp)) {
                UpdateNoticeBanner(
                    state = UpdateNoticeState(
                        kind = UpdateKind.APP,
                        currentVersion = "0.5.2",
                        availableVersion = "0.6.0",
                    ),
                    onOpenSettings = {},
                    onDismiss = {},
                )
            }
        }
    }

    /** Both settings tabs read `Dispatchers.Main.immediate`; the fakes answer inline. */
    private fun systemViewModel() = SettingsViewModel(
        system = FakeSystemApi,
        settings = FakeViewPreferences(),
        poller = ProviderUsagePoller(
            load = { ProviderUsageSnapshot(generatedAt = null, reports = emptyList()) },
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
        ),
    )

    private companion object {

        val NotificationState = NotificationSettingsUiState(
            enabled = true,
            permission = NotificationPermissionState.GRANTED,
            battery = NotificationBatteryState.NOT_EXEMPT,
            connection = NotificationConnectionState.CONNECTED,
            connectionDetail = "2 agents running",
            message = NotificationSettingsMessage(text = "Test notification sent"),
        )

        val NoopNotificationActions = NotificationSettingsActions(
            setEnabled = {},
            setType = { _, _ -> },
            setWhenActive = {},
            setVibrate = {},
            sendTest = {},
            requestPermission = {},
            openNotificationSettings = {},
            requestBatteryExemption = {},
            dismissMessage = {},
        )

        /** B20's synthetic report: every card has data to render. */
        val UsageReportFixture = UsageReport(
            timeRange = "30d",
            granularity = "daily",
            summary = UsageSummary(
                totalCost = 12.34,
                totalTokens = 1_234_567,
                inputTokens = 800_000,
                outputTokens = 300_000,
                reasoningTokens = 34_567,
                cacheReadTokens = 456_789,
                cacheWriteTokens = 12_000,
                cacheSavings = 2.5,
                activeDays = 12,
                tokensPerActiveDay = 102_880,
                cachePercentage = 37.0,
                costQuality = UsageCostQuality(providerReported = 100.0, modelPriced = 80.0, unpriced = 3.2),
            ),
            providers = listOf(
                ProviderUsageSummary(
                    provider = "anthropic",
                    name = "Anthropic",
                    cost = 7.5,
                    tokens = 750_000,
                    share = 60.8,
                    color = "#d97757",
                ),
                ProviderUsageSummary(
                    provider = "deepseek",
                    name = "DeepSeek",
                    cost = 4.84,
                    tokens = 484_567,
                    share = 39.2,
                    color = "#4d6bfe",
                ),
            ),
            timeSeries = listOf(
                UsageTimeSeriesPoint(date = "2026-10-01", label = "Oct 1", totalCost = 1.1, totalTokens = 90_000),
                UsageTimeSeriesPoint(date = "2026-10-02", label = "Oct 2", totalCost = 2.4, totalTokens = 210_000),
                UsageTimeSeriesPoint(date = "2026-10-03", label = "Oct 3", totalCost = 0.6, totalTokens = 55_000),
                UsageTimeSeriesPoint(date = "2026-10-04", label = "Oct 4", totalCost = 3.2, totalTokens = 320_000),
                UsageTimeSeriesPoint(date = "2026-10-05", label = "Oct 5", totalCost = 1.8, totalTokens = 160_000),
                UsageTimeSeriesPoint(date = "2026-10-06", label = "Oct 6", totalCost = 3.24, totalTokens = 399_567),
            ),
            modelBreakdown = listOf(
                ModelUsageSummary(
                    model = "claude-sonnet",
                    provider = "anthropic",
                    cost = 7.5,
                    tokens = 750_000,
                    share = 60.8,
                    recordsCount = 42,
                ),
                ModelUsageSummary(
                    model = "deepseek-chat",
                    provider = "deepseek",
                    cost = 4.84,
                    tokens = 484_567,
                    share = 39.2,
                    recordsCount = 31,
                ),
            ),
            dayBreakdown = listOf(
                UsageDaySummary(date = "2026-10-04", label = "Oct 4", cost = 3.2, tokens = 320_000, share = 26.0),
                UsageDaySummary(date = "2026-10-06", label = "Oct 6", cost = 3.24, tokens = 399_567, share = 26.2),
            ),
            projectBreakdown = listOf(
                UsageProjectSummary(
                    project = "/home/dev/projects/ompweb",
                    projectName = "ompweb",
                    cost = 9.0,
                    tokens = 900_000,
                    share = 72.9,
                    sessionsCount = 8,
                ),
                UsageProjectSummary(
                    project = "/home/dev/projects/android",
                    projectName = "ompwebandroid",
                    cost = 3.34,
                    tokens = 334_567,
                    share = 27.1,
                    sessionsCount = 3,
                ),
            ),
            scanInfo = UsageScanInfo(
                transcriptsScanned = 37,
                transcriptsOutsideWindow = 2,
                usageRecordsCount = 512,
                durationSeconds = 1.4,
            ),
        )

        val WindowsServiceFixture = WindowsServiceInfo(
            isWindows = true,
            isInstalled = true,
            autostart = false,
            isRunning = true,
            port = 30177,
            hostname = "localhost",
            mode = "service",
            desktopShortcutExists = true,
            serviceUrl = "http://127.0.0.1:30177",
            version = "1.2.3",
        )

        /** Every System-tab card has data; nothing here suspends. */
        val FakeSystemApi = object : SystemApi {
            override suspend fun appInfo(): ServerAppInfo =
                ServerAppInfo(name = "ompweb", version = "0.5.2", api = 2)

            override suspend fun appUpdate(force: Boolean): AppUpdateInfo = AppUpdateInfo(
                currentVersion = "0.5.2",
                availableVersion = "0.6.0",
                updateAvailable = true,
                updateCommand = "npm install -g ompweb",
                updatesDisabled = false,
                selfUpdateSupported = true,
            )

            override suspend fun appUpdateNotes(): ReleaseNotes? = null

            override suspend fun appUpdatePrepare(): SelfUpdatePrepare =
                error("not used in the screenshot")

            override suspend fun appUpdateCommit(attemptId: String) =
                error("not used in the screenshot")

            override suspend fun appUpdateStatus(): SelfUpdateStatus? = null

            override suspend fun acknowledgeAppUpdate(attemptId: String) = Unit

            override suspend fun ompUpdateCheck(force: Boolean): OmpUpdateInfo = OmpUpdateInfo(
                currentVersion = "18.12.4",
                availableVersion = "18.13.0",
                updateAvailable = true,
                updateCommand = "omp update",
                updatesDisabled = false,
            )

            override suspend fun ompUpdatePrepare(): SelfUpdatePrepare =
                error("not used in the screenshot")

            override suspend fun ompUpdateCommit(attemptId: String) =
                error("not used in the screenshot")

            override suspend fun ompUpdateStatus(): SelfUpdateStatus? = null

            override suspend fun acknowledgeOmpUpdate(attemptId: String) = Unit

            override suspend fun restartSessions(): RestartSessionsResult = RestartSessionsResult(sessionsRestarted = 0)

            override suspend fun webSettings(): WebServerSettings = WebServerSettings(
                autoResumeSessions = true,
                agentEnv = mapOf("OMP_WORKSPACE" to "/home/dev/projects/ompweb"),
            )

            override suspend fun saveWebSettings(
                autoResumeSessions: Boolean,
                agentEnv: String?,
            ): WebServerSettings = error("not used in the screenshot")

            override suspend fun mobileAccess(): MobileAccessInfo = MobileAccessInfo(
                binding = MobileAccessBinding(hostname = "example-host", exposure = "tailnet", port = 30177),
                passwordConfigured = true,
                passwordProblem = false,
                addresses = listOf(
                    MobileAccessAddress(url = "http://100.64.0.10:30177", label = "Tailscale"),
                ),
                methods = listOf(
                    MobileAccessMethod(id = "pair", commands = listOf("ompweb pair --qr")),
                ),
            )

            override suspend fun windowsService(): WindowsServiceInfo = WindowsServiceFixture

            override suspend fun windowsAction(
                action: WindowsServiceAction,
                cleanConfig: Boolean,
            ): WindowsServiceActionInfo = error("not used in the screenshot")

            override suspend fun usage(
                range: UsageTimeRange,
                granularity: UsageGranularity,
                refresh: Boolean,
            ): UsageReport = UsageReportFixture

            override suspend fun providerUsage(refresh: Boolean): ProviderUsageSnapshot =
                ProviderUsageSnapshot(generatedAt = null, reports = emptyList())
        }

        class FakeViewPreferences : SettingsViewPreferences {
            private val state = kotlinx.coroutines.flow.MutableStateFlow(SettingsSnapshot(loaded = true))
            override val snapshot: kotlinx.coroutines.flow.StateFlow<SettingsSnapshot> = state

            override suspend fun setDismissedUpdate(kind: UpdateKind, version: String?) = Unit

            override suspend fun setCompletedAppUpdate(version: String?) = Unit

            override suspend fun setDictationEngine(wire: String) = Unit

            override suspend fun setDictationLanguage(tag: String?) = Unit
        }

        val FakeNativeSettingsApi = object : NativeSettingsApi {
            private val snapshot = NativeSettingsSnapshot(
                path = "/home/dev/.omp/config.yml",
                document = NativeSettingsDocument(
                    buildJsonObject {
                        put("skills", buildJsonObject { put("showStartupDiagnostics", true) })
                    },
                ),
            )

            override suspend fun load(): NativeSettingsSnapshot = snapshot

            override suspend fun save(document: NativeSettingsDocument): NativeSettingsSnapshot = snapshot
        }

        val FakeAuthApi = object : AuthApi {
            override suspend fun oauthProviders(): List<OAuthProvider> = listOf(
                OAuthProvider(id = "anthropic", name = "Anthropic", loggedIn = true),
                OAuthProvider(id = "openai", name = "OpenAI"),
            )

            override suspend fun apiKeyProviders(): List<ApiKeyProvider> = listOf(
                ApiKeyProvider(id = "deepseek", displayName = "DeepSeek", configured = true, modelCount = 4),
                ApiKeyProvider(id = "groq", displayName = "Groq", modelCount = 2),
            )

            override suspend fun apiKeyStatus(provider: String): ApiKeyStatus =
                ApiKeyStatus(provider = provider)

            override suspend fun apiKeyGuidance(provider: String): String? = null

            override suspend fun accounts(provider: String): ProviderAccounts = ProviderAccounts()

            override suspend fun disconnectAccount(provider: String, credentialId: Long) = Unit

            override suspend fun login(provider: String, onFrame: (OAuthFrame) -> Unit) =
                error("not used in the screenshot")

            override suspend fun submitLogin(provider: String, token: String, value: String) =
                error("not used in the screenshot")
        }

        val FakeModelsConfigApi = object : ModelsConfigApi {
            override suspend fun loadModelsConfig(): ModelsConfigDocument = ModelsConfigDocument(
                config = ModelsFileConfig(),
                path = "/home/dev/.omp/models.yml",
            )

            override suspend fun saveModelsConfig(config: ModelsFileConfig, overwriteUnparseable: Boolean) =
                error("not used in the screenshot")

            override suspend fun testModel(
                providerName: String,
                provider: ProviderConfig,
                model: ModelConfig,
            ): ModelTestResult = ModelTestResult(ok = true)

            override suspend fun catalog(query: String, provider: String, baseUrl: String, limit: Int): List<CatalogModel> =
                emptyList()

            override suspend fun modelRoles(): ModelRolesDocument = ModelRolesDocument()

            override suspend fun saveModelRoles(roles: Map<String, String>): Map<String, String> = roles

            override suspend fun enableProvider(provider: String) = Unit

            override suspend fun runtimeModels(): ModelsResponse = ModelsResponse(
                models = mapOf("anthropic" to "claude-sonnet", "deepseek" to "deepseek-chat"),
                modelList = listOf(
                    ModelEntry(id = "claude-sonnet", name = "Claude Sonnet", provider = "anthropic"),
                    ModelEntry(id = "deepseek-chat", name = "DeepSeek Chat", provider = "deepseek"),
                ),
                connectedProviders = listOf(
                    ConnectedProvider(id = "anthropic", name = "Anthropic"),
                    ConnectedProvider(id = "deepseek", name = "DeepSeek", disabled = true),
                ),
            )

            override suspend fun ompSettings(): OmpSettingsDocument = OmpSettingsDocument()

            override suspend fun saveOmpSettings(settings: JsonObject): JsonObject = settings
        }

        object UnusedMcpApi : McpApi {
            override suspend fun load(
                cwd: String?,
                sessionId: String?,
                live: Boolean,
                advisor: Boolean,
            ): McpSnapshot = McpSnapshot(
                servers = emptyList(),
                user = null,
                inventory = emptyList(),
                liveServers = null,
                liveError = null,
                path = null,
            )

            override suspend fun validate(name: String, server: JsonObject): String = "valid"

            override suspend fun save(cwd: String, name: String, previousName: String?, server: JsonObject) = Unit

            override suspend fun remove(cwd: String, name: String) = Unit
        }

        object UnusedSkillsApi : SkillsApi {
            override suspend fun list(cwd: String): List<NativeSkillInfo> = emptyList()

            override suspend fun setModelInvocationDisabled(filePath: String, disabled: Boolean, cwd: String?): Boolean =
                disabled

            override suspend fun search(query: String, limit: Int): List<SkillSearchResult> = emptyList()

            override suspend fun install(packageName: String, scope: String, cwd: String?) = Unit

            override suspend fun checkUpdates(
                cwd: String,
                packageName: String?,
                scope: String?,
            ): List<SkillUpdateResult> = emptyList()

            override suspend fun update(cwd: String, packageName: String, scope: String) = Unit
        }

        object UnusedPluginsApi : PluginsApi {
            override suspend fun load(cwd: String): PluginsSnapshot = PluginsSnapshot(
                packages = emptyList(),
                totals = PluginResourceCounts(),
                diagnostics = emptyList(),
            )

            override suspend fun action(
                action: PluginAction,
                source: String?,
                scope: String,
                cwd: String,
            ): PluginsSnapshot = PluginsSnapshot(
                packages = emptyList(),
                totals = PluginResourceCounts(),
                diagnostics = emptyList(),
            )

            override suspend fun reload(sessionId: String) = Unit
        }    }
}
