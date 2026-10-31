package io.github.kahme247.ompweb.net

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * `/api/app-info`, `/api/app-update`, `/api/omp-update`, `/api/web-settings`,
 * `/api/mobile-access`, `/api/windows-service`, `/api/usage` and
 * `/api/provider-usage`: the server-side surface of Settings → System &
 * Updates and the two usage views.
 *
 * Interfaces so the settings view model runs in JVM tests; the HTTP
 * implementation reuses the app's one authenticated client.
 */
interface SystemApi {

    suspend fun appInfo(): ServerAppInfo

    suspend fun appUpdate(force: Boolean = false): AppUpdateInfo

    /** `GET /api/app-update/notes`; `null` when the server has no notes (204). */
    suspend fun appUpdateNotes(): ReleaseNotes?

    /** `POST /api/app-update {action:"prepare"}`, 202 `{attemptId, targetVersion}`. */
    suspend fun appUpdatePrepare(): SelfUpdatePrepare

    /** `POST /api/app-update {action:"commit", attemptId}` (replaying an attempt is accepted). */
    suspend fun appUpdateCommit(attemptId: String)

    /** `POST /api/app-update {action:"status"}`; `null` until an attempt exists. */
    suspend fun appUpdateStatus(): SelfUpdateStatus?

    suspend fun acknowledgeAppUpdate(attemptId: String)

    suspend fun ompUpdateCheck(force: Boolean = false): OmpUpdateInfo

    /** `POST /api/omp-update {action:"update"}`, 202 `{attemptId, targetVersion}`. */
    suspend fun ompUpdatePrepare(): SelfUpdatePrepare

    suspend fun ompUpdateCommit(attemptId: String)

    suspend fun ompUpdateStatus(): SelfUpdateStatus?

    suspend fun acknowledgeOmpUpdate(attemptId: String)

    /** `POST {action:"restart"}` — restarts every live RPC session. */
    suspend fun restartSessions(): RestartSessionsResult

    suspend fun webSettings(): WebServerSettings

    /**
     * `PUT /api/web-settings`. The route only updates keys that are present,
     * so a null [agentEnv] leaves the stored variables untouched.
     */
    suspend fun saveWebSettings(
        autoResumeSessions: Boolean,
        agentEnv: String? = null,
    ): WebServerSettings

    suspend fun mobileAccess(): MobileAccessInfo

    suspend fun windowsService(): WindowsServiceInfo

    suspend fun windowsAction(action: WindowsServiceAction, cleanConfig: Boolean = false): WindowsServiceActionInfo

    suspend fun usage(
        range: UsageTimeRange,
        granularity: UsageGranularity,
        refresh: Boolean = false,
    ): UsageReport

    suspend fun providerUsage(refresh: Boolean = false): ProviderUsageSnapshot
}

data class ServerAppInfo(
    val name: String,
    val version: String,
    val api: Int,
)

/** `NpmUpdateStatus` + the self-update support flag. */
data class AppUpdateInfo(
    val currentVersion: String?,
    val availableVersion: String?,
    val updateAvailable: Boolean,
    val updateCommand: String,
    val updatesDisabled: Boolean,
    /** The server can install this package itself (`selfUpdateSupported`). */
    val selfUpdateSupported: Boolean = false,
)

/**
 * `SelfUpdateStatus` (`lib/self-update.ts`): the server-side install attempt.
 * `state` is `prepared|running|succeeded|failed`; `stage` refines a running
 * attempt. Only the fields the card and poll use are kept.
 */
data class SelfUpdateStatus(
    val attemptId: String,
    val state: String,
    val stage: String? = null,
    val targetVersion: String = "",
    val error: String? = null,
)

/** 202 answer of `prepare`/`update`: the attempt the client must commit. */
data class SelfUpdatePrepare(val attemptId: String, val targetVersion: String)

/** `GET /api/app-update/notes` (`GitHubReleaseNotes`); only github.com links are sent. */
data class ReleaseNotes(
    val version: String,
    val body: String,
    val htmlUrl: String,
)

/** `OmpUpdateStatus` from `POST /api/omp-update {action:"check"}`. */
data class OmpUpdateInfo(
    val currentVersion: String?,
    val availableVersion: String?,
    val updateAvailable: Boolean,
    val updateCommand: String,
    val updatesDisabled: Boolean,
)

