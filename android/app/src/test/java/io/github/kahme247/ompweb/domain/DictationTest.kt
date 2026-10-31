package io.github.kahme247.ompweb.domain

import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Dictation ownership/claim/adopt/retry/timeout rules, mirroring
 * `hooks/useDictation.ts` and the server contract in `lib/stt-jobs.ts`.
 */
class DictationTest {

    private var now = 1_000L
    private val machine = DictationMachine { now }

    private fun transcribing(jobId: String = "job-1", after: SttAfter = SttAfter.Insert) {
        machine.start(after)
        machine.finishRecording()
        machine.uploadAccepted(jobId)
    }

    // --- capture ----------------------------------------------------------

    @Test
    fun `start resets a shown job and refuses a second capture`() {
        transcribing()
        machine.fail("network")
        assertTrue(machine.start(SttAfter.Send))
        assertNull("the previous job is replaced", machine.jobId)
        assertEquals(SttAfter.Send, machine.after)
        assertEquals(DictationPhase.Recording, machine.phase)
        assertFalse("a capture cannot start twice", machine.start(SttAfter.Insert))
    }

    @Test
    fun `elapsed time excludes paused stretches and stops at five minutes`() {
        assertTrue(machine.start(SttAfter.Insert))
        now += 2_000
        assertEquals(2_000L, machine.elapsedMs())

        assertTrue(machine.pause())
        now += 5_000
        assertEquals("paused time does not count", 2_000L, machine.elapsedMs())

        assertTrue(machine.resume())
        now += 3_000
        assertEquals(5_000L, machine.elapsedMs())

        machine.finishRecording()
        assertEquals(5_000L, machine.finalElapsedMs)
        assertEquals("the finished length stays available", 5_000L, machine.elapsedMs())

        val capped = DictationMachine { now }
        capped.start(SttAfter.Insert)
        now += DictationMachine.MAX_RECORDING_MS + 10_000
        assertEquals(DictationMachine.MAX_RECORDING_MS, capped.elapsedMs())
    }

    // --- follow / claim ---------------------------------------------------

    @Test
    fun `a finished job is claimed once and then waits for the answer`() {
        transcribing()
        assertEquals(DictationStep.Claim, machine.observe(SttJob("job-1", SttJobStatus.Done, null)))
        assertTrue(machine.awaitingClaim)
        assertEquals(
            "a repeated poll must not claim twice",
            DictationStep.Wait,
            machine.observe(SttJob("job-1", SttJobStatus.Done, null)),
        )
    }

    @Test
    fun `own transcript keeps the send intent`() {
        transcribing(after = SttAfter.Steer)
        machine.observe(SttJob("job-1", SttJobStatus.Done, null))
        val step = machine.takeClaim(SttClaim("job-1", SttJobStatus.Done, null, "  hello  ", SttAfter.Steer))
        assertEquals(DictationStep.Delivered("hello", SttAfter.Steer, isOwner = true), step)
        assertEquals(DictationPhase.Idle, machine.phase)
        assertNull(machine.jobId)
        assertFalse(machine.hasLocalAudio)
    }

    @Test
    fun `a transcript another composer recorded is only inserted`() {
        assertTrue(machine.adopt(listOf(SttJob("job-2", SttJobStatus.Done, null))))
        assertFalse(machine.mine)
        assertEquals(SttAfter.Insert, machine.after)
        machine.observe(SttJob("job-2", SttJobStatus.Done, null))
        val step = machine.takeClaim(SttClaim("job-2", SttJobStatus.Done, null, "from the other tab", null))
        assertEquals(DictationStep.Delivered("from the other tab", SttAfter.Insert, isOwner = false), step)
    }

    @Test
    fun `the owner grace asks again until the claim carries text`() {
        transcribing()
        machine.observe(SttJob("job-1", SttJobStatus.Done, null))
        assertEquals(
            "done without text means: the recording browser still has the first claim",
            DictationStep.Wait,
            machine.takeClaim(SttClaim("job-1", SttJobStatus.Done, null, null, SttAfter.Send)),
        )
        assertTrue("the claim repeats with the same token", machine.awaitingClaim)
        val step = machine.takeClaim(SttClaim("job-1", SttJobStatus.Done, null, "text", SttAfter.Send))
        assertEquals(DictationStep.Delivered("text", SttAfter.Send, isOwner = true), step)
    }

