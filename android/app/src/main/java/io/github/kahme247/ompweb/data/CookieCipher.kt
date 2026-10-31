package io.github.kahme247.ompweb.data

import java.util.Base64
import java.security.GeneralSecurityException
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Encrypts the stored session cookie.
 *
 * Behind an interface so the framing can be unit-tested on the JVM with a
 * software key while the app uses an Android Keystore key that never leaves
 * the device (and is excluded from cloud backup with `allowBackup="false"`).
 */
interface CookieCipher {
    fun encrypt(plaintext: ByteArray): ByteArray
    fun decrypt(payload: ByteArray): ByteArray
}

/**
 * AES-GCM with a random IV per message. The payload is `iv || ciphertext ||
 * tag`; GCM's tag makes a tampered or foreign-key payload fail loudly instead
 * of decrypting into garbage.
 */
class AesGcmCipher(private val key: () -> SecretKey) : CookieCipher {

    override fun encrypt(plaintext: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        return cipher.iv + cipher.doFinal(plaintext)
    }

    override fun decrypt(payload: ByteArray): ByteArray {
        require(payload.size > IV_BYTES) { "Cookie payload is too short" }
        val iv = payload.copyOfRange(0, IV_BYTES)
        val body = payload.copyOfRange(IV_BYTES, payload.size)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, iv))
        return cipher.doFinal(body)
    }

    companion object {
        const val TRANSFORMATION = "AES/GCM/NoPadding"

        /** Android Keystore and JDK both generate 12-byte GCM IVs by default. */
        const val IV_BYTES = 12
        const val TAG_BITS = 128
    }
}

/**
 * One cookie as it is persisted, together with the origin that set it
 * (`scheme://host:port`). The origin tag is what keeps a cookie from a server
 * the user left from ever being sent to the next one.
 */
@Serializable
data class StoredCookie(
    val name: String,
    val value: String,
    val expiresAtMillis: Long,
    val domain: String,
    val path: String,
    val secure: Boolean,
    val httpOnly: Boolean,
    /** Empty for records written before origins were stored; such rows never match. */
    val origin: String = "",
)

/** Where [OriginBoundCookieJar] keeps its cookies between requests and launches. */
interface CookieRecords {
    fun load(): List<StoredCookie>
    fun save(cookies: List<StoredCookie>)
}

/**
 * Persists cookies as one AES-GCM-encrypted JSON document. A missing file, a
 * corrupt payload or a payload encrypted with another key (for example after
 * the Keystore key was invalidated) is treated as "signed out", never as an
 * error the user has to resolve.
 */
class EncryptedCookieRecords(
    private val file: java.io.File,
    private val cipher: CookieCipher,
) : CookieRecords {

    private val json = Json { ignoreUnknownKeys = true }

    @Synchronized
    override fun load(): List<StoredCookie> {
        if (!file.isFile) return emptyList()
        return try {
            val plain = cipher.decrypt(Base64.getDecoder().decode(file.readBytes()))
            json.decodeFromString<List<StoredCookie>>(plain.toString(Charsets.UTF_8))
        } catch (_: GeneralSecurityException) {
            emptyList()
        } catch (_: IllegalArgumentException) {
            emptyList()
        } catch (_: java.io.IOException) {
            emptyList()
        } catch (_: kotlinx.serialization.SerializationException) {
            emptyList()
        }
    }

    @Synchronized
    override fun save(cookies: List<StoredCookie>) {
        if (cookies.isEmpty()) {
            file.delete()
            if (file.exists()) {
                // A failed delete must not resurrect a signed-out session
                // after the next launch: overwrite with an encrypted empty list.
                file.writeBytes(Base64.getEncoder().encode(cipher.encrypt(EMPTY_LIST)))
            }
            return
        }
        val plain = json.encodeToString(cookies).toByteArray(Charsets.UTF_8)
        file.writeBytes(Base64.getEncoder().encode(cipher.encrypt(plain)))
    }

    private companion object {
        val EMPTY_LIST = "[]".toByteArray(Charsets.UTF_8)
    }
}

/** Cookie storage backed by a map; used by JVM tests. */
class InMemoryCookieRecords(initial: List<StoredCookie> = emptyList()) : CookieRecords {
    private var cookies: List<StoredCookie> = initial

    override fun load(): List<StoredCookie> = cookies

    override fun save(cookies: List<StoredCookie>) {
        this.cookies = cookies
    }
}