data class RestartSessionsResult(val sessionsRestarted: Int)

data class WebServerSettings(
    val autoResumeSessions: Boolean,
    val agentEnv: Map<String, String>,
)

data class MobileAccessBinding(val hostname: String?, val exposure: String, val port: Int)

data class MobileAccessAddress(val url: String, val label: String)

data class MobileAccessMethod(val id: String, val commands: List<String>)

data class MobileAccessInfo(
    val binding: MobileAccessBinding,
    val passwordConfigured: Boolean,
    val passwordProblem: Boolean,
    val addresses: List<MobileAccessAddress>,
    val methods: List<MobileAccessMethod>,
)

data class WindowsServiceInfo(
    val isWindows: Boolean,
    val isInstalled: Boolean,
    val autostart: Boolean,
    val isRunning: Boolean,
    val port: Int?,
    val hostname: String?,
    val mode: String?,
    val desktopShortcutExists: Boolean,
    val serviceUrl: String?,
    val version: String?,
)

enum class WindowsServiceAction(val wire: String) {
    INSTALL("install"),
    UNINSTALL("uninstall"),
    TOGGLE_AUTOSTART("toggle-autostart"),
    START("start"),
    STOP("stop"),
    RESTART("restart"),
}

data class WindowsServiceActionInfo(
    val success: Boolean,
    val message: String?,
    val status: WindowsServiceInfo?,
)

// ------------------------------------------------------------------ usage

enum class UsageTimeRange(val wire: String) {
    TODAY("today"),
    SEVEN_DAYS("7d"),
    THIRTY_DAYS("30d"),
    NINETY_DAYS("90d"),
    MONTH("month"),
    ALL("all"),
}

enum class UsageGranularity(val wire: String) {
    DAILY("daily"),
    MONTHLY("monthly"),
    PROJECTS("projects"),
}

data class UsageCostQuality(
    val providerReported: Double,
    val modelPriced: Double,
    val unpriced: Double,
)

data class UsageSummary(
    val totalCost: Double,
    val totalTokens: Long,
    val inputTokens: Long,
    val outputTokens: Long,
    val reasoningTokens: Long,
    val cacheReadTokens: Long,
    val cacheWriteTokens: Long,
    val cacheSavings: Double,
    val activeDays: Int,
    val tokensPerActiveDay: Long,
    val cachePercentage: Double,
    val costQuality: UsageCostQuality,
)

data class ProviderUsageSummary(
    val provider: String,
    val name: String,
    val cost: Double,
    val tokens: Long,
    val share: Double,
    val color: String,
)

data class ModelUsageSummary(
    val model: String,
    val provider: String,
    val cost: Double,
    val tokens: Long,
    val share: Double,
    val recordsCount: Int,
)

data class UsageTimeSeriesPoint(
    val date: String,
    val label: String,
    val totalCost: Double,
    val totalTokens: Long,
)

data class UsageDaySummary(
    val date: String,
    val label: String,
    val cost: Double,
    val tokens: Long,
    val share: Double,
)

data class UsageProjectSummary(
    val project: String,
    val projectName: String,
    val cost: Double,
    val tokens: Long,
    val share: Double,
    val sessionsCount: Int,
)

data class UsageScanInfo(
    val transcriptsScanned: Int,
    val transcriptsOutsideWindow: Int,
    val usageRecordsCount: Int,
    val durationSeconds: Double,
)

data class UsageReport(
    val timeRange: String,
    val granularity: String,
    val summary: UsageSummary,
    val providers: List<ProviderUsageSummary>,
    val timeSeries: List<UsageTimeSeriesPoint>,
    val modelBreakdown: List<ModelUsageSummary>,
    val dayBreakdown: List<UsageDaySummary>,
    val projectBreakdown: List<UsageProjectSummary>,
    val scanInfo: UsageScanInfo,
)

data class ProviderUsageWindow(
    val percent: Double,
    val resetMinutes: Int? = null,
    val resetHours: Int? = null,
)

data class ProviderUsageReport(
    val provider: String,
    val accountLabel: String? = null,
    val accountIndex: Int? = null,
    val plan: String? = null,
    val modelId: String? = null,
    val tier: String? = null,
    val noLimits: Boolean = false,
    val fiveHour: ProviderUsageWindow? = null,
    val sevenDay: ProviderUsageWindow? = null,
    val monthly: ProviderUsageWindow? = null,
)

