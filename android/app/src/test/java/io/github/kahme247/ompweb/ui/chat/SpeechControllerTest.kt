package io.github.kahme247.ompweb.ui.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * B13: what the read-aloud path hands to the synthesis engine. The response
 * text is sanitized (markdown, code fences, links and URLs never get spoken),
 * and a stored voice preference resolves against the installed voices with a
 * safe fallback to the engine default.
 */
class SpeechControllerTest {

    private val installed = listOf(
        SpeechVoiceOption("en-us-x-sfg#male_1-local", "en-US"),
        SpeechVoiceOption("de-de-x-deb#female_2-local", "de-DE"),
    )

    @Test
    fun theStoredVoiceIsSelectedByName() {
        assertEquals(
            installed[1],
            resolveSpeechVoice(installed, "de-de-x-deb#female_2-local"),
        )
    }

    @Test
    fun aMissingVoiceFallsBackToTheEngineDefault() {
        assertNull(resolveSpeechVoice(installed, "voice-from-an-old-device"))
        assertNull("no preference means the default language", resolveSpeechVoice(installed, null))
        assertNull("no installed voice means the default language", resolveSpeechVoice(emptyList(), "de-de-x-deb#female_2-local"))
    }

    @Test
    fun sanitizingDropsCodeFencesAndKeepsTheProse() {
        val spoken = sanitizeForSpeech(
            """
            Here is the fix:

            ```kotlin
            println("never spoken")
            ```

            Run `testDebugUnitTest` now.
            """.trimIndent(),
        )
        assertEquals("Here is the fix: Run testDebugUnitTest now.", spoken)
    }

    @Test
    fun sanitizingDropsLinksImageUrlsAndHtml() {
        val spoken = sanitizeForSpeech(
            "See [the audit](https://example.com/audit) and ![diagram](https://example.com/a.png) " +
                "or https://example.com/raw <b>now</b>.",
        )
        assertEquals("See the audit and or now.", spoken)
    }

    @Test
    fun sanitizingDropsHeadingAndListMarkersAndEmphasis() {
        val spoken = sanitizeForSpeech(
            """
            ## Results

            - **first** item
            - second with _emphasis_
            > quoted line
            ---
            """.trimIndent(),
        )
        assertEquals("Results first item second with emphasis quoted line", spoken)
    }

    @Test
    fun sanitizingKeepsPlainTextUntouched() {
        assertEquals("Just a plain answer.", sanitizeForSpeech("Just a plain answer."))
        assertEquals("", sanitizeForSpeech("   "))
    }
}
