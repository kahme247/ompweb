package io.github.kahme247.ompweb.notify

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * X10: the exported `MainActivity` accepts an "open session" intent only with
 * the HMAC token our own PendingIntents set. These tests pin the token rule;
 * the `Context` overloads only add the private per-installation secret.
 */
class NotificationOpenTokenTest {

    private val secret = ByteArray(32) { it.toByte() }

    @Test
    fun `a token verifies for the session it was minted for`() {
        val token = NotificationOpenToken.sign(secret, "sess-1")
        assertTrue(token.isNotEmpty())
        assertTrue(NotificationOpenToken.verify(secret, "sess-1", token))
        // Stable: signing again yields the same token.
        assertEquals(token, NotificationOpenToken.sign(secret, "sess-1"))
        // base64url without padding, as it travels in an Intent extra.
        assertFalse(token.contains('='))
        assertFalse(token.contains('+'))
        assertFalse(token.contains('/'))
    }

    @Test
    fun `a token of one session does not open another`() {
        val token = NotificationOpenToken.sign(secret, "sess-1")
        assertNotEquals(token, NotificationOpenToken.sign(secret, "sess-2"))
        assertFalse(NotificationOpenToken.verify(secret, "sess-2", token))
    }

    @Test
    fun `a token of another installation is rejected`() {
        val token = NotificationOpenToken.sign(ByteArray(32) { (it + 1).toByte() }, "sess-1")
        assertFalse(NotificationOpenToken.verify(secret, "sess-1", token))
    }

    @Test
    fun `missing, empty and tampered tokens are rejected`() {
        val token = NotificationOpenToken.sign(secret, "sess-1")
        assertFalse(NotificationOpenToken.verify(secret, "sess-1", null))
        assertFalse(NotificationOpenToken.verify(secret, "sess-1", ""))
        assertFalse(NotificationOpenToken.verify(secret, "", ""))
        assertFalse(NotificationOpenToken.verify(secret, "", token))
        val tampered = if (token.last() == 'A') token.dropLast(1) + "B" else token.dropLast(1) + "A"
        assertFalse(NotificationOpenToken.verify(secret, "sess-1", tampered))
        assertFalse(NotificationOpenToken.verify(secret, "sess-1", token + "x"))
    }

    @Test
    fun `an empty session id cannot be signed`() {
        assertEquals("", NotificationOpenToken.sign(secret, ""))
    }
}