data class ProviderUsageSnapshot(
    val generatedAt: Long?,
    val reports: List<ProviderUsageReport>,
)

/** Production [SystemApi] over the app's authenticated client. */
fun ApiClient.systemApi(): SystemApi = HttpSystemApi(this)

private class HttpSystemApi(private val api: ApiClient) : SystemApi {

    override suspend fun appInfo(): ServerAppInfo {
        val root = getObject("api/app-info")
        return ServerAppInfo(
            name = root.string("name") ?: "ompweb",
            version = root.string("version") ?: "unknown",
            api = root.int("api") ?: 0,
        )
    }

    override suspend fun appUpdate(force: Boolean): AppUpdateInfo {
        val root = getObject("api/app-update" + if (force) "?force=1" else "")
        return AppUpdateInfo(
            currentVersion = root.string("currentVersion"),
            availableVersion = root.string("availableVersion"),
            updateAvailable = root.boolean("updateAvailable") ?: false,
            updateCommand = root.string("updateCommand") ?: "ompweb update",
            updatesDisabled = root.boolean("updatesDisabled") ?: false,
            selfUpdateSupported = root.boolean("selfUpdateSupported") ?: false,
        )
    }

    override suspend fun appUpdateNotes(): ReleaseNotes? {
        val text = send(api.requestBuilder("api/app-update/notes").get().build())
        if (text.isBlank()) return null // 204: no notes for the pending version.
        val root = parseObjectOrNull(text) ?: return null
        val version = root.string("version") ?: return null
        val body = root.string("body") ?: return null
        val url = root.string("htmlUrl") ?: return null
        return ReleaseNotes(version = version, body = body, htmlUrl = url)
    }

    override suspend fun appUpdatePrepare(): SelfUpdatePrepare =
        parsePrepare(postObject("api/app-update", action("prepare")))

    override suspend fun appUpdateCommit(attemptId: String) {
        postObject("api/app-update", commitPayload(attemptId))
    }

    override suspend fun appUpdateStatus(): SelfUpdateStatus? =
        (postElementOrNull("api/app-update", action("status")) as? JsonObject)?.let(::parseSelfUpdate)

    override suspend fun acknowledgeAppUpdate(attemptId: String) {
        postObject("api/app-update", acknowledgePayload(attemptId))
    }

    override suspend fun ompUpdatePrepare(): SelfUpdatePrepare =
        parsePrepare(postObject("api/omp-update", action("update")))

    override suspend fun ompUpdateCommit(attemptId: String) {
        postObject("api/omp-update", commitPayload(attemptId))
    }

    override suspend fun ompUpdateStatus(): SelfUpdateStatus? =
        (postElementOrNull("api/omp-update", action("status")) as? JsonObject)?.let(::parseSelfUpdate)

    override suspend fun acknowledgeOmpUpdate(attemptId: String) {
        postObject("api/omp-update", acknowledgePayload(attemptId))
    }

    override suspend fun ompUpdateCheck(force: Boolean): OmpUpdateInfo {
        val payload = buildJsonObject {
            put("action", "check")
            if (force) put("force", true)
        }.toString()
        val root = postObject("api/omp-update", payload)
        return OmpUpdateInfo(
            currentVersion = root.string("currentVersion"),
            availableVersion = root.string("availableVersion"),
            updateAvailable = root.boolean("updateAvailable") ?: false,
            updateCommand = root.string("updateCommand") ?: "omp update",
            updatesDisabled = root.boolean("updatesDisabled") ?: false,
        )
    }

    override suspend fun restartSessions(): RestartSessionsResult {
        val root = postObject("api/omp-update", buildJsonObject { put("action", "restart") }.toString())
        return RestartSessionsResult(root.int("sessionsRestarted") ?: 0)
    }

    override suspend fun webSettings(): WebServerSettings =
        parseWebSettings(getObject("api/web-settings"))

