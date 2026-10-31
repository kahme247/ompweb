package io.github.kahme247.ompweb.notify

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The manual pulse is gated before it reaches the vibrator: the user's
 * setting, an actual vibrator, silent mode and total-silence/alarms-only Do
 * Not Disturb. Everything else is left to the platform via the notification
 * usage attribute.
 */
class InAppHapticsTest {

    @Test
    fun `a pulse only happens when every gate is open`() {
        assertTrue(inAppVibrationAllowed(enabled = true, hasVibrator = true, ringerSilent = false, dndActive = false))
    }

    @Test
    fun `the setting switched off suppresses the pulse`() {
        assertFalse(inAppVibrationAllowed(enabled = false, hasVibrator = true, ringerSilent = false, dndActive = false))
    }

    @Test
    fun `a device without a vibrator stays silent`() {
        assertFalse(inAppVibrationAllowed(enabled = true, hasVibrator = false, ringerSilent = false, dndActive = false))
    }

    @Test
    fun `silent mode and total silence suppress the pulse`() {
        assertFalse(inAppVibrationAllowed(enabled = true, hasVibrator = true, ringerSilent = true, dndActive = false))
        assertFalse(inAppVibrationAllowed(enabled = true, hasVibrator = true, ringerSilent = false, dndActive = true))
    }
}
