package io.github.kahme247.ompweb.net

import kotlinx.serialization.Serializable

/**
 * One hit of `GET /api/sessions/messages/search` (server
 * `lib/session-message-search.ts`). Offsets are UTF-16 code-unit positions
 * inside [snippet], the same unit Kotlin strings use, so the row can highlight
 * without recomputing the match.
 */
@Serializable
data class SessionSearchHit(
    val sessionId: String = "",
    val title: String = "",
    val entryId: String = "",
    val role: String = "user",
    val timestamp: String = "",
    val snippet: String = "",
    val matchStart: Int = 0,
    val matchEnd: Int = 0,
)

/**
 * One bounded page of the search; [cursor] resumes a partial scan.
 *
 * [skippedFiles] counts session files this page had to leave out because they
 * exceed the server's 64 MiB scan limit (`SEARCH_LARGE_FILE_BYTES`): their text
 * is not searchable, so a miss is not proof that the phrase is absent.
 */
@Serializable
data class SessionSearchPage(
    val results: List<SessionSearchHit> = emptyList(),
    val partial: Boolean = false,
    val cursor: String? = null,
    val skippedFiles: Int = 0,
)

/** Full-text search for the session list ("Search in messages"). */
interface SessionSearchApi {
    suspend fun searchSessions(
        query: String,
        limit: Int = 20,
        cursor: String? = null,
    ): SessionSearchPage
}
