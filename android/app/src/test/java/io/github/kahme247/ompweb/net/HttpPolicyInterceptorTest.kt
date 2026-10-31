package io.github.kahme247.ompweb.net

import java.io.IOException
import java.net.InetAddress
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class HttpPolicyInterceptorTest {

    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun client() = HttpPolicyInterceptor.install(OkHttpClient.Builder()).build()

    @Test
    fun `plain http to a public host is refused before a connection is made`() {
        val request = Request.Builder().url("http://example.com:30177/api/sessions").get().build()
        val error = assertThrows(IOException::class.java) {
            client().newCall(request).execute()
        }
        assertTrue(error.message.orEmpty().contains("Plain HTTP"))
    }

    @Test
    fun `plain http to a private address is allowed`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"sessions":[]}"""))
        client().newCall(Request.Builder().url(server.url("/api/sessions")).get().build()).execute().use { response ->
            assertEquals(200, response.code)
        }
    }

    @Test
    fun `a redirect to another origin is refused instead of carrying the request`() {
        val target = MockWebServer()
        target.start()
        try {
            target.enqueue(MockResponse().setResponseCode(200).setBody("""{"sessions":[]}"""))
            server.enqueue(
                MockResponse().setResponseCode(302).setHeader("Location", target.url("/api/sessions").toString()),
            )
            val request = Request.Builder().url(server.url("/api/sessions")).get().build()
            val error = assertThrows(IOException::class.java) {
                client().newCall(request).execute()
            }
            assertTrue(error.message.orEmpty().contains("Cross-origin redirect"))
            assertEquals(0, target.requestCount)
        } finally {
            target.shutdown()
        }
    }

    @Test
    fun `a local name that resolves to a public address is refused`() {
        val public = InetAddress.getByName("192.0.2.1")
        val client = HttpPolicyInterceptor.install(
            OkHttpClient.Builder()
                .dns { listOf(public) }
                .connectTimeout(500, TimeUnit.MILLISECONDS),
        ).build()
        val request = Request.Builder().url("http://mypc.local:30177/api/sessions").get().build()

        val error = assertThrows(IOException::class.java) {
            client.newCall(request).execute()
        }

        val messages = generateSequence<Throwable>(error) { it.cause }
            .mapNotNull { it.message }
            .joinToString(" / ")
        assertTrue(messages.contains("Plain HTTP"))
        assertTrue(messages.contains("192.0.2.1"))
    }

    @Test
    fun `only loopback, private, link-local and CGNAT peers count as private`() {
        for (allowed in listOf("127.0.0.1", "10.1.2.3", "172.16.5.4", "172.31.255.254", "192.168.178.20",
            "169.254.10.1", "100.64.0.1", "100.127.255.254", "::1", "fd00::1", "fe80::1")) {
            assertTrue(allowed, HttpPolicyInterceptor.isPrivatePeer(InetAddress.getByName(allowed)))
        }
        for (public in listOf("8.8.8.8", "192.0.2.1", "172.32.0.1", "100.128.0.1", "100.63.255.255",
            "2001:4860:4860::8888")) {
            assertTrue(!HttpPolicyInterceptor.isPrivatePeer(InetAddress.getByName(public)))
        }
    }
}
