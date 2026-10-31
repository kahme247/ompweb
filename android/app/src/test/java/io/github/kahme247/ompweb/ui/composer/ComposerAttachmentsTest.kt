package io.github.kahme247.ompweb.ui.composer

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.util.Base64
import androidx.test.core.app.ApplicationProvider
import java.io.ByteArrayInputStream
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * B14: the composer's clipboard paste. A clipboard image becomes a
 * [io.github.kahme247.ompweb.domain.ComposerImage] with the detected raster
 * type; plain text never turns into an image, and an empty clipboard reports
 * "no image" so the menu entry stays hidden.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], application = android.app.Application::class)
class ComposerAttachmentsTest {

    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

    /** A 1×1 transparent PNG. */
    private val png = Base64.decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        Base64.DEFAULT,
    )

    private fun clipboardUri(path: String = "clipboard-1"): Uri {
        val uri = Uri.parse("content://io.github.kahme247.ompweb.test/$path")
        shadowOf(context.contentResolver)
            .registerInputStreamSupplier(uri) { ByteArrayInputStream(png) }
        clipboard.setPrimaryClip(ClipData.newRawUri("pasted", uri))
        return uri
    }

    @Test
    fun aClipboardImageBecomesAnImageAttachment() = runTest {
        val uri = clipboardUri()

        assertTrue(ComposerAttachments.hasClipboardImage(context))
        val image = ComposerAttachments.clipboardImage(context)

        assertNotNull("the pasted raster is attached", image)
        assertEquals("image/png", image?.mimeType)
        assertTrue(
            "the attachment carries the pasted bytes",
            Base64.decode(image?.data, Base64.NO_WRAP).contentEquals(png),
        )
        assertEquals(uri, clipboard.primaryClip?.getItemAt(0)?.uri)
    }

    @Test
    fun plainTextIsNotAnImage() = runTest {
        clipboard.setPrimaryClip(ClipData.newPlainText("copied", "just words"))

        assertFalse(ComposerAttachments.hasClipboardImage(context))
        assertNull(ComposerAttachments.clipboardImage(context))
    }

    @Test
    fun anEmptyClipboardReportsNoImage() = runTest {
        clipboard.clearPrimaryClip()

        assertFalse(ComposerAttachments.hasClipboardImage(context))
        assertNull(ComposerAttachments.clipboardImage(context))
    }
}