    @Test
    fun `a claim on a pending job goes back to polling`() {
        transcribing()
        machine.observe(SttJob("job-1", SttJobStatus.Done, null))
        assertEquals(
            DictationStep.Wait,
            machine.takeClaim(SttClaim("job-1", SttJobStatus.Pending, null, null, null)),
        )
        assertFalse(machine.awaitingClaim)
        assertEquals(DictationStep.Wait, machine.observe(SttJob("job-1", SttJobStatus.Pending, null)))
    }

    @Test
    fun `another composer taking the job stands down without an error`() {
        transcribing()
        assertEquals(DictationStep.StandDown, machine.observe(SttJob("job-1", SttJobStatus.Gone, null)))
        assertEquals(DictationPhase.Gone, machine.phase)
        assertNull(machine.jobId)

        val follower = DictationMachine { now }
        follower.adopt(listOf(SttJob("job-3", SttJobStatus.Pending, null)))
        assertEquals(
            DictationStep.StandDown,
            follower.takeClaim(SttClaim("job-3", SttJobStatus.Gone, null, null, null)),
        )
    }

    @Test
    fun `a lost job fails only the composer that recorded it`() {
        transcribing()
        assertEquals(DictationStep.Failed(DictationMachine.JOB_NOT_FOUND), machine.observe(null))
        assertEquals(DictationPhase.Failed, machine.phase)

        val follower = DictationMachine { now }
        follower.adopt(listOf(SttJob("job-4", SttJobStatus.Pending, null)))
        assertEquals(DictationStep.StandDown, follower.observe(null))
        assertEquals(DictationPhase.Gone, follower.phase)
    }

    @Test
    fun `job errors surface their message`() {
        transcribing()
        assertEquals(DictationStep.Failed("upstream refused"), machine.observe(SttJob("job-1", SttJobStatus.Error, "upstream refused")))
        assertEquals("upstream refused", machine.message)
    }

    // --- adoption ---------------------------------------------------------

    @Test
    fun `the stop intent overrides the intent chosen at start`() {
        assertTrue(machine.start(SttAfter.Insert))
        machine.finishRecording(SttAfter.FollowUp)
        assertEquals("the primary button decides at stop time", SttAfter.FollowUp, machine.after)
        assertEquals(DictationPhase.Uploading, machine.phase)

        machine.finishRecording(SttAfter.Send)
        assertEquals("a finished capture cannot change its intent again", SttAfter.FollowUp, machine.after)
        assertEquals(DictationPhase.Uploading, machine.phase)
    }

    @Test
    fun `a capture cannot start over an upload or a running job`() {
        assertTrue(machine.start(SttAfter.Insert))
        machine.finishRecording()
        assertFalse("uploading blocks a new capture", machine.start(SttAfter.Send))

        machine.uploadAccepted("job-1")
        assertFalse("transcribing blocks a new capture", machine.start(SttAfter.Send))
        assertEquals(DictationPhase.Transcribing, machine.phase)
    }

    @Test
    fun `the elapsed time freezes when the recording stops`() {
        assertTrue(machine.start(SttAfter.Insert))
        now += 4_200
        machine.finishRecording()
        now += 60_000
        assertEquals(4_200L, machine.finalElapsedMs)
        assertEquals("the deck keeps showing the recorded length", 4_200L, machine.elapsedMs())
    }

    @Test
    fun `adoption picks the newest live job and shows a failed one with its error`() {
        assertFalse("nothing to adopt", machine.adopt(emptyList()))
        assertFalse("gone jobs are not adopted", machine.adopt(listOf(SttJob("g", SttJobStatus.Gone, null))))

        assertTrue(machine.adopt(listOf(SttJob("failed", SttJobStatus.Error, "boom"), SttJob("newer", SttJobStatus.Done, null))))
        assertEquals("the newest live job wins", "failed", machine.jobId)
        assertEquals(DictationPhase.Failed, machine.phase)
        assertEquals("boom", machine.message)
        assertTrue("the server kept the audio for a retry", machine.canRetry)
        assertEquals("an error is not being followed", DictationPhase.Failed, machine.phase)
    }

    @Test
    fun `nothing is adopted while this composer is busy`() {
        transcribing()
        assertFalse(machine.canAdopt())
        assertFalse(machine.adopt(listOf(SttJob("other", SttJobStatus.Done, null))))
        assertEquals("job-1", machine.jobId)
    }

    // --- retry ------------------------------------------------------------

    @Test
    fun `retry falls back to the local copy when the server lost the job`() {
        machine.setLocalAudio(true)
        machine.fail("network")
        assertEquals(DictationPhase.Failed, machine.phase)
        assertTrue(machine.canRetry)

        assertEquals(DictationStep.Wait, machine.retryJobMissing())
        assertEquals("the local recording re-uploads", DictationPhase.Uploading, machine.phase)
        assertNull(machine.jobId)
    }

