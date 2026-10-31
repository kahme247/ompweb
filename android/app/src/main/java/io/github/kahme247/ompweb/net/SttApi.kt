package io.github.kahme247.ompweb.net

import io.github.kahme247.ompweb.domain.SttAfter
import io.github.kahme247.ompweb.domain.SttClaim
import io.github.kahme247.ompweb.domain.SttJob
import io.github.kahme247.ompweb.domain.SttJobStatus
import java.net.URLEncoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * The transcription routes of `/api/stt`, as an interface so the dictation
 * view model runs in JVM tests without a server.
 *
 * The job protocol is `lib/stt-jobs.ts`: the upload keeps the audio and starts
 * a server-side job, polls only carry the status, and the transcript is
 * delivered by exactly one claim token. `null` from [job], [claim] and [audio]
 * is a 404 (unknown/expired job); every other failure is an [ApiError].
 */
interface SttApi {

    /**
     * `POST /api/stt` (multipart `file, scope, owner, after`) → 202 `{jobId}`.
     * 501/413/429 answer their message as [SttStartOutcome.Rejected].
     */
    suspend fun start(
        scope: String?,
        owner: String,
        after: SttAfter?,
        audio: ByteArray,
        fileName: String,
        mimeType: String,
    ): SttStartOutcome

    /** `GET /api/stt?scope=` — live jobs of that composer, newest first. */
    suspend fun jobs(scope: String): List<SttJob>

    /** `GET /api/stt/{jobId}` — status only, never the transcript. */
    suspend fun job(jobId: String): SttJob?

    /** `DELETE ?claim=&owner=` — the one call that delivers the transcript. */
    suspend fun claim(jobId: String, claimToken: String, ownerToken: String): SttClaim?

    /** `DELETE` without a claim: discards the job and aborts its upstream request. */
    suspend fun discard(jobId: String)

    /** `POST /api/stt/{jobId}?owner=` — retry with the audio the server kept. */
    suspend fun retry(jobId: String, ownerToken: String): SttRetryOutcome

    /** `GET /api/stt/{jobId}/audio` — the kept recording, for playback. */
    suspend fun audio(jobId: String): SttAudio?
}

/** `POST /api/stt` answer: a started job, or the server's refusal. */
sealed interface SttStartOutcome {
    data class Accepted(val jobId: String) : SttStartOutcome

    /**
     * 501 unconfigured, 413 too large, 429 busy, 400 invalid — the server's
     * message. [notConfigured] marks the 501 answer so `Auto` can use the
     * phone's recognizer from then on.
     */
    data class Rejected(
        val message: String,
        val notConfigured: Boolean = false,
    ) : SttStartOutcome
}

/** `POST /api/stt/{jobId}?owner=` answer (retry with the audio the server kept). */
sealed interface SttRetryOutcome {
    data class Accepted(val job: SttJob) : SttRetryOutcome

    /** 404: the job is gone (server restart, expiry, pruned tombstone). */
    data object Missing : SttRetryOutcome

    /** 429: too many transcriptions in progress. */
    data object Busy : SttRetryOutcome

    data class Rejected(val message: String, val notConfigured: Boolean = false) : SttRetryOutcome
}

/** The recording the server kept for a live job, for playback in any composer. */
class SttAudio(val bytes: ByteArray, val mimeType: String)

/**
 * [SttApi] over the app's single authenticated client. All HTTP goes through
 * `ApiClient` (origin binding, cookie jar, policy interceptor, typed errors);
 * this class only builds the multipart upload and the binary download and
 * parses the small job payloads.
 */
class HttpSttApi(private val api: ApiClient) : SttApi {

    override suspend fun start(
        scope: String?,
        owner: String,
        after: SttAfter?,
        audio: ByteArray,
        fileName: String,
        mimeType: String,
    ): SttStartOutcome {
        val multipart = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("file", fileName, audio.toRequestBody(mimeType.toMediaType()))
            .addFormDataPart("owner", owner)
        if (scope != null) multipart.addFormDataPart("scope", scope)
        after?.wire?.let { multipart.addFormDataPart("after", it) }
        val request = api.requestBuilder(STT_PATH).post(multipart.build()).build()
        val response = api.exchange(request)
        val text = response.text()
        if (response.status in 200..299) {
            val jobId = parseObject(text)?.get("jobId")?.jsonPrimitive?.contentOrNull
            if (jobId.isNullOrBlank()) {
                return SttStartOutcome.Rejected("Transcription failed (HTTP ${response.status})")
            }
            return SttStartOutcome.Accepted(jobId)
        }
        val message = errorMessage(text)
        return when (response.status) {
            429 -> SttStartOutcome.Rejected(message ?: BUSY)
            501 -> SttStartOutcome.Rejected(message ?: NOT_CONFIGURED, notConfigured = true)
            413 -> SttStartOutcome.Rejected(message ?: TOO_LARGE)
            400 -> SttStartOutcome.Rejected(message ?: REJECTED)
            else -> throw api.errorFor(response.status, text, originOf(request))
        }
    }

    override suspend fun jobs(scope: String): List<SttJob> {
        val request = api.requestBuilder("$STT_PATH?scope=${encodeQuery(scope)}").get().build()
        val response = api.exchange(request)
        if (response.status !in 200..299) throw api.errorFor(response.status, response.text(), originOf(request))
        val text = response.text()
        val root = parseObject(text) ?: throw ApiError.Http(200, text.take(2048))
        return root["jobs"]?.jsonArray?.mapNotNull { element ->
            parseJob(element as? JsonObject ?: return@mapNotNull null)
        }.orEmpty()
    }

