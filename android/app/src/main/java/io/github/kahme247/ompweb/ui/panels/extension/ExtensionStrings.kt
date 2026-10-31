package io.github.kahme247.ompweb.ui.panels.extension

import android.content.Context
import io.github.kahme247.ompweb.R

/**
 * Localized text the extension controllers need but cannot read themselves
 * (they hold no `Context`). Resolved once from a context; the defaults are the
 * English copy of `strings_extension.xml`.
 */
data class ExtensionStrings(
    val openInBrowserTemplate: String = "Open in your browser: %1\$s",
    val unsafeUrlBlockedTemplate: String = "Blocked an unsafe URL %1\$s",
    val notificationFallbackTemplate: String = "%1\$s: %2\$s",
    val clipboardReadNotice: String = "An extension read your clipboard",
    val clipboardWriteNotice: String = "An extension copied text to your clipboard",
) {
    fun openInBrowser(url: String): String = String.format(openInBrowserTemplate, url)

    fun unsafeUrlBlocked(url: String): String = String.format(unsafeUrlBlockedTemplate, url)

    /** Snackbar text when no system notification could be posted. */
    fun notificationFallback(title: String, message: String): String =
        if (message.isBlank()) title else String.format(notificationFallbackTemplate, title, message)

    companion object {
        fun from(context: Context): ExtensionStrings {
            val app = context.applicationContext
            return ExtensionStrings(
                openInBrowserTemplate = app.getString(R.string.extension_open_in_browser),
                unsafeUrlBlockedTemplate = app.getString(R.string.extension_unsafe_url_blocked),
                notificationFallbackTemplate = app.getString(R.string.extension_notification_fallback),
                clipboardReadNotice = app.getString(R.string.extension_clipboard_read_notice),
                clipboardWriteNotice = app.getString(R.string.extension_clipboard_write_notice),
            )
        }
    }
}
