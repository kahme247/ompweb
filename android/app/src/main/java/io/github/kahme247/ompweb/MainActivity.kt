package io.github.kahme247.ompweb

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import io.github.kahme247.ompweb.notify.NotificationIntents
import io.github.kahme247.ompweb.notify.NotificationOpenToken
import io.github.kahme247.ompweb.ui.OmpWebRoot

/**
 * Single activity. Besides the launcher entry it is a share target
 * (`ACTION_SEND`/`ACTION_SEND_MULTIPLE`): the incoming stream URIs land in the
 * container and the sessions screen asks which chat should receive them.
 */
class MainActivity : ComponentActivity() {

    private lateinit var container: AppContainer

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        container = (application as OmpWebApplication).container
        offerShare(intent)
        offerSession(intent)
        offerLink(intent)
        setContent {
            OmpWebRoot(container)
        }
    }

    /** `singleTop`: sharing from another app reuses this task instead of stacking. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        offerShare(intent)
        offerSession(intent)
        offerLink(intent)
    }

    /**
     * A VIEW intent for `ompweb://session/<id>` or `ompweb://cwd?path=…`.
     *
     * Any app may send these (that is what a share link is for), so the only
     * trust anchor is the optional `origin` query parameter: a link minted for
     * another server is consumed without effect by the container. A link
     * without an origin is bound to the configured server when it is
     * consumed. The data is cleared afterwards so a recreation (rotation) does
     * not open it twice.
     */
    private fun offerLink(source: Intent?) {
        if (source?.action != Intent.ACTION_VIEW) return
        val link = parseShellLink(source.data) ?: return
        source.data = null
        when (link) {
            is ShellLink.Session -> container.offerSessionOpen(link.sessionId, link.origin)
            is ShellLink.Workspace -> container.offerCwdOpen(link.path, link.origin)
        }
    }

    /**
     * A notification tap asks for one session. The activity is exported (share
     * target), so an explicit intent with a session id from any app must not
     * force a chat open: only the HMAC token of our own PendingIntent is
     * accepted. The extras are removed so a recreation (rotation) does not
     * reopen the session.
     */
    private fun offerSession(source: Intent?) {
        val sessionId = source?.getStringExtra(NotificationIntents.EXTRA_SESSION_ID)?.takeIf { it.isNotBlank() }
            ?: return
        val token = source.getStringExtra(NotificationIntents.EXTRA_OPEN_TOKEN)
        val origin = source.getStringExtra(NotificationIntents.EXTRA_ORIGIN)
        source.removeExtra(NotificationIntents.EXTRA_SESSION_ID)
        source.removeExtra(NotificationIntents.EXTRA_OPEN_TOKEN)
        source.removeExtra(NotificationIntents.EXTRA_ORIGIN)
        if (!NotificationOpenToken.verify(this, sessionId, token)) return
        container.offerSessionOpen(sessionId, origin)
    }

    /**
     * Hand the share payload to the container once, then strip it from the
     * intent: the same intent is redelivered when the activity is recreated
     * (rotation), and offering it again would attach the files twice.
     */
    private fun offerShare(source: Intent?) {
        val uris = streamUris(source)
        if (uris.isEmpty()) return
        container.offerShare(uris)
        source?.apply {
            action = null
            clipData = null
            @Suppress("DEPRECATION")
            removeExtra(Intent.EXTRA_STREAM)
        }
    }

    private fun streamUris(intent: Intent?): List<Uri> {
        if (intent == null) return emptyList()
        // Only share actions carry streams; a launcher intent with stale clip
        // data must not produce attachments.
        if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) {
            return emptyList()
        }
        @Suppress("DEPRECATION")
        val fromExtra: List<Uri> = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(intent.getParcelableExtra(Intent.EXTRA_STREAM))
            else -> intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
        }
        val candidates = fromExtra.ifEmpty {
            // Some apps only fill the clip data.
            val clip = intent.clipData ?: return emptyList()
            (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
        }
        // `file://` URIs would bypass the content resolver's grants and make
        // the app read arbitrary paths; accept only provider content.
        return candidates.filter { uri ->
            uri.scheme?.equals(ContentResolver.SCHEME_CONTENT, ignoreCase = true) == true
        }
    }
}

/** The scheme the app registers for share links (`AndroidManifest.xml`). */
internal const val LINK_SCHEME = "ompweb"

/** What a VIEW intent asks the app to open. */
internal sealed interface ShellLink {
    data class Session(val sessionId: String, val origin: String?) : ShellLink

    data class Workspace(val path: String, val origin: String?) : ShellLink
}

/** Session ids are omp's file stems; anything else cannot be a session. */
private val SESSION_ID_PATTERN = Regex("[A-Za-z0-9._-]{1,128}")

/** A workspace path from a link is bounded like a `cwd` argument. */
private const val MAX_LINK_PATH_LENGTH = 4096

/**
 * Parses `ompweb://session/<id>[?origin=…]` and
 * `ompweb://cwd?path=<path>[&origin=…]`. Returns null for every other URI, so
 * a malformed link is ignored instead of opening an arbitrary view.
 */
internal fun parseShellLink(data: Uri?): ShellLink? {
    if (data == null) return null
    if (!data.scheme.equals(LINK_SCHEME, ignoreCase = true)) return null
    val origin = data.getQueryParameter("origin")?.takeIf { it.isNotBlank() }
    return when (data.host?.lowercase()) {
        "session" -> {
            val id = data.pathSegments.firstOrNull { it.isNotBlank() }
                ?: data.getQueryParameter("id")
            id?.takeIf { SESSION_ID_PATTERN.matches(it) }?.let { ShellLink.Session(it, origin) }
        }
        "cwd" -> {
            val fromQuery = data.getQueryParameter("path")
            val fromPath = data.pathSegments
                .filter { it.isNotBlank() }
                .joinToString("/")
                .let { if (it.isEmpty()) null else "/$it" }
            (fromQuery ?: fromPath)
                ?.takeIf { it.isNotBlank() && it.length <= MAX_LINK_PATH_LENGTH }
                ?.let { ShellLink.Workspace(it, origin) }
        }
        else -> null
    }
}