    @Test
    fun `without a local copy a lost job is final`() {
        machine.fail("network")
        assertEquals(DictationStep.Failed(DictationMachine.JOB_NOT_FOUND), machine.retryJobMissing())
        assertEquals(DictationPhase.Failed, machine.phase)
        assertFalse("nothing left to retry", machine.canRetry)
    }

    @Test
    fun `a retried job becomes this composer's own`() {
        machine.setLocalAudio(true)
        assertTrue(machine.adopt(listOf(SttJob("job-7", SttJobStatus.Error, "boom"))))
        assertFalse("adopted jobs belong to another composer", machine.mine)

        assertNull(machine.retryAccepted(SttJob("job-7", SttJobStatus.Pending, null)))
        assertTrue("the retrying browser becomes the job's owner", machine.mine)
        assertEquals("job-7", machine.jobId)
        assertEquals(DictationStep.Failed(DictationMachine.JOB_NOT_FOUND), machine.observe(null))
    }

    @Test
    fun `a server retry restarts the follow deadline`() {
        transcribing()
        machine.observe(SttJob("job-1", SttJobStatus.Error, "boom"))
        now += 60_000
        assertNull(machine.retryAccepted(SttJob("job-1", SttJobStatus.Pending, null)))
        assertEquals(DictationPhase.Transcribing, machine.phase)
        now += DictationMachine.STT_TIMEOUT_MS - 1_000
        assertEquals(
            "the retry got a fresh six minutes",
            DictationStep.Wait,
            machine.observe(SttJob("job-1", SttJobStatus.Pending, null)),
        )
    }

    @Test
    fun `a retry the server refuses keeps the error visible`() {
        transcribing()
        machine.observe(SttJob("job-1", SttJobStatus.Error, "boom"))
        assertEquals(DictationStep.Failed("busy"), machine.retryRejected("busy"))
        assertEquals("busy", machine.message)
        assertEquals(DictationPhase.Failed, machine.phase)
    }

    // --- timeout ----------------------------------------------------------

    @Test
    fun `following gives up six minutes after it started`() {
        transcribing()
        now += DictationMachine.STT_TIMEOUT_MS + 1
        assertEquals(DictationStep.Failed(DictationMachine.TIMED_OUT), machine.observe(SttJob("job-1", SttJobStatus.Pending, null)))
        assertEquals(DictationPhase.Failed, machine.phase)

        val claimer = DictationMachine { now }
        claimer.adopt(listOf(SttJob("job-9", SttJobStatus.Pending, null)))
        now += DictationMachine.STT_TIMEOUT_MS + 1
        assertEquals(
            DictationStep.Failed(DictationMachine.TIMED_OUT),
            claimer.takeClaim(SttClaim("job-9", SttJobStatus.Pending, null, null, null)),
        )
    }

    // --- reset ------------------------------------------------------------

    @Test
    fun `discard forgets the job and the local copy`() {
        transcribing()
        machine.setLocalAudio(true)
        machine.discard()
        assertEquals(DictationPhase.Idle, machine.phase)
        assertNull(machine.jobId)
        assertFalse(machine.hasLocalAudio)
        assertFalse(machine.canRetry)
        assertEquals(SttAfter.Insert, machine.after)
        assertTrue(machine.canAdopt())
    }

    @Test
    fun `a recording restored from disk offers the re-upload`() {
        machine.restoreRecording(SttAfter.Send, DictationMachine.TRANSCRIPTION_FAILED)
        assertEquals(DictationPhase.Failed, machine.phase)
        assertEquals(SttAfter.Send, machine.after)
        assertTrue(machine.hasLocalAudio)
        assertTrue(machine.canRetry)
        assertEquals(DictationStep.Wait, machine.retryJobMissing())
        assertEquals(DictationPhase.Uploading, machine.phase)
    }

    // --- delivery ---------------------------------------------------------

    @Test
    fun `a transcript merges after the draft with one separating space`() {
        assertEquals("hello world", mergeTranscript("hello", "world"))
        assertEquals("hello world", mergeTranscript("hello ", "world"))
        assertEquals("world", mergeTranscript("", "world"))
    }

    @Test
    fun `another composers job and Insert only fill the field`() {
        assertEquals(
            DictationOutcome.Insert("hello"),
            dictationOutcome(DictationResult("hello", SttAfter.Send, isOwner = false), "draft", hasSession = true),
        )
        assertEquals(
            DictationOutcome.Insert("hello"),
            dictationOutcome(DictationResult("hello", SttAfter.Insert, isOwner = true), "draft", hasSession = true),
        )
    }

