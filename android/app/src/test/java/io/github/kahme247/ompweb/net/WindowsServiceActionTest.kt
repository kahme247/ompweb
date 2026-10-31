package io.github.kahme247.ompweb.net

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * B31: the Windows service card's actions must reach `/api/windows-service`
 * with the web's wire values (`WindowsServiceCard.tsx`), and `cleanConfig`
 * only rides along on an uninstall.
 */
class WindowsServiceActionTest {

    private lateinit var server: MockWebServer
    private lateinit var api: SystemApi
    private val bodies = mutableListOf<String>()
    private val queued = java.util.concurrent.ConcurrentLinkedQueue<MockResponse>()

    private val statusJson = """
        {"isWindows":true,"isInstalled":true,"autostart":true,"isRunning":true,"port":30177,
         "hostname":"localhost","mode":"service","desktopShortcutExists":false,
         "serviceUrl":"http://127.0.0.1:30177","version":"1.2.3"}
    """.trimIndent()

    private fun success(): MockResponse = MockResponse()
        .setHeader("Content-Type", "application/json")
        .setBody("""{"success":true,"message":"ok","status":$statusJson}""")

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse {
                bodies += request.body.readUtf8()
                return queued.poll() ?: success()
            }
        }
        server.start()
        val address = (ServerAddress.parse("http://127.0.0.1:${server.port}") as ServerAddressResult.Valid).address
        api = ApiClient(OkHttpClient(), { address }).systemApi()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private suspend fun call(action: WindowsServiceAction, cleanConfig: Boolean = false) =
        api.windowsAction(action, cleanConfig)

    /** The action strings the web sends (`WindowsServiceCard.tsx` handlers). */
    @Test
    fun `every action keeps its wire value`() = kotlinx.coroutines.runBlocking {
        val expected = mapOf(
            WindowsServiceAction.INSTALL to "install",
            WindowsServiceAction.START to "start",
            WindowsServiceAction.STOP to "stop",
            WindowsServiceAction.RESTART to "restart",
            WindowsServiceAction.TOGGLE_AUTOSTART to "toggle-autostart",
            WindowsServiceAction.UNINSTALL to "uninstall",
        )
        expected.forEach { (action, wire) -> call(action) }

        assertEquals(expected.values.toList(), bodies.map { body ->
            Json.parseToJsonElement(body).jsonObject.getValue("action").jsonPrimitive.content
        })
    }

    @Test
    fun `cleanConfig only rides along with an uninstall`() = kotlinx.coroutines.runBlocking {
        call(WindowsServiceAction.UNINSTALL)
        call(WindowsServiceAction.UNINSTALL, cleanConfig = true)
        call(WindowsServiceAction.INSTALL, cleanConfig = true)

        // install/start/... never carry the flag, even if the caller passes it.
        assertFalse(Json.parseToJsonElement(bodies[0]).jsonObject.containsKey("cleanConfig"))
        assertEquals(true, Json.parseToJsonElement(bodies[1]).jsonObject.getValue("cleanConfig").jsonPrimitive.content.toBoolean())
        assertFalse(Json.parseToJsonElement(bodies[2]).jsonObject.containsKey("cleanConfig"))
    }

    @Test
    fun `the answer carries the refreshed status`() = kotlinx.coroutines.runBlocking {
        val result = call(WindowsServiceAction.START)

        assertTrue(result.success)
        assertEquals("ok", result.message)
        val status = result.status
        requireNotNull(status)
        assertTrue(status.isWindows)
        assertTrue(status.isRunning)
        assertEquals("http://127.0.0.1:30177", status.serviceUrl)
    }

    @Test
    fun `a failed action without a status still reports the message`() = kotlinx.coroutines.runBlocking {
        queued += MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json")
            .setBody("""{"success":false,"message":"access denied"}""")

        val result = call(WindowsServiceAction.STOP)

        assertFalse(result.success)
        assertEquals("access denied", result.message)
        assertNull(result.status)
    }
}