    override suspend fun saveWebSettings(
        autoResumeSessions: Boolean,
        agentEnv: String?,
    ): WebServerSettings {
        val payload = buildJsonObject {
            put("autoResumeSessions", autoResumeSessions)
            if (agentEnv != null) put("agentEnv", agentEnv)
        }.toString()
        val request = api.requestBuilder("api/web-settings")
            .put(payload.toRequestBody(JSON_MEDIA_TYPE))
            .build()
        return parseWebSettings(parseObject(send(request)))
    }

    override suspend fun mobileAccess(): MobileAccessInfo {
        val root = getObject("api/mobile-access")
        val binding = root["binding"] as? JsonObject ?: JsonObject(emptyMap())
        val password = root["password"] as? JsonObject ?: JsonObject(emptyMap())
        return MobileAccessInfo(
            binding = MobileAccessBinding(
                hostname = binding.string("hostname"),
                exposure = binding.string("exposure") ?: "unknown",
                port = binding.int("port") ?: 0,
            ),
            passwordConfigured = password.boolean("configured") ?: false,
            passwordProblem = password.boolean("problem") ?: false,
            addresses = root.array("addresses").mapNotNull { element ->
                val entry = element as? JsonObject ?: return@mapNotNull null
                val url = entry.string("url") ?: return@mapNotNull null
                MobileAccessAddress(url, entry.string("label") ?: "lan")
            },
            methods = root.array("methods").mapNotNull { element ->
                val entry = element as? JsonObject ?: return@mapNotNull null
                val id = entry.string("id") ?: return@mapNotNull null
                MobileAccessMethod(id, entry.array("commands").mapNotNull { it.stringValue() })
            },
        )
    }

    override suspend fun windowsService(): WindowsServiceInfo = parseWindows(getObject("api/windows-service"))

    override suspend fun windowsAction(
        action: WindowsServiceAction,
        cleanConfig: Boolean,
    ): WindowsServiceActionInfo {
        val payload = buildJsonObject {
            put("action", action.wire)
            if (action == WindowsServiceAction.UNINSTALL && cleanConfig) put("cleanConfig", true)
        }.toString()
        val root = postObject("api/windows-service", payload)
        val status = root["status"] as? JsonObject
        return WindowsServiceActionInfo(
            success = root.boolean("success") ?: false,
            message = root.string("message"),
            status = status?.let(::parseWindows),
        )
    }

    override suspend fun usage(
        range: UsageTimeRange,
        granularity: UsageGranularity,
        refresh: Boolean,
    ): UsageReport {
        val query = buildString {
            append("api/usage?range=").append(range.wire)
            append("&granularity=").append(granularity.wire)
            if (refresh) append("&refresh=true")
        }
        return parseUsage(getObject(query))
    }

    override suspend fun providerUsage(refresh: Boolean): ProviderUsageSnapshot {
        val root = getObject("api/provider-usage" + if (refresh) "?refresh=true" else "")
        return ProviderUsageSnapshot(
            generatedAt = root.long("generatedAt"),
            reports = root.array("reports").mapNotNull { element ->
                val item = element as? JsonObject ?: return@mapNotNull null
                ProviderUsageReport(
                    provider = item.string("provider") ?: return@mapNotNull null,
                    accountLabel = item.string("accountLabel"),
                    accountIndex = item.int("accountIndex"),
                    plan = item.string("plan"),
                    modelId = item.string("modelId"),
                    tier = item.string("tier"),
                    noLimits = item.boolean("noLimits") ?: false,
                    fiveHour = window(item["fiveHour"]),
                    sevenDay = window(item["sevenDay"]),
                    monthly = window(item["monthly"]),
                )
            },
        )
    }

    // ------------------------------------------------------------ transport

    private suspend fun getObject(path: String): JsonObject =
        parseObject(send(api.requestBuilder(path).get().build()))

    private suspend fun postObject(path: String, payload: String): JsonObject {
        val request = api.requestBuilder(path)
            .post(payload.toRequestBody(JSON_MEDIA_TYPE))
            .build()
        return parseObject(send(request))
    }

    private suspend fun send(request: Request): String {
        val response = api.exchange(request)
        val text = response.text()
        if (response.status in 200..299) return text
        throw when (response.status) {
            401, 403 -> api.errorFor(
                response.status,
                text,
                ServerAddress(request.url.scheme, request.url.host, request.url.port),
            )
            else -> {
                val body = parseObjectOrNull(text)
                ApiError.ServerResponse(
                    status = response.status,
                    code = body?.string("code"),
                    serverMessage = body?.string("error"),
                )
            }
        }
    }

