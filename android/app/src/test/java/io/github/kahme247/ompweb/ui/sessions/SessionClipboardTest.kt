package io.github.kahme247.ompweb.ui.sessions

import android.content.ClipboardManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * B8/B28: session and archive ids reach the device clipboard through
 * [SessionExport.copyId]. The device clipboard is the only surface where the
 * copy can be observed, so this is a Robolectric test instead of a live step.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], application = android.app.Application::class)
class SessionClipboardTest {

    private val context: Context = ApplicationProvider.getApplicationContext()

    private val clipboard: ClipboardManager
        get() = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

    @Test
    fun aSessionIdIsCopiedToTheClipboard() {
        assertTrue(SessionExport.copyId(context, "sess-0123456789"))

        val clip = clipboard.primaryClip
        assertEquals("the id is the clip text", "sess-0123456789", clip?.getItemAt(0)?.text?.toString())
        assertEquals("the clip is labeled for Android 13's overlay", "session-id", clip?.description?.label?.toString())
    }

    @Test
    fun anArchiveEntryIdIsCopiedToTheClipboard() {
        // The archive browser's "Copy ID" action passes the same entry id into
        // the same helper; nothing about the archived state changes the path.
        assertTrue(SessionExport.copyId(context, "arch-42"))

        assertEquals("arch-42", clipboard.primaryClip?.getItemAt(0)?.text?.toString())
    }
}
