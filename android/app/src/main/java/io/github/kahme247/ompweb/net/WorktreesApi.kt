package io.github.kahme247.ompweb.net

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * `/api/worktrees` (`app/api/worktrees/route.ts`): list, create, remove the
 * worktrees of one repository, as an interface so the Worktrees view model
 * runs in JVM tests without a server.
 *
 * Create and remove carry the project root (the server resolves worktrees and
 * subdirectories itself) and report the route's stable `code`s, which the pane
 * turns into "ask before force" (409 `worktree_dirty`) or an inline error.
 */
interface WorktreesApi {

    /** `GET ?cwd=` — the repo's worktrees plus whether the cwd is a Git top level. */
    suspend fun list(cwd: String): WorktreeList

    /** `POST {cwd, branch}` — the new worktree (existing branch reused, else created). */
    suspend fun create(cwd: String, branch: String): WorktreeEntry

    /**
     * `DELETE {cwd, path, force?}`. A dirty worktree answers 409
     * `worktree_dirty` as [`ApiError.ServerResponse`]; the caller retries with
     * `force = true` after the user confirmed.
     */
    suspend fun remove(cwd: String, path: String, force: Boolean)
}

/** Production [WorktreesApi] over the app's single authenticated client. */
fun ApiClient.worktreesApi(): WorktreesApi = HttpWorktreesApi(this)

private class HttpWorktreesApi(private val api: ApiClient) : WorktreesApi {

    override suspend fun list(cwd: String): WorktreeList = api.worktrees(cwd)

    override suspend fun create(cwd: String, branch: String): WorktreeEntry {
        val payload = buildJsonObject {
            put("cwd", cwd)
            put("branch", branch)
        }.toString()
        val request = api.requestBuilder(PATH).post(payload.toRequestBody(JSON_MEDIA_TYPE)).build()
        val body = send(request)
        val created = parseObject(body)
        val path = created?.get("path")?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }
            ?: throw ApiError.Http(200, body.take(2048))
        return WorktreeEntry(
            path = path,
            branch = created["branch"]?.jsonPrimitive?.contentOrNull ?: branch,
            isMain = false,
        )
    }

    override suspend fun remove(cwd: String, path: String, force: Boolean) {
        val payload = buildJsonObject {
            put("cwd", cwd)
            put("path", path)
            put("force", force)
        }.toString()
        send(api.requestBuilder(PATH).delete(payload.toRequestBody(JSON_MEDIA_TYPE)).build())
    }

    private suspend fun send(request: Request): String {
        val response = api.exchange(request)
        val text = response.text()
        if (response.status in 200..299) return text
        // 401/403 keep their global meaning (sign out / not allowed).
        if (response.status == 401 || response.status == 403) {
            throw api.errorFor(response.status, text, originOf(request))
        }
        val error = parseObject(text)
        throw ApiError.ServerResponse(
            status = response.status,
            code = error?.get("code")?.jsonPrimitive?.contentOrNull,
            serverMessage = error?.get("error")?.jsonPrimitive?.contentOrNull,
        )
    }

    private fun parseObject(body: String): JsonObject? =
        runCatching { Json.parseToJsonElement(body) as? JsonObject }.getOrNull()

    private fun originOf(request: Request): ServerAddress =
        ServerAddress(request.url.scheme, request.url.host, request.url.port)

    private companion object {
        const val PATH = "api/worktrees"
        val JSON_MEDIA_TYPE = "application/json".toMediaType()
    }
}
