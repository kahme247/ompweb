package io.github.kahme247.ompweb.ui.hosttools

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.net.toUri
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.ClipboardBridge
import io.github.kahme247.ompweb.domain.isSafeOpenUrl
import io.github.kahme247.ompweb.notify.AndroidNotifier
import io.github.kahme247.ompweb.ui.render.MAX_CLIPBOARD_CHARS

/**
 * The device clipboard behind `pi-web://clipboard`. Android 10+ only allows a
 * foreground app to read the clipboard, which is exactly the situation here:
 * the read happens while the user is looking at the chat.
 */
class AndroidClipboard(private val context: Context) : ClipboardBridge {

    override fun readText(): String? {
        val manager = context.getSystemService(ClipboardManager::class.java) ?: return null
        val clip = manager.primaryClip ?: return null
        if (clip.itemCount == 0) return null
        return clip.getItemAt(0).coerceToText(context)?.toString()
    }

    override fun writeText(text: String) {
        val manager = context.getSystemService(ClipboardManager::class.java)
            ?: throw IllegalStateException("Clipboard service unavailable")
        val clip = ClipData.newPlainText("ompweb", text.take(MAX_CLIPBOARD_CHARS))
        manager.setPrimaryClip(clip)
    }
}

/**
 * Opens an http(s) or mailto URL, the only schemes [isSafeOpenUrl] lets
 * through. Links open in a Custom Tab like every other external link in the
 * app; `mailto:` goes to the mail app through `ACTION_SENDTO`.
 */
fun openExternalUrl(context: Context, url: String) {
    if (!isSafeOpenUrl(url)) return
    val uri = url.toUri()
    try {
        if (uri.scheme.equals("mailto", ignoreCase = true)) {
            val intent = Intent(Intent.ACTION_SENDTO, uri)
            if (context !is android.app.Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        } else {
            val customTab = CustomTabsIntent.Builder().setShowTitle(true).build()
            if (context !is android.app.Activity) {
                customTab.intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            customTab.launchUrl(context, uri)
        }
    } catch (_: Exception) {
        Toast.makeText(context, R.string.chat_link_unavailable, Toast.LENGTH_SHORT).show()
    }
}

/**
 * Executes `open_url` and `notify` for the host-tool controller. `notify`
 * goes through the shared [AndroidNotifier] on the "Agent messages" channel
 * and reports whether the system accepted it; otherwise the caller falls back
 * to an in-app notice.
 */
class AndroidHostToolOpener(private val context: Context) : HostToolOpener {

    // Host-tool `notify` has no session and no answer action, so it carries no
    // origin: its content intent only opens the app.
    private val notifier = AndroidNotifier(context.applicationContext, origin = { null })

    override fun openUrl(url: String) {
        openExternalUrl(context, url)
    }

    override fun notify(title: String, message: String): Boolean =
        notifier.postAgentMessage(title, message)
}
