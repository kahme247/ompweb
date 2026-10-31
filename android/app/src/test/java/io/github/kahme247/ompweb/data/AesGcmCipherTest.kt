package io.github.kahme247.ompweb.data

import java.io.File
import java.security.GeneralSecurityException
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class AesGcmCipherTest {

    @get:Rule
    val folder = TemporaryFolder()

    private val key = SecretKeySpec(ByteArray(32) { it.toByte() }, "AES")
    private val cipher = AesGcmCipher { key }

    private val cookie = StoredCookie(
        name = "omp_web_session",
        value = "header.payload.signature",
        expiresAtMillis = 4_000_000_000_000L,
        domain = "100.64.0.10",
        path = "/",
        secure = false,
        httpOnly = true,
    )

    @Test
    fun `round trip returns the plaintext`() {
        val plain = "session=secret".toByteArray()

        assertArrayEquals(plain, cipher.decrypt(cipher.encrypt(plain)))
    }

    @Test
    fun `every encryption uses a fresh iv`() {
        val plain = "session=secret".toByteArray()

        val first = cipher.encrypt(plain)
        val second = cipher.encrypt(plain)

        assertEquals(AesGcmCipher.IV_BYTES + plain.size + AesGcmCipher.TAG_BITS / 8, first.size)
        assertFalse(first.contentEquals(second))
    }

    @Test
    fun `a foreign key cannot decrypt`() {
        val payload = cipher.encrypt("session=secret".toByteArray())
        val other = AesGcmCipher { SecretKeySpec(ByteArray(32) { (it + 1).toByte() }, "AES") }

        assertThrows(GeneralSecurityException::class.java) { other.decrypt(payload) }
    }

    @Test
    fun `tampered ciphertext is refused`() {
        val payload = cipher.encrypt("session=secret".toByteArray())
        payload[payload.size - 1] = (payload[payload.size - 1].toInt() xor 0x01).toByte()

        assertThrows(GeneralSecurityException::class.java) { cipher.decrypt(payload) }
    }

    @Test
    fun `records are encrypted on disk and can be read back`() {
        val file = File(folder.root, "cookies.bin")
        EncryptedCookieRecords(file, cipher).save(listOf(cookie))

        val raw = file.readBytes()
        assertFalse(String(raw, Charsets.UTF_8).contains("omp_web_session"))
        assertFalse(String(raw, Charsets.UTF_8).contains("header.payload.signature"))
        assertEquals(listOf(cookie), EncryptedCookieRecords(file, cipher).load())
    }

    @Test
    fun `a file with a foreign key reads as signed out`() {
        val file = File(folder.root, "cookies.bin")
        EncryptedCookieRecords(file, cipher).save(listOf(cookie))
        val other = AesGcmCipher { SecretKeySpec(ByteArray(32) { (it + 1).toByte() }, "AES") }

        assertTrue(EncryptedCookieRecords(file, other).load().isEmpty())
    }

    @Test
    fun `corrupt bytes read as signed out`() {
        val file = File(folder.root, "cookies.bin")
        file.writeText("not a cookie document")

        assertTrue(EncryptedCookieRecords(file, cipher).load().isEmpty())
    }

    @Test
    fun `an empty list deletes the file`() {
        val file = File(folder.root, "cookies.bin")
        val records = EncryptedCookieRecords(file, cipher)
        records.save(listOf(cookie))

        records.save(emptyList())

        assertFalse(file.exists())
        assertTrue(records.load().isEmpty())
    }
}
