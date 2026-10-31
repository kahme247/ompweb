package io.github.kahme247.ompweb.ui.render

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.PersistableBundle

/**
 * A Binder transaction cannot carry arbitrarily long text: an oversized clip
 * throws out of the clipboard binding and the copy silently fails.
 */
const val MAX_CLIPBOARD_CHARS = 100_000

/**
 * Copies [text] and reports whether the clipboard accepted it. [sensitive]
 * marks the clip so Android 13+ hides its preview and other apps cannot read
 * it; text above [MAX_CLIPBOARD_CHARS] is truncated for the same Binder
 * reason.
 */
fun copyTextToClipboard(
    context: Context,
    label: String,
    text: String,
    sensitive: Boolean = true,
): Boolean {
    val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return false
    return try {
        val clip = ClipData.newPlainText(label, text.take(MAX_CLIPBOARD_CHARS))
        if (sensitive && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            clip.description.extras = PersistableBundle().apply {
                putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
            }
        }
        clipboard.setPrimaryClip(clip)
        true
    } catch (_: Exception) {
        false
    }
}