    private fun parseWebSettings(root: JsonObject): WebServerSettings = WebServerSettings(
        autoResumeSessions = root.boolean("autoResumeSessions") ?: false,
        agentEnv = (root["agentEnv"] as? JsonObject)
            ?.mapNotNull { (key, value) -> (value as? JsonPrimitive)?.contentOrNull?.let { key to it } }
            ?.toMap()
            ?: emptyMap(),
    )

    private fun parseWindows(root: JsonObject): WindowsServiceInfo = WindowsServiceInfo(
        isWindows = root.boolean("isWindows") ?: false,
        isInstalled = root.boolean("isInstalled") ?: false,
        autostart = root.boolean("autostart") ?: false,
        isRunning = root.boolean("isRunning") ?: false,
        port = root.int("port"),
        hostname = root.string("hostname"),
        mode = root.string("mode"),
        desktopShortcutExists = root.boolean("desktopShortcutExists") ?: false,
        serviceUrl = root.string("serviceUrl"),
        version = root.string("version"),
    )

    private fun parseUsage(root: JsonObject): UsageReport {
        val summary = root["summary"] as? JsonObject ?: JsonObject(emptyMap())
        val quality = summary["costQuality"] as? JsonObject ?: JsonObject(emptyMap())
        val scan = root["scanInfo"] as? JsonObject ?: JsonObject(emptyMap())
        return UsageReport(
            timeRange = root.string("timeRange") ?: "",
            granularity = root.string("granularity") ?: "",
            summary = UsageSummary(
                totalCost = summary.double("totalCost") ?: 0.0,
                totalTokens = summary.long("totalTokens") ?: 0,
                inputTokens = summary.long("inputTokens") ?: 0,
                outputTokens = summary.long("outputTokens") ?: 0,
                reasoningTokens = summary.long("reasoningTokens") ?: 0,
                cacheReadTokens = summary.long("cacheReadTokens") ?: 0,
                cacheWriteTokens = summary.long("cacheWriteTokens") ?: 0,
                cacheSavings = summary.double("cacheSavings") ?: 0.0,
                activeDays = summary.int("activeDays") ?: 0,
                tokensPerActiveDay = summary.long("tokensPerActiveDay") ?: 0,
                cachePercentage = summary.double("cachePercentage") ?: 0.0,
                costQuality = UsageCostQuality(
                    providerReported = quality.double("providerReported") ?: 0.0,
                    modelPriced = quality.double("modelPriced") ?: 0.0,
                    unpriced = quality.double("unpriced") ?: 0.0,
                ),
            ),
            providers = root.array("providers").mapNotNull { element ->
                val item = element as? JsonObject ?: return@mapNotNull null
                ProviderUsageSummary(
                    provider = item.string("provider") ?: return@mapNotNull null,
                    name = item.string("name") ?: item.string("provider") ?: return@mapNotNull null,
                    cost = item.double("cost") ?: 0.0,
                    tokens = item.long("tokens") ?: 0,
                    share = item.double("share") ?: 0.0,
                    color = item.string("color") ?: "",
                )
            },
            timeSeries = root.array("timeSeries").mapNotNull { element ->
                val item = element as? JsonObject ?: return@mapNotNull null
                UsageTimeSeriesPoint(
                    date = item.string("date") ?: "",
                    label = item.string("label") ?: item.string("date") ?: "",
                    totalCost = item.double("totalCost") ?: 0.0,
                    totalTokens = item.long("totalTokens") ?: 0,
                )
            },
            modelBreakdown = root.array("modelBreakdown").mapNotNull { element ->
                val item = element as? JsonObject ?: return@mapNotNull null
                ModelUsageSummary(
                    model = item.string("model") ?: return@mapNotNull null,
                    provider = item.string("provider") ?: "",
                    cost = item.double("cost") ?: 0.0,
                    tokens = item.long("tokens") ?: 0,
                    share = item.double("share") ?: 0.0,
                    recordsCount = item.int("recordsCount") ?: 0,
                )
            },
            dayBreakdown = root.array("dayBreakdown").mapNotNull { element ->
                val item = element as? JsonObject ?: return@mapNotNull null
                UsageDaySummary(
                    date = item.string("date") ?: "",
                    label = item.string("label") ?: item.string("date") ?: "",
                    cost = item.double("cost") ?: 0.0,
                    tokens = item.long("tokens") ?: 0,
                    share = item.double("share") ?: 0.0,
                )
            },
            projectBreakdown = root.array("projectBreakdown").mapNotNull { element ->
                val item = element as? JsonObject ?: return@mapNotNull null
                UsageProjectSummary(
                    project = item.string("project") ?: "",
                    projectName = item.string("projectName") ?: item.string("project") ?: "",
                    cost = item.double("cost") ?: 0.0,
                    tokens = item.long("tokens") ?: 0,
                    share = item.double("share") ?: 0.0,
                    sessionsCount = item.int("sessionsCount") ?: 0,
                )
            },
            scanInfo = UsageScanInfo(
                transcriptsScanned = scan.int("transcriptsScanned") ?: 0,
                transcriptsOutsideWindow = scan.int("transcriptsOutsideWindow") ?: 0,
                usageRecordsCount = scan.int("usageRecordsCount") ?: 0,
                durationSeconds = scan.double("durationSeconds") ?: 0.0,
            ),
        )
    }

