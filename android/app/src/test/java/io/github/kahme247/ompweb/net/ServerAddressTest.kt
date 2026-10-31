package io.github.kahme247.ompweb.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerAddressTest {

    private fun valid(input: String): ServerAddress {
        val result = ServerAddress.parse(input)
        assertTrue("expected <$input> to be valid but was $result", result is ServerAddressResult.Valid)
        return (result as ServerAddressResult.Valid).address
    }

    private fun invalid(input: String): String {
        val result = ServerAddress.parse(input)
        assertTrue("expected <$input> to be invalid but was $result", result is ServerAddressResult.Invalid)
        val message = (result as ServerAddressResult.Invalid).message
        assertTrue("expected a non-empty message for <$input>", message.isNotBlank())
        return message
    }

    @Test
    fun `tailscale ipv4 without port uses http and 30177`() {
        val address = valid("100.64.0.10")
        assertEquals("http", address.scheme)
        assertEquals("100.64.0.10", address.host)
        assertEquals(30177, address.port)
        assertEquals("http://100.64.0.10:30177", address.origin)
        assertEquals("http://100.64.0.10:30177/api/sessions", address.apiUrl("api/sessions"))
    }

    @Test
    fun `explicit port is kept`() {
        val address = valid("100.64.0.10:30177")
        assertEquals("http://100.64.0.10:30177", address.origin)
    }

    @Test
    fun `single label host defaults to http`() {
        val address = valid("my-pc")
        assertEquals("http", address.scheme)
        assertEquals("my-pc", address.host)
        assertEquals(30177, address.port)
    }

    @Test
    fun `tailnet magic dns name defaults to http because tailscale encrypts it`() {
        val address = valid("my-pc.tailnet.ts.net")
        assertEquals("http", address.scheme)
        assertEquals("http://my-pc.tailnet.ts.net:30177", address.origin)
        assertEquals("http", valid("http://my-pc.tailnet.ts.net:30177").scheme)
        assertEquals("https", valid("https://my-pc.tailnet.ts.net").scheme)
    }

    @Test
    fun `full urls keep their scheme`() {
        assertEquals("http", valid("http://192.168.1.20:8080").scheme)
        assertEquals(8080, valid("http://192.168.1.20:8080").port)
        assertEquals("https", valid("https://example.com").scheme)
        assertEquals(30177, valid("https://example.com").port)
        assertEquals("http", valid("http://localhost:30177").scheme)
        assertEquals("http://localhost:30177", valid("HTTP://LOCALHOST:30177").origin)
    }

    @Test
    fun `private ipv4 ranges allow http`() {
        listOf("10.0.0.5", "172.16.4.4", "172.31.255.254", "192.168.178.20", "169.254.10.10", "127.0.0.1", "100.64.0.1", "100.127.255.254")
            .forEach { ip ->
                val address = valid(ip)
                assertEquals("http expected for $ip", "http", address.scheme)
            }
    }

    @Test
    fun `public ipv4 defaults to https and refuses plain http`() {
        assertEquals("https", valid("8.8.8.8").scheme)
        assertTrue(invalid("http://8.8.8.8").contains("Plain HTTP"))
        assertTrue(invalid("http://example.com").contains("Plain HTTP"))
    }

    @Test
    fun `local hosts allow http`() {
        assertEquals("http", valid("printer.local").scheme)
        assertEquals("http", valid("printer.local:4000").scheme)
        assertEquals("http", valid("localhost").scheme)
    }

    @Test
    fun `fqdn trailing dot is normalized`() {
        val address = valid("my-pc.tailnet.ts.net.")
        assertEquals("my-pc.tailnet.ts.net", address.host)
        assertEquals("http", address.scheme)
    }

    @Test
    fun `bracketed ipv6 is accepted and rendered back with brackets`() {
        val ula = valid("[fd7a:115c:a1e0::1]:30177")
        assertEquals("fd7a:115c:a1e0::1", ula.host)
        assertEquals("http", ula.scheme)
        assertEquals("http://[fd7a:115c:a1e0::1]:30177", ula.origin)

        val loopback = valid("[::1]")
        assertEquals("http", loopback.scheme)
        assertEquals(30177, loopback.port)

        val public = valid("[2606:4700:4700::1111]")
        assertEquals("https", public.scheme)
        assertTrue(invalid("http://[2606:4700:4700::1111]").contains("Plain HTTP"))
    }

    @Test
    fun `one trailing slash is the copied root path and is accepted`() {
        assertEquals("http://192.168.178.20:30177", valid("http://192.168.178.20:30177/").origin)
        assertEquals("https://example.com:30177", valid("https://example.com/").origin)
        assertEquals("http://localhost:30177", valid("localhost:30177/").origin)
        assertTrue(invalid("example.com/path/").contains("path"))
        assertTrue(invalid("http://example.com//").contains("path"))
    }

    @Test
    fun `paths queries fragments and userinfo are rejected`() {
        assertTrue(invalid("example.com/path").contains("path"))
        assertTrue(invalid("http://example.com/path").contains("path"))
        assertTrue(invalid("example.com?x=1").contains("query"))
        assertTrue(invalid("http://example.com#frag").contains("fragment"))
        assertTrue(invalid("user@example.com").contains("username"))
        assertTrue(invalid("http://user:secret@example.com").contains("username"))
    }

    @Test
    fun `invalid ports are rejected`() {
        listOf("example.com:0", "example.com:65536", "example.com:abc", "example.com:", "example.com:-1")
            .forEach { input ->
                assertTrue("expected port rejection for $input", invalid(input).contains("port"))
            }
    }

    @Test
    fun `unsupported schemes are rejected`() {
        assertTrue(invalid("ftp://example.com").contains("http"))
        assertTrue(invalid("ws://example.com").contains("http"))
    }

    @Test
    fun `malformed ipv6 is rejected with a clear message`() {
        assertTrue(invalid("[fd7a::1").contains("bracket"))
        assertTrue(invalid("[fd7a::1]garbage").contains(":port"))
        assertTrue(invalid("[not-an-ipv6]").contains("IPv6"))
        assertTrue(invalid("fd7a::1").contains("brackets"))
    }

    @Test
    fun `garbage is rejected`() {
        assertTrue(invalid("").contains("Enter"))
        assertTrue(invalid("   ").contains("Enter"))
        assertTrue(invalid("http://").contains("Enter"))
        assertTrue(invalid("host name").contains("spaces"))
        assertTrue(invalid("-bad.example.com").contains("host name"))
        assertTrue(invalid("bad_.example.com").contains("host name"))
        assertTrue(invalid("example..com").contains("host name"))
        assertTrue(invalid("http://:30177").contains("Enter"))
    }
}
