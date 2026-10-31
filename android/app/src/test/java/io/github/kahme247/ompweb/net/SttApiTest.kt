package io.github.kahme247.ompweb.net

import io.github.kahme247.ompweb.domain.SttAfter
import io.github.kahme247.ompweb.domain.SttJobStatus
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The `/api/stt` job protocol as the app speaks it: multipart upload fields,
 * the 501/413/429 refusals, status-only polls, the one claim that carries the
 * transcript, retry and the kept audio (`lib/stt-jobs.ts`).
 */
class SttApiTest {

    private lateinit var server: MockWebServer
    private lateinit var api: HttpSttApi

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        val address = (ServerAddress.parse("http://127.0.0.1:${server.port}") as ServerAddressResult.Valid).address
        val client = ApiClient(
            OkHttpClient.Builder().readTimeout(5, TimeUnit.SECONDS).build(),
            { address },
        )
        api = HttpSttApi(client)
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun json(code: Int, body: String): MockResponse =
        MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

    @Test
    fun `upload sends the file, scope, owner and intent and reads the job id`() = runBlocking {
        server.enqueue(json(202, """{"jobId":"job-1"}"""))

        val outcome = api.start(
            scope = "new:/home/me/project",
            owner = "owner-token",
            after = SttAfter.FollowUp,
            audio = byteArrayOf(1, 2, 3),
            fileName = "rec-1.m4a",
            mimeType = "audio/mp4",
        )

        assertEquals(SttStartOutcome.Accepted("job-1"), outcome)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/stt", request.path)
        val body = request.body.readUtf8()
        assertTrue(body.contains("""name="file"; filename="rec-1.m4a""""))
        assertTrue(body.contains("Content-Type: audio/mp4"))
        assertTrue(body.contains("""name="scope""""))
        assertTrue(body.contains("new:/home/me/project"))
        assertTrue(body.contains("""name="owner""""))
        assertTrue(body.contains("owner-token"))
        assertTrue("insert intent is not uploaded", body.contains("""name="after""""))
        assertTrue(body.contains("followup"))
    }

    @Test
    fun `insert intent uploads no after field`() = runBlocking {
        server.enqueue(json(202, """{"jobId":"job-1"}"""))

        api.start(null, "owner", SttAfter.Insert, byteArrayOf(1), "rec.m4a", "audio/mp4")

        val body = server.takeRequest().body.readUtf8()
        assertTrue("no scope means no field", !body.contains("""name="scope""""))
        assertTrue("insert is the absence of after", !body.contains("""name="after""""))
    }

    @Test
    fun `an unconfigured server keeps the 501 message and marks it unconfigured`() = runBlocking {
        server.enqueue(json(501, """{"error":"STT not configured. Set OMP_WEB_STT_ENDPOINT or OMP_WEB_STT_MODEL."}"""))

        val outcome = api.start(null, "owner", SttAfter.Send, byteArrayOf(1), "rec.m4a", "audio/mp4")

        assertEquals(
            SttStartOutcome.Rejected(
                "STT not configured. Set OMP_WEB_STT_ENDPOINT or OMP_WEB_STT_MODEL.",
                notConfigured = true,
            ),
            outcome,
        )
    }

    @Test
    fun `a busy server and an oversized recording map to their messages`() = runBlocking {
        server.enqueue(json(429, """{"error":"Too many transcriptions in progress","code":"stt_busy"}"""))
        server.enqueue(json(413, """{"error":"Audio file too large (max 25MB)","code":"audio_too_large"}"""))

        val busy = api.start(null, "owner", SttAfter.Send, byteArrayOf(1), "rec.m4a", "audio/mp4")
        val tooLarge = api.start(null, "owner", SttAfter.Send, byteArrayOf(1), "rec.m4a", "audio/mp4")

        assertEquals(SttStartOutcome.Rejected("Too many transcriptions in progress"), busy)
        assertEquals(SttStartOutcome.Rejected("Audio file too large (max 25MB)"), tooLarge)
    }

    @Test
    fun `polls carry the status but never the transcript`() = runBlocking {
        server.enqueue(json(200, """{"id":"job-1","status":"pending"}"""))
        server.enqueue(json(200, """{"id":"job-2","status":"error","error":"No speech detected"}"""))
        server.enqueue(json(404, """{"error":"Transcription job not found","code":"stt_job_not_found"}"""))

        assertEquals(SttJobStatus.Pending, api.job("job-1")?.status)
        val failed = api.job("job-2")
        assertEquals(SttJobStatus.Error, failed?.status)
        assertEquals("No speech detected", failed?.error)
        assertNull(api.job("job-3"))
    }

    @Test
    fun `the claim is the only call that returns text and intent`() = runBlocking {
        server.enqueue(json(200, """{"id":"job-1","status":"done","text":"hello there","after":"send"}"""))
        server.enqueue(json(200, """{"id":"job-1","status":"done"}"""))

        val owner = api.claim("job-1", "claim-token", "owner-token")
        assertEquals("hello there", owner?.text)
        assertEquals(SttAfter.Send, owner?.after)

        val follower = api.claim("job-1", "other-token", "owner-token")
        assertNull("another composer only sees the status", follower?.text)
        assertNull(follower?.after)

        val first = server.takeRequest()
        val second = server.takeRequest()
        assertEquals("DELETE", first.method)
        assertEquals("/api/stt/job-1?claim=claim-token&owner=owner-token", first.path)
        assertEquals("/api/stt/job-1?claim=other-token&owner=owner-token", second.path)
    }

    @Test
    fun `a claim on a vanished job is null`() = runBlocking {
        server.enqueue(json(404, """{"error":"Transcription job not found"}"""))

        assertNull(api.claim("job-1", "claim", "owner"))
    }

    @Test
    fun `retry reports the restarted job, a missing job and a busy server`() = runBlocking {
        server.enqueue(json(200, """{"id":"job-1","status":"pending"}"""))
        server.enqueue(json(404, """{"error":"Transcription job not found"}"""))
        server.enqueue(json(429, """{"error":"Too many transcriptions in progress","code":"stt_busy"}"""))

        val restarted = api.retry("job-1", "owner")
        assertEquals(SttJobStatus.Pending, (restarted as SttRetryOutcome.Accepted).job.status)
        assertEquals(SttRetryOutcome.Missing, api.retry("job-2", "owner"))
        assertEquals(SttRetryOutcome.Busy, api.retry("job-3", "owner"))

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/stt/job-1?owner=owner", request.path)
    }

    @Test
    fun `the kept audio is downloaded with its audio type only`() = runBlocking {
        val bytes = "ABCD".toByteArray()
        server.enqueue(
            MockResponse().setResponseCode(200)
                .setHeader("Content-Type", "audio/mp4")
                .setBody("ABCD"),
        )
        server.enqueue(json(404, """{"error":"Transcription job not found"}"""))
        server.enqueue(
            MockResponse().setResponseCode(200)
                .setHeader("Content-Type", "text/html")
                .setBody("<html></html>"),
        )

        val audio = api.audio("job-1")
        assertEquals("audio/mp4", audio?.mimeType)
        assertArrayEquals(bytes, audio!!.bytes)
        assertNull(api.audio("job-2"))
        assertNull("a non-audio body is not a recording", api.audio("job-3"))
    }

    @Test
    fun `the scope lists its live jobs newest first`() = runBlocking {
        server.enqueue(
            json(
                200,
                """{"jobs":[{"id":"new","status":"pending"},{"id":"old","status":"error","error":"boom"}]}""",
            ),
        )

        val jobs = api.jobs("new:/home/me/project")

        assertEquals(listOf("new", "old"), jobs.map { it.id })
        assertEquals(SttJobStatus.Error, jobs[1].status)
        assertEquals("boom", jobs[1].error)
        assertEquals("/api/stt?scope=new%3A%2Fhome%2Fme%2Fproject", server.takeRequest().path)
    }
}