    private fun parseSelfUpdate(root: JsonObject): SelfUpdateStatus = SelfUpdateStatus(
        attemptId = root.string("attemptId") ?: "",
        state = root.string("state") ?: "prepared",
        stage = root.string("stage"),
        targetVersion = root.string("targetVersion") ?: "",
        error = root.string("error"),
    )

    private fun parsePrepare(root: JsonObject): SelfUpdatePrepare = SelfUpdatePrepare(
        attemptId = root.string("attemptId") ?: throw ApiError.Http(202, root.toString()),
        targetVersion = root.string("targetVersion") ?: "",
    )

    private fun action(name: String): String = buildJsonObject { put("action", name) }.toString()

    private fun commitPayload(attemptId: String): String = buildJsonObject {
        put("action", "commit")
        put("attemptId", attemptId)
    }.toString()

    private fun acknowledgePayload(attemptId: String): String = buildJsonObject {
        put("action", "acknowledge")
        put("attemptId", attemptId)
    }.toString()

    /** `status` answers JSON `null` while no attempt exists. */
    private suspend fun postElementOrNull(path: String, payload: String): JsonElement? {
        val request = api.requestBuilder(path)
            .post(payload.toRequestBody(JSON_MEDIA_TYPE))
            .build()
        return runCatching { Json.parseToJsonElement(send(request)) }.getOrNull()
    }

    private fun window(element: JsonElement?): ProviderUsageWindow? {
        val item = element as? JsonObject ?: return null
        return ProviderUsageWindow(
            percent = item.double("percent") ?: return null,
            resetMinutes = item.int("resetMinutes"),
            resetHours = item.int("resetHours"),
        )
    }

    private fun parseObject(body: String): JsonObject =
        parseObjectOrNull(body) ?: throw ApiError.Http(200, body.take(2048))

    private fun parseObjectOrNull(body: String): JsonObject? =
        runCatching { Json.parseToJsonElement(body) as? JsonObject }.getOrNull()

    private companion object {
        val JSON_MEDIA_TYPE = "application/json".toMediaType()
    }
}

// ------------------------------------------------------------ JSON helpers

private fun JsonObject.string(name: String): String? = (this[name] as? JsonPrimitive)?.contentOrNull
private fun JsonObject.boolean(name: String): Boolean? = (this[name] as? JsonPrimitive)?.booleanOrNull
private fun JsonObject.int(name: String): Int? = (this[name] as? JsonPrimitive)?.intOrNull
private fun JsonObject.long(name: String): Long? =
    (this[name] as? JsonPrimitive)?.let { it.longOrNull ?: it.doubleOrNull?.toLong() }

private fun JsonObject.double(name: String): Double? = (this[name] as? JsonPrimitive)?.doubleOrNull
private fun JsonObject.array(name: String): JsonArray = this[name] as? JsonArray ?: JsonArray(emptyList())
private fun JsonElement.stringValue(): String? = (this as? JsonPrimitive)?.contentOrNull
private val JsonPrimitive.longOrNull: Long?
    get() = contentOrNull?.toLongOrNull()
