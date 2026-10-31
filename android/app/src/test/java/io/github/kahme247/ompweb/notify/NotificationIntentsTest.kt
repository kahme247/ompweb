package io.github.kahme247.ompweb.notify

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Security rule of the answer broadcast (X8): only an action minted for the
 * configured installation may answer, so a notification of a server the user
 * left cannot mutate the current one.
 */
class NotificationIntentsTest {

    @Test
    fun `an action of the configured origin is accepted`() {
        assertTrue(NotificationIntents.acceptsOrigin("https://a.example:8443", "https://a.example:8443"))
    }

    @Test
    fun `an action of another origin is dropped`() {
        assertFalse(NotificationIntents.acceptsOrigin("https://old.example:8443", "https://a.example:8443"))
        assertFalse(NotificationIntents.acceptsOrigin(null, "https://a.example:8443"))
        assertFalse(NotificationIntents.acceptsOrigin("https://a.example:8443", null))
        assertFalse(NotificationIntents.acceptsOrigin(null, null))
    }
}
