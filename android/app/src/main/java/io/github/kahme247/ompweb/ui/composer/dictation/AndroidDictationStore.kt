package io.github.kahme247.ompweb.ui.composer.dictation

import android.content.Context
import androidx.core.content.edit
import io.github.kahme247.ompweb.domain.DictationStore
import io.github.kahme247.ompweb.domain.LocalRecording
import io.github.kahme247.ompweb.domain.SttAfter
import java.io.File
import java.security.SecureRandom

/**
 * [DictationStore] on the app's private storage.
 *
 * The owner token is the web's `omp-web:stt-owner-token`: one identity per
 * install that owns the jobs this app uploads, gets the first claim and alone
 * gets the send/queue choice back. The kept recording is the local copy the
 * retry path re-uploads when the server lost the job (restart, expiry); it
 * lives in the cache and is deleted as soon as the transcript is delivered or
 * discarded.
 */
class AndroidDictationStore(context: Context) : DictationStore {

    private val appContext = context.applicationContext
    private val preferences = appContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    private val directory = File(appContext.cacheDir, DIRECTORY)

    override fun ownerToken(): String {
        val existing = preferences.getString(KEY_OWNER_TOKEN, null)
        if (!existing.isNullOrBlank()) return existing
        val token = randomToken()
        preferences.edit { putString(KEY_OWNER_TOKEN, token) }
        return token
    }

    override fun scratchFile(name: String): File {
        ensureDirectory()
        return File(directory, name.substringAfterLast('/').substringAfterLast('\\'))
    }

    override fun keepRecording(scope: String, file: File, mimeType: String, after: SttAfter) {
        // A new recording replaces the previous kept one (web: pendingAudioRef).
        clearRecording()
        preferences.edit {
            putString(KEY_KEPT_SCOPE, scope)
            putString(KEY_KEPT_PATH, file.absolutePath)
            putString(KEY_KEPT_MIME, mimeType)
            putString(KEY_KEPT_AFTER, after.name)
        }
    }

    override fun savedRecording(scope: String): LocalRecording? {
        if (preferences.getString(KEY_KEPT_SCOPE, null) != scope) return null
        val path = preferences.getString(KEY_KEPT_PATH, null) ?: return null
        val file = File(path)
        if (!file.isFile || file.length() == 0L) {
            clearRecording()
            return null
        }
        val mimeType = preferences.getString(KEY_KEPT_MIME, null) ?: AUDIO_MP4
        val after = preferences.getString(KEY_KEPT_AFTER, null)
            ?.let { name -> SttAfter.entries.firstOrNull { it.name == name } }
            ?: SttAfter.Insert
        return LocalRecording(file, mimeType, after)
    }

    override fun clearRecording() {
        val path = preferences.getString(KEY_KEPT_PATH, null)
        if (path != null) File(path).delete()
        preferences.edit {
            remove(KEY_KEPT_PATH)
            remove(KEY_KEPT_SCOPE)
            remove(KEY_KEPT_MIME)
            remove(KEY_KEPT_AFTER)
        }
    }

    /**
     * Delete recordings and playback copies left behind by process death. The
     * kept recording (the retry fallback) is not touched.
     */
    fun purgeOrphans() {
        val kept = preferences.getString(KEY_KEPT_PATH, null)?.let { File(it).absolutePath }
        val files = directory.listFiles() ?: return
        for (file in files) {
            if (file.isFile && file.absolutePath != kept) file.delete()
        }
    }

    private fun ensureDirectory() {
        if (!directory.isDirectory) directory.mkdirs()
    }

    private fun randomToken(): String {
        val bytes = ByteArray(16)
        SecureRandom().nextBytes(bytes)
        // Mask each byte: a signed byte would otherwise format as a negative
        // long ("ffffff80") and stretch the token past the server's 128-char cap.
        return bytes.joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
    }

    private companion object {
        const val PREFERENCES = "ompweb-dictation"

        /** The web's sessionStorage key, kept verbatim so the intent is obvious. */
        const val KEY_OWNER_TOKEN = "omp-web:stt-owner-token"
        const val KEY_KEPT_PATH = "kept-path"
        const val KEY_KEPT_SCOPE = "kept-scope"
        const val KEY_KEPT_MIME = "kept-mime"
        const val KEY_KEPT_AFTER = "kept-after"
        const val DIRECTORY = "dictation"
        const val AUDIO_MP4 = "audio/mp4"
    }
}