    @Test
    fun `a session routes Send Steer and FollowUp and merges the draft`() {
        assertEquals(
            DictationOutcome.Send("draft hello"),
            dictationOutcome(DictationResult("hello", SttAfter.Send, isOwner = true), "draft", hasSession = true),
        )
        assertEquals(
            DictationOutcome.Steer("draft hello"),
            dictationOutcome(DictationResult("hello", SttAfter.Steer, isOwner = true), "draft", hasSession = true),
        )
        assertEquals(
            DictationOutcome.FollowUp("draft hello"),
            dictationOutcome(DictationResult("hello", SttAfter.FollowUp, isOwner = true), "draft", hasSession = true),
        )
    }

    @Test
    fun `without a session every choice becomes a normal send`() {
        for (after in listOf(SttAfter.Send, SttAfter.Steer, SttAfter.FollowUp)) {
            assertEquals(
                "the web's new chat sends the first prompt for $after",
                DictationOutcome.Send("draft hello"),
                dictationOutcome(DictationResult("hello", after, isOwner = true), "draft", hasSession = false),
            )
        }
    }

    // --- dictation engine --------------------------------------------------

    @Test
    fun `auto uses the server when one is configured and the phone otherwise`() {
        assertEquals(
            DictationEngine.SERVER,
            resolveDictationEngine(DictationEnginePreference.AUTO, serverConfigured = true),
        )
        assertEquals(
            DictationEngine.ON_DEVICE,
            resolveDictationEngine(DictationEnginePreference.AUTO, serverConfigured = false),
        )
    }

    @Test
    fun `auto falls back to the phone after the server reported no STT`() {
        assertEquals(
            DictationEngine.ON_DEVICE,
            resolveDictationEngine(
                DictationEnginePreference.AUTO,
                serverConfigured = true,
                serverSttUnconfigured = true,
            ),
        )
        assertEquals(
            "an explicit server choice still asks the server",
            DictationEngine.SERVER,
            resolveDictationEngine(
                DictationEnginePreference.SERVER,
                serverConfigured = true,
                serverSttUnconfigured = true,
            ),
        )
    }

    @Test
    fun `auto never picks a phone without an installed model`() {
        assertEquals(
            "auto without a model uses the configured server path",
            DictationEngine.SERVER,
            resolveDictationEngine(
                DictationEnginePreference.AUTO,
                serverConfigured = true,
                onDeviceAvailable = false,
            ),
        )
        assertEquals(
            "the explicit on-device choice still surfaces the missing model",
            DictationEngine.ON_DEVICE,
            resolveDictationEngine(
                DictationEnginePreference.ON_DEVICE,
                serverConfigured = true,
                onDeviceAvailable = false,
            ),
        )
    }

    @Test
    fun `an explicit engine wins over the server state`() {
        assertEquals(
            DictationEngine.ON_DEVICE,
            resolveDictationEngine(DictationEnginePreference.ON_DEVICE, serverConfigured = true),
        )
        assertEquals(
            DictationEngine.SERVER,
            resolveDictationEngine(DictationEnginePreference.SERVER, serverConfigured = false),
        )
    }

    @Test
    fun `auto never lands on the phone without an on-device model`() {
        assertEquals(
            "a configured server stays the engine",
            DictationEngine.SERVER,
            resolveDictationEngine(
                DictationEnginePreference.AUTO,
                serverConfigured = true,
                serverSttUnconfigured = true,
                onDeviceAvailable = false,
            ),
        )
        assertEquals(
            "without any server the on-device start reports the missing model",
            DictationEngine.ON_DEVICE,
            resolveDictationEngine(
                DictationEnginePreference.AUTO,
                serverConfigured = false,
                onDeviceAvailable = false,
            ),
        )
        assertEquals(
            "the explicit choice is kept so its start can explain the missing model",
            DictationEngine.ON_DEVICE,
            resolveDictationEngine(
                DictationEnginePreference.ON_DEVICE,
                serverConfigured = true,
                onDeviceAvailable = false,
            ),
        )
    }

    @Test
    fun `an unknown stored engine falls back to auto`() {
        assertEquals(DictationEnginePreference.AUTO, DictationEnginePreference.fromWire(null))
        assertEquals(DictationEnginePreference.AUTO, DictationEnginePreference.fromWire(""))
        assertEquals(DictationEnginePreference.AUTO, DictationEnginePreference.fromWire("nonsense"))
        assertEquals(DictationEnginePreference.ON_DEVICE, DictationEnginePreference.fromWire("on_device"))
        assertEquals(DictationEnginePreference.SERVER, DictationEnginePreference.fromWire("server"))
    }

