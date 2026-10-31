package io.github.kahme247.ompweb.ui.composer.dictation

import io.github.kahme247.ompweb.data.SettingsSnapshot
import io.github.kahme247.ompweb.domain.DictationEngine
import io.github.kahme247.ompweb.domain.DictationState
import io.github.kahme247.ompweb.domain.SttAfter
import io.github.kahme247.ompweb.net.ServerAddress
import io.github.kahme247.ompweb.net.SttApi
import io.github.kahme247.ompweb.net.SttStartOutcome
import io.github.kahme247.ompweb.testutil.FakeOnDeviceStt
import io.github.kahme247.ompweb.testutil.FakeSttApi
import io.github.kahme247.ompweb.testutil.MemoryDictationStore
import java.util.Locale
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Engine selection and the on-device live flow: no recorder and no server job
 * for on-device dictation, live partials into the attached field at the caret,
 * a final transcript on stop, and clear failures.
 */
class DictationViewModelTest {

    private var now = 1_000L
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    private val strings = DictationStrings(
        noRecognizer = "no recognizer",
        offline = "offline",
        micUnavailable = "no recorder",
        noSpeech = "no speech",
    )

    @After
    fun tearDown() {
        scope.cancel()
    }

    private val speech = FakeOnDeviceStt()
    private val api = CountingSttApi()

    private var text = "Reply with"
    private var caret = text.length

    private fun viewModel(settings: SettingsSnapshot): DictationViewModel {
        text = "Reply with"
        caret = text.length
        return DictationViewModel(
            api = api,
            store = MemoryDictationStore(),
            scope = scope,
            strings = strings,
            clock = { now },
            settings = MutableStateFlow(settings),
            onDevice = speech,
            deviceLocale = Locale.GERMANY,
        ).also { vm ->
            vm.attachLiveField(
                text = { text },
                caret = { caret },
                apply = { next, nextCaret ->
                    text = next
                    caret = nextCaret
                },
            )
        }
    }

    @Test
    fun `the next engine mirrors the setting and the server state`() {
        val onDevice = viewModel(SettingsSnapshot(loaded = true, dictationEngine = "on_device"))
        assertEquals(DictationEngine.ON_DEVICE, onDevice.nextEngine())

        val autoWithoutServer = viewModel(SettingsSnapshot(loaded = true, dictationEngine = "auto"))
        assertEquals(
            "auto without an origin never records for a server",
            DictationEngine.ON_DEVICE,
            autoWithoutServer.nextEngine(),
        )

        val autoWithServer = viewModel(
            SettingsSnapshot(
                loaded = true,
                origin = ServerAddress(scheme = "http", host = "127.0.0.1", port = 3000),
                dictationEngine = "auto",
            ),
        )
        assertEquals(DictationEngine.SERVER, autoWithServer.nextEngine())

        val server = viewModel(
            SettingsSnapshot(
                loaded = true,
                origin = ServerAddress(scheme = "http", host = "127.0.0.1", port = 3000),
                dictationEngine = "server",
            ),
        )
        assertEquals(DictationEngine.SERVER, server.nextEngine())
    }

    @Test
    fun `the picked language reaches the recognizer and falls back to the device`() {
        val picked = viewModel(
            SettingsSnapshot(loaded = true, dictationEngine = "on_device", dictationLanguage = "fr-FR"),
        )
        picked.start(SttAfter.Insert)
        assertEquals("the explicit pick wins", "fr-FR", speech.language)

        val broken = viewModel(
            SettingsSnapshot(loaded = true, dictationEngine = "on_device", dictationLanguage = "not a tag"),
        )
        broken.start(SttAfter.Insert)
        assertEquals("a malformed pick uses the device language", "de-DE", speech.language)
    }

    @Test
    fun `on-device dictation types live partials at the caret without a server job`() {
        val vm = viewModel(SettingsSnapshot(loaded = true, dictationEngine = "on_device"))

        vm.start(SttAfter.Insert)
        assertTrue("the live state keeps the field visible", vm.state.value is DictationState.Live)
        assertEquals("the device language is the default recognition language", "de-DE", speech.language)

        speech.listener!!.onPartial("hallo")
        assertEquals("Reply with hallo", text)
        assertEquals(16, caret)

        speech.listener!!.onPartial("hallo du")
        assertEquals("the partial is replaced, not appended", "Reply with hallo du", text)

        speech.listener!!.onFinal("Hallo du.")
        assertEquals("Reply with Hallo du.", text)
        assertTrue(vm.state.value is DictationState.Idle)
        assertEquals("on-device dictation never uploads audio", 0, api.starts)
        assertTrue("the recognizer is released after the transcript", speech.released)
    }

    @Test
    fun `auto without a configured server uses the phone`() {
        val vm = viewModel(SettingsSnapshot(loaded = true))

        vm.start(SttAfter.Insert)
        assertTrue(vm.state.value is DictationState.Live)
        assertEquals("de-DE", speech.language)
        assertEquals(0, api.starts)
    }

    @Test
    fun `auto with a configured server keeps the server path`() {
        val vm = viewModel(
            SettingsSnapshot(
                loaded = true,
                origin = ServerAddress(scheme = "http", host = "127.0.0.1", port = 8080),
            ),
        )

        vm.start(SttAfter.Insert)
        assertNull("the recognizer is not started", speech.listener)
        assertFalse("no on-device state", vm.state.value is DictationState.Live)
        assertEquals("nothing reaches the server without audio", 0, api.starts)
    }

