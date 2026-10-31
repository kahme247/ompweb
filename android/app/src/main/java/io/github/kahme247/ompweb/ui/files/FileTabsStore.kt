package io.github.kahme247.ompweb.ui.files

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/** One open file tab as it survives a process death: its path and its file-API session. */
data class StoredFileTab(val path: String, val sourceSessionId: String?)

/**
 * Open file tabs, persisted per server installation. The web keeps its file
 * tabs in memory and loses them on reload; the app restores them on a cold
 * start (phase 9 spec item 5), so a process death does not close the panel's
 * files.
 */
interface FileTabStore {
    suspend fun load(origin: String?): List<StoredFileTab>

    suspend fun save(origin: String?, tabs: List<StoredFileTab>)

    suspend fun clear()
}

/** JVM tests and previews: tabs stay in memory. */
class MemoryFileTabStore : FileTabStore {
    private var origin: String? = null
    private var tabs: List<StoredFileTab> = emptyList()

    override suspend fun load(origin: String?): List<StoredFileTab> =
        if (this.origin == origin) tabs else emptyList()

    override suspend fun save(origin: String?, tabs: List<StoredFileTab>) {
        this.origin = origin
        this.tabs = tabs
    }

    override suspend fun clear() {
        origin = null
        tabs = emptyList()
    }
}

private val Context.fileTabsDataStore: DataStore<Preferences> by preferencesDataStore(name = "omp-file-tabs")

/**
 * DataStore-backed [FileTabStore]. The origin is stored with the paths, so
 * switching servers can never reopen another installation's files (the token
 * is the origin, never a path list from a different host).
 */
class PreferencesFileTabStore(context: Context) : FileTabStore {

    private val dataStore = context.applicationContext.fileTabsDataStore
    private val json = Json { ignoreUnknownKeys = true }

    override suspend fun load(origin: String?): List<StoredFileTab> {
        val raw = dataStore.data.first()[TABS_KEY] ?: return emptyList()
        val root = runCatching { json.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return emptyList()
        val storedOrigin = (root["origin"] as? JsonPrimitive)?.contentOrNull
        if (storedOrigin != origin) return emptyList()
        val tabs = root["tabs"] as? JsonArray ?: return emptyList()
        return tabs.mapNotNull { element ->
            val tab = element as? JsonObject ?: return@mapNotNull null
            val path = (tab["path"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
                ?: return@mapNotNull null
            StoredFileTab(path, (tab["sourceSessionId"] as? JsonPrimitive)?.contentOrNull)
        }
    }

    override suspend fun save(origin: String?, tabs: List<StoredFileTab>) {
        val payload = buildJsonObject {
            put("origin", origin?.let { JsonPrimitive(it) } ?: JsonNull)
            put(
                "tabs",
                buildJsonArray {
                    tabs.forEach { tab ->
                        add(
                            buildJsonObject {
                                put("path", tab.path)
                                if (tab.sourceSessionId == null) {
                                    put("sourceSessionId", JsonNull)
                                } else {
                                    put("sourceSessionId", tab.sourceSessionId)
                                }
                            },
                        )
                    }
                },
            )
        }
        dataStore.edit { preferences -> preferences[TABS_KEY] = payload.toString() }
    }

    override suspend fun clear() {
        dataStore.edit { preferences -> preferences.remove(TABS_KEY) }
    }

    private companion object {
        val TABS_KEY = stringPreferencesKey("open-file-tabs")
    }
}
