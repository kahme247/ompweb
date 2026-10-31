package io.github.kahme247.ompweb.net

import io.github.kahme247.ompweb.domain.GitFileDiff
import io.github.kahme247.ompweb.domain.GitStatusResponse
import io.github.kahme247.ompweb.domain.parseGitFileDiff
import io.github.kahme247.ompweb.domain.parseGitStatusResponse
import java.net.URLEncoder
import okhttp3.Request

/**
 * `/api/git/status` and `/api/git/diff` (`app/api/git`), as an interface so
 * the git-changes view model runs in JVM tests without a server.
 *
 * Both routes take absolute paths and are gated by the same file allow-list as
 * `/api/files`: a 403 or 400 is a normal answer the UI shows, never a crash.
 */
interface GitApi {

    /** `GET /api/git/status?cwd=` — every changed file below [cwd]. */
    suspend fun status(cwd: String): GitStatusResponse

    /**
     * `GET /api/git/diff?cwd=&path=` — the unified patch (3 lines of context)
     * for one changed file, or `{supported:false}` when git has none.
     */
    suspend fun diff(cwd: String, path: String): GitFileDiff
}

/** Production [GitApi] over the app's single authenticated client. */
fun ApiClient.gitApi(): GitApi = HttpGitApi(this)

private class HttpGitApi(private val api: ApiClient) : GitApi {

    override suspend fun status(cwd: String): GitStatusResponse =
        get("$STATUS_PATH?cwd=${encodeQuery(cwd)}", ::parseGitStatusResponse)

    override suspend fun diff(cwd: String, path: String): GitFileDiff =
        get("$DIFF_PATH?cwd=${encodeQuery(cwd)}&path=${encodeQuery(path)}", ::parseGitFileDiff)

    private suspend fun <T> get(path: String, parse: (String) -> T?): T {
        val request = api.requestBuilder(path).get().build()
        val response = api.exchange(request)
        val text = response.text()
        if (response.status !in 200..299) {
            throw api.errorFor(response.status, text, originOf(request))
        }
        // A 2xx body that is not the documented shape is an Http error, never
        // a silently empty changes list.
        return parse(text) ?: throw ApiError.Http(response.status, text.take(2048))
    }

    private fun originOf(request: Request): ServerAddress =
        ServerAddress(request.url.scheme, request.url.host, request.url.port)

    private fun encodeQuery(value: String): String = URLEncoder.encode(value, "UTF-8")

    private companion object {
        const val STATUS_PATH = "api/git/status"
        const val DIFF_PATH = "api/git/diff"
    }
}