    @Test
    fun `an explicit server engine ignores the phone recognizer`() {
        val vm = viewModel(SettingsSnapshot(loaded = true, dictationEngine = "server"))

        vm.start(SttAfter.Insert)
        assertNull(speech.listener)
        assertFalse(vm.state.value is DictationState.Live)
    }

    @Test
    fun `a missing recognizer fails with a clear message`() {
        speech.available = false
        val vm = viewModel(SettingsSnapshot(loaded = true, dictationEngine = "on_device"))

        vm.start(SttAfter.Insert)
        val state = vm.state.value as DictationState.Failed
        assertEquals("no recognizer", state.message)
        assertFalse(state.canRetry)
        assertEquals("the field is untouched", "Reply with", text)
        assertFalse("no recognizer is created when no model is installed", speech.started)
        assertNull(speech.listener)
    }

    @Test
    fun `auto without a model keeps the server path instead of a recognizer`() {
        speech.available = false
        val vm = viewModel(
            SettingsSnapshot(
                loaded = true,
                origin = ServerAddress(scheme = "http", host = "127.0.0.1", port = 3000),
                dictationEngine = "auto",
            ),
        )

        assertEquals("a configured server is the fallback", DictationEngine.SERVER, vm.nextEngine())
        vm.start(SttAfter.Insert)
        assertFalse("the network recognizer never runs", speech.started)
        assertNull(speech.listener)
        assertFalse("no live state without a model", vm.state.value is DictationState.Live)
    }

    @Test
    fun `backgrounding commits the live partial and destroys the recognizer`() {
        val vm = viewModel(SettingsSnapshot(loaded = true, dictationEngine = "on_device"))
        vm.start(SttAfter.Insert)
        speech.listener!!.onPartial("hallo")

        vm.setVisible(false)

        assertEquals("what was said becomes draft text", "Reply with hallo", text)
        assertTrue("the live state ends", vm.state.value is DictationState.Idle)
        assertTrue("the recognizer is destroyed on ON_STOP", speech.released)
    }

    @Test
    fun `auto without a server and without a model fails instead of using the network`() {
        speech.available = false
        val vm = viewModel(SettingsSnapshot(loaded = true, dictationEngine = "auto"))

        vm.start(SttAfter.Insert)
        val state = vm.state.value as DictationState.Failed
        assertEquals("no recognizer", state.message)
        assertEquals("nothing was uploaded", 0, api.starts)
        assertNull("no cloud recognizer was started", speech.listener)
    }

    @Test
    fun `recognition errors keep the spoken text and name the cause`() {
        val vm = viewModel(SettingsSnapshot(loaded = true, dictationEngine = "on_device"))
        vm.start(SttAfter.Insert)
        speech.listener!!.onPartial("hallo")

        speech.listener!!.onError(OnDeviceSttError.Offline)
        assertEquals("what was said stays as draft text", "Reply with hallo", text)
        assertEquals("offline", (vm.state.value as DictationState.Failed).message)
    }

    @Test
    fun `silence without any word reports no speech`() {
        val vm = viewModel(SettingsSnapshot(loaded = true, dictationEngine = "on_device"))
        vm.start(SttAfter.Insert)

        speech.listener!!.onError(OnDeviceSttError.NoSpeech)
        assertEquals("no speech", (vm.state.value as DictationState.Failed).message)
        assertEquals("Reply with", text)
    }

    @Test
    fun `cancelling removes the live text again`() {
        val vm = viewModel(SettingsSnapshot(loaded = true, dictationEngine = "on_device"))
        vm.start(SttAfter.Insert)
        speech.listener!!.onPartial("hallo")
        assertEquals("Reply with hallo", text)

        vm.cancel()
        assertEquals("Reply with", text)
        assertTrue(vm.state.value is DictationState.Idle)
        assertTrue(speech.cancelled)
    }

    @Test
    fun `switching the composer scope drops live text instead of pasting it elsewhere`() {
        val vm = viewModel(SettingsSnapshot(loaded = true, dictationEngine = "on_device"))
        vm.bindScope("sessions/a")
        vm.start(SttAfter.Insert)
        speech.listener!!.onPartial("geheim")
        assertEquals("Reply with geheim", text)

        // The next session binds its own draft after the composer switched.
        text = ""
        caret = 0
        vm.bindScope("sessions/b")
        assertEquals("the other session's draft stays empty", "", text)
        assertTrue(vm.state.value is DictationState.Idle)
        assertTrue(speech.cancelled)
    }

    @Test
    fun `stopping keeps the partial when the recognizer never answers`() {
        val vm = viewModel(SettingsSnapshot(loaded = true, dictationEngine = "on_device"))
        vm.start(SttAfter.Insert)
        speech.listener!!.onPartial("hallo du")

        vm.stop()
        assertTrue("the recognizer is asked to finish", speech.stopped)
        assertEquals("the text stays visible while the answer is pending", "Reply with hallo du", text)
    }

    /** Counts uploads so the on-device tests can prove the server is untouched. */
    private class CountingSttApi : SttApi by FakeSttApi() {
        var starts = 0

        override suspend fun start(
            scope: String?,
            owner: String,
            after: SttAfter?,
            audio: ByteArray,
            fileName: String,
            mimeType: String,
        ): SttStartOutcome {
            starts++
            return SttStartOutcome.Rejected("unexpected upload")
        }
    }
}
