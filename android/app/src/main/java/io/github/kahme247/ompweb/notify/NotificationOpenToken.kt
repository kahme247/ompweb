package io.github.kahme247.ompweb.notify

import android.content.Context
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Proof that a "open this session" intent came from one of our own
 * notification PendingIntents.
 *
 * `MainActivity` has to stay exported (share target), so an explicit intent
 * with `EXTRA_SESSION_ID` from any app would otherwise force a chat open. The
 * token is an HMAC of the session id under a per-installation secret that only
 * this app's private `SharedPreferences` holds: a foreign app can neither read
 * the secret nor guess the token, and a leaked token is bound to that one
 * session id.
 *
 * The HMAC itself takes the key as a parameter, so the rule is pinned by JVM
 * tests; only [sign]/[verify] with a `Context` reach the private preferences.
 */
object NotificationOpenToken {

    private const val PREFS = "ompweb-notification-open"
    private const val KEY_SECRET = "secret"
    private const val ALGORITHM = "HmacSHA256"
    private const val SECRET_BYTES = 32

    /** The token that belongs into [NotificationIntents.EXTRA_OPEN_TOKEN]. */
    fun sign(context: Context, sessionId: String): String = sign(secret(context), sessionId)

    /** Constant-time check of a token that arrived with an exported intent. */
    fun verify(context: Context, sessionId: String, token: String?): Boolean =
        verify(secret(context), sessionId, token)

    /** Token of [sessionId] under [secret]; an empty id can never be signed. */
    fun sign(secret: ByteArray, sessionId: String): String {
        if (sessionId.isEmpty()) return ""
        val mac = Mac.getInstance(ALGORITHM).apply {
            init(SecretKeySpec(secret, ALGORITHM))
        }
        return Base64.getUrlEncoder().withoutPadding().encodeToString(mac.doFinal(sessionId.toByteArray()))
    }

    /** True only for the token [sign] produced for this secret and session id. */
    fun verify(secret: ByteArray, sessionId: String, token: String?): Boolean {
        if (sessionId.isEmpty() || token.isNullOrEmpty()) return false
        return MessageDigest.isEqual(sign(secret, sessionId).toByteArray(), token.toByteArray())
    }

    @Synchronized
    private fun secret(context: Context): ByteArray {
        val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        decode(prefs.getString(KEY_SECRET, null))?.let { return it }
        val created = ByteArray(SECRET_BYTES).also(SecureRandom()::nextBytes)
        prefs.edit()
            .putString(KEY_SECRET, Base64.getUrlEncoder().withoutPadding().encodeToString(created))
            .apply()
        return created
    }

    private fun decode(value: String?): ByteArray? = value
        ?.let { encoded -> runCatching { Base64.getUrlDecoder().decode(encoded) }.getOrNull() }
        ?.takeIf { it.size >= SECRET_BYTES }
}
