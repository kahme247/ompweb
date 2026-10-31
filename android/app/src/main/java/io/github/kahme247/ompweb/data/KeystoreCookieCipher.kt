package io.github.kahme247.ompweb.data

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/**
 * The app's only cookie key: AES-256-GCM in the Android Keystore. The key
 * material never leaves the device and is not part of any backup, so a copied
 * settings file is useless without this device.
 */
class KeystoreCookieCipher : CookieCipher {

    private val delegate = AesGcmCipher(::key)

    override fun encrypt(plaintext: ByteArray): ByteArray = delegate.encrypt(plaintext)

    override fun decrypt(payload: ByteArray): ByteArray = delegate.decrypt(payload)

    private fun key(): SecretKey {
        val store = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
        val existing = (store.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey
        if (existing != null) return existing
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val ANDROID_KEY_STORE = "AndroidKeyStore"
        const val KEY_ALIAS = "ompweb-session-cookie"
    }
}
