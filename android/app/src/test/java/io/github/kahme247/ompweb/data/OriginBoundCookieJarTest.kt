package io.github.kahme247.ompweb.data

import java.io.IOException
import okhttp3.Cookie
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OriginBoundCookieJarTest {

    private val origin = "http://100.64.0.10:30177/api/sessions".toHttpUrl()
    private val otherPort = "http://100.64.0.10:30176/api/sessions".toHttpUrl()
    private val otherHost = "http://100.64.0.11:30177/api/sessions".toHttpUrl()

    private fun jar(
        configured: HttpUrl? = origin,
        records: CookieRecords = InMemoryCookieRecords(),
        now: Long = 1_000L,
    ): OriginBoundCookieJar = OriginBoundCookieJar({ configured }, records, { now })

    private fun cookie(value: String = "token", expiresAt: Long = 10_000L): Cookie =
        Cookie.Builder()
            .name("omp_web_session")
            .value(value)
            .domain("100.64.0.10")
            .path("/")
            .expiresAt(expiresAt)
            .build()

    @Test
    fun `a cookie of the configured origin is sent back to it`() {
        val jar = jar()
        jar.saveFromResponse(origin, listOf(cookie("token")))

        val sent = jar.loadForRequest(origin)

        assertEquals(listOf("token"), sent.map { it.value })
    }

    @Test
    fun `a cookie is never sent to another port on the same host`() {
        val jar = jar()
        jar.saveFromResponse(origin, listOf(cookie()))

        assertTrue(jar.loadForRequest(otherPort).isEmpty())
    }

    @Test
    fun `a cookie is never sent to another host`() {
        val jar = jar()
        jar.saveFromResponse(origin, listOf(cookie()))

        assertTrue(jar.loadForRequest(otherHost).isEmpty())
    }

    @Test
    fun `a cookie is never sent over another scheme`() {
        val secureOrigin = "https://omp.example:30178/api/sessions".toHttpUrl()
        val secureJar = OriginBoundCookieJar(
            configuredOrigin = { secureOrigin },
            records = InMemoryCookieRecords(),
        )
        val secureCookie = Cookie.Builder()
            .name("omp_web_session")
            .value("token")
            .domain("omp.example")
            .path("/")
            .expiresAt(10_000L)
            .secure()
            .build()

        secureJar.saveFromResponse(secureOrigin, listOf(secureCookie))

        assertTrue(secureJar.loadForRequest("http://omp.example:30178/api/sessions".toHttpUrl()).isEmpty())
    }

    @Test
    fun `a Set-Cookie from another origin is ignored`() {
        val jar = jar()
        jar.saveFromResponse(otherPort, listOf(cookie()))

        assertTrue(jar.loadForRequest(origin).isEmpty())
    }

    @Test
    fun `an expired cookie is dropped and removed from storage`() {
        val records = InMemoryCookieRecords()
        val jar = jar(records = records, now = 2_000L)
        jar.saveFromResponse(origin, listOf(cookie(expiresAt = 1_500L)))

        assertTrue(jar.loadForRequest(origin).isEmpty())
        assertTrue(records.load().isEmpty())
    }

    @Test
    fun `stored cookies survive a new jar instance`() {
        val records = InMemoryCookieRecords()
        jar(records = records).saveFromResponse(origin, listOf(cookie("token")))

        val restarted = jar(records = records)

        assertEquals(listOf("token"), restarted.loadForRequest(origin).map { it.value })
    }

    @Test
    fun `clear forgets the session`() {
        val records = InMemoryCookieRecords()
        val jar = jar(records = records)
        jar.saveFromResponse(origin, listOf(cookie()))

        jar.clear()

        assertTrue(jar.loadForRequest(origin).isEmpty())
        assertTrue(records.load().isEmpty())
    }

    @Test
    fun `without a configured origin nothing is sent`() {
        val jar = jar(configured = null)
        jar.saveFromResponse(origin, listOf(cookie()))

        assertTrue(jar.loadForRequest(origin).isEmpty())
    }

    @Test
    fun `switching servers drops the old server's cookie`() {
        val records = InMemoryCookieRecords()
        jar(records = records).saveFromResponse(origin, listOf(cookie("old")))

        val nextServer = jar(configured = otherHost, records = records)

        assertTrue(nextServer.loadForRequest(otherHost).isEmpty())
        assertTrue(nextServer.loadForRequest(origin).isEmpty())
        assertTrue(records.load().isEmpty())
    }

    @Test
    fun `a Set-Cookie for a request started before clear is dropped`() {
        val records = InMemoryCookieRecords()
        val jar = jar(records = records)
        jar.loadForRequest(origin)

        jar.clear()
        jar.saveFromResponse(origin, listOf(cookie("late")))

        assertTrue(jar.loadForRequest(origin).isEmpty())
        assertTrue(records.load().isEmpty())
    }

    @Test
    fun `records written without an origin are never loaded`() {
        val legacy = StoredCookie(
            name = "omp_web_session",
            value = "token",
            expiresAtMillis = 10_000L,
            domain = "100.64.0.10",
            path = "/",
            secure = false,
            httpOnly = true,
        )
        val records = InMemoryCookieRecords(listOf(legacy))

        val jar = jar(records = records)

        assertTrue(jar.loadForRequest(origin).isEmpty())
        assertTrue(records.load().isEmpty())
    }

    @Test
    fun `a failing cookie store does not break save or load`() {
        val jar = jar(records = FailingCookieRecords())

        jar.saveFromResponse(origin, listOf(cookie("token")))

        assertEquals(listOf("token"), jar.loadForRequest(origin).map { it.value })
    }

    private class FailingCookieRecords : CookieRecords {
        override fun load(): List<StoredCookie> = emptyList()

        override fun save(cookies: List<StoredCookie>) {
            throw IOException("disk full")
        }
    }
}