    override suspend fun job(jobId: String): SttJob? =
        readJob(api.requestBuilder("$STT_PATH/${encodePathSegment(jobId)}").get().build())

    override suspend fun claim(jobId: String, claimToken: String, ownerToken: String): SttClaim? {
        val path = "$STT_PATH/${encodePathSegment(jobId)}" +
            "?claim=${encodeQuery(claimToken)}&owner=${encodeQuery(ownerToken)}"
        val request = api.requestBuilder(path).delete().build()
        val response = api.exchange(request)
        if (response.status == 404) return null
        val text = response.text()
        if (response.status !in 200..299) throw api.errorFor(response.status, text, originOf(request))
        val root = parseObject(text) ?: throw ApiError.Http(200, text.take(2048))
        val id = root.string("id") ?: jobId
        val status = statusOf(root.string("status")) ?: throw ApiError.Http(200, text.take(2048))
        return SttClaim(
            id = id,
            status = status,
            error = root.string("error"),
            text = root.string("text"),
            after = afterOf(root.string("after")),
        )
    }

    override suspend fun discard(jobId: String) {
        val request = api.requestBuilder("$STT_PATH/${encodePathSegment(jobId)}").delete().build()
        val response = api.exchange(request)
        // A job someone else already took is a successful discard for us.
        if (response.status == 404) return
        if (response.status !in 200..299) throw api.errorFor(response.status, response.text(), originOf(request))
    }

    override suspend fun retry(jobId: String, ownerToken: String): SttRetryOutcome {
        val path = "$STT_PATH/${encodePathSegment(jobId)}?owner=${encodeQuery(ownerToken)}"
        val request = api.requestBuilder(path).post(EMPTY_BODY).build()
        val response = api.exchange(request)
        val text = response.text()
        return when {
            response.status == 404 -> SttRetryOutcome.Missing
            response.status == 429 -> SttRetryOutcome.Busy
            response.status == 501 -> SttRetryOutcome.Rejected(
                errorMessage(text) ?: NOT_CONFIGURED,
                notConfigured = true,
            )
            response.status in 200..299 -> {
                val job = parseJob(parseObject(text))
                if (job == null) SttRetryOutcome.Rejected("Transcription failed (HTTP ${response.status})")
                else SttRetryOutcome.Accepted(job)
            }
            else -> throw api.errorFor(response.status, text, originOf(request))
        }
    }

    override suspend fun audio(jobId: String): SttAudio? {
        val request = api.requestBuilder("$STT_PATH/${encodePathSegment(jobId)}/audio", accept = "audio/*, */*")
            .get()
            .build()
        // The server keeps up to 25 MB of audio per job (`MAX_STT_AUDIO_BYTES`).
        val response = api.exchange(request, limit = MAX_AUDIO_BYTES)
        if (response.status == 404) return null
        if (response.status !in 200..299) throw api.errorFor(response.status, response.text(), originOf(request))
        val mimeType = response.contentType?.substringBefore(';')?.trim().orEmpty()
        if (!mimeType.startsWith("audio/")) return null
        return SttAudio(response.body, mimeType)
    }

    private suspend fun readJob(request: okhttp3.Request): SttJob? {
        val response = api.exchange(request)
        if (response.status == 404) return null
        val text = response.text()
        if (response.status !in 200..299) throw api.errorFor(response.status, text, originOf(request))
        val job = parseJob(parseObject(text)) ?: throw ApiError.Http(200, text.take(2048))
        return job
    }

    private fun parseJob(root: JsonObject?): SttJob? {
        if (root == null) return null
        val id = root.string("id") ?: return null
        val status = statusOf(root.string("status")) ?: return null
        return SttJob(id = id, status = status, error = root.string("error"))
    }

    private fun JsonObject.string(key: String): String? = this[key]?.jsonPrimitive?.contentOrNull

    private fun parseObject(text: String): JsonObject? = try {
        json.parseToJsonElement(text).jsonObject
    } catch (_: Exception) {
        null
    }

    private fun errorMessage(text: String): String? = parseObject(text)?.string("error")

    private fun originOf(request: okhttp3.Request): ServerAddress =
        ServerAddress(request.url.scheme, request.url.host, request.url.port)

    private fun statusOf(value: String?): SttJobStatus? = when (value) {
        SttJobStatus.Pending.wire -> SttJobStatus.Pending
        SttJobStatus.Done.wire -> SttJobStatus.Done
        SttJobStatus.Error.wire -> SttJobStatus.Error
        SttJobStatus.Gone.wire -> SttJobStatus.Gone
        else -> null
    }

    private fun afterOf(value: String?): SttAfter? = when (value) {
        SttAfter.Send.wire -> SttAfter.Send
        SttAfter.Steer.wire -> SttAfter.Steer
        SttAfter.FollowUp.wire -> SttAfter.FollowUp
        else -> null
    }

    private fun encodePathSegment(value: String): String =
        URLEncoder.encode(value, "UTF-8").replace("+", "%20")

    private fun encodeQuery(value: String): String = URLEncoder.encode(value, "UTF-8")

    private companion object {
        const val STT_PATH = "api/stt"

        /** `MAX_STT_AUDIO_BYTES` in `lib/stt.ts`. */
        const val MAX_AUDIO_BYTES = 25L * 1024 * 1024

        val EMPTY_BODY = ByteArray(0).toRequestBody("application/json".toMediaType())

        const val NOT_CONFIGURED = "Speech recognition is not configured on the server"
        const val TOO_LARGE = "Recording too large (max 25 MB)"
        const val BUSY = "Too many transcriptions in progress"
        const val REJECTED = "The recording was rejected"

        val json = Json { ignoreUnknownKeys = true }
    }
}

