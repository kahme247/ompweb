package io.github.kahme247.ompweb.ui.files

import android.content.Context
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import io.github.kahme247.ompweb.ui.sessions.SessionExport
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * B30: the download/share "Save as" path. The SAF URI is the only file target
 * the app can write to without a storage permission, so the bytes must arrive
 * in the picked document's stream (`FileTransfer.writeToUri` with mode `wt`).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], application = android.app.Application::class)
class SessionExportTest {

    private val context: Context = ApplicationProvider.getApplicationContext()

    @Test
    fun writesToPickedUri() {
        val uri = Uri.parse("content://com.android.providers.downloads.documents/document/42")
        val sink = ByteArrayOutputStream()
        shadowOf(context.contentResolver).registerOutputStream(uri, sink)
        val bytes = "<!doctype html><p>export</p>".toByteArray()

        val written = runBlocking { SessionExport.writeToUri(context, uri, bytes) }

        assertTrue(written)
        assertArrayEquals(bytes, sink.toByteArray())
    }

    @Test
    fun reportsFailureWhenTheProviderRefuses() {
        val uri = Uri.parse("content://com.android.providers.downloads.documents/document/unknown")
        // No stream registered for this URI: openOutputStream throws, and the
        // caller must hear false rather than crash the share flow.
        assertFalse(runBlocking { SessionExport.writeToUri(context, uri, byteArrayOf(1)) })
    }
}