    @Test
    fun `the recognition language uses the pick when valid and the device locale otherwise`() {
        assertEquals("de-DE", dictationLanguageTag("de-DE", Locale.US))
        assertEquals("en-GB", dictationLanguageTag("en-GB", Locale.GERMANY))
        assertEquals(
            "the device locale wins over a malformed pick",
            "de-DE",
            dictationLanguageTag("not a tag", Locale.GERMANY),
        )
        assertEquals("device locale when nothing is picked", "de-DE", dictationLanguageTag(null, Locale.GERMANY))
        assertEquals("language-only locales keep no dash", "de", dictationLanguageTag("  ", Locale("de")))
    }

    @Test
    fun `the offered languages put the device language first`() {
        val offered = offeredDictationLanguages(Locale("sv", "SE"))
        assertEquals("Swedish is already offered", "en-US", offered.first())
        assertEquals(1, offered.count { it == "sv-SE" })

        val unusual = offeredDictationLanguages(Locale("is", "IS"))
        assertEquals("the device language is added when missing", "is-IS", unusual.first())
        assertTrue(unusual.contains("en-US"))
    }

    @Test
    fun `language labels name the locale`() {
        assertEquals("German (Germany)", dictationLanguageLabel("de-DE", Locale.US))
    }

    // --- live on-device insertion -----------------------------------------

    @Test
    fun `the first partial lands at the caret with one separating space`() {
        val buffer = LiveDictationBuffer()
        val insertion = buffer.onPartial(current = "Reply with", caret = 10, partial = "OK")
        assertEquals("Reply with OK", insertion?.text)
        assertEquals(13, insertion?.caret)
        assertTrue(buffer.active)
    }

    @Test
    fun `a caret after whitespace does not add a second space`() {
        val buffer = LiveDictationBuffer()
        val insertion = buffer.onPartial("Reply with ", 11, "hello")
        assertEquals("Reply with hello", insertion?.text)
        assertEquals(16, insertion?.caret)
    }

    @Test
    fun `a later partial replaces the visible live text instead of appending`() {
        val buffer = LiveDictationBuffer()
        val first = buffer.onPartial("hello", 5, "wor")!!
        val second = buffer.onPartial(first.text, first.caret, "world")
        assertEquals("hello world", second?.text)
        assertEquals(11, second?.caret)
        assertEquals(
            "the same partial is not applied again",
            null,
            buffer.onPartial(second!!.text, second.caret, "world"),
        )
    }

    @Test
    fun `the final transcript replaces the partial`() {
        val buffer = LiveDictationBuffer()
        val first = buffer.onPartial("", 0, "helo")
        assertEquals("helo", first?.text)
        val final = buffer.onFinal(first!!.text, first.caret, "Hello.")
        assertEquals("Hello.", final?.text)
        assertEquals(6, final?.caret)
        assertFalse("the capture is finished", buffer.active)
    }

    @Test
    fun `a final that arrives without a partial is inserted once`() {
        val buffer = LiveDictationBuffer()
        val insertion = buffer.onFinal("draft", 5, "  hello world  ")
        assertEquals("draft hello world", insertion?.text)
        assertEquals(17, insertion?.caret)

        assertEquals("blank results insert nothing", null, buffer.onFinal("draft", 5, "   "))
    }

    @Test
    fun `a user edit while listening keeps the visible text and re-anchors`() {
        val buffer = LiveDictationBuffer()
        val first = buffer.onPartial("draft", 5, "spoken")!!
        // The user typed in front of the live text; the caret is now after it.
        val edited = "NEW ${first.text}"
        val next = buffer.onPartial(edited, edited.length, "again")
        assertEquals("NEW draft spoken again", next?.text)
        assertEquals(
            "the new partial follows the last visible text and the new caret",
            "NEW draft spoken again".length,
            next?.caret,
        )
    }

    @Test
    fun `cancelling removes the live text again`() {
        val buffer = LiveDictationBuffer()
        val first = buffer.onPartial("draft", 5, "spoken")!!
        val restored = buffer.onCancel(first.text)
        assertEquals("draft", restored?.text)
        assertEquals(5, restored?.caret)

        assertEquals("nothing to restore after a cancel", null, buffer.onCancel("draft"))
        assertFalse(buffer.active)
    }
}
