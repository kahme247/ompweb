package io.github.kahme247.ompweb.domain

import io.github.kahme247.ompweb.net.AppUpdateInfo
import io.github.kahme247.ompweb.net.OmpUpdateInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The banner state behind the shell notice (web `AppShell.tsx`: the toast id
 * carries the version, so a dismissed version stays hidden while a newer one
 * shows again). A11.
 */
class UpdateNoticeStateTest {

    private fun app(
        current: String = "1.0.0",
        available: String = "1.1.0",
        available_: Boolean = true,
        selfUpdate: Boolean = true,
        disabled: Boolean = false,
    ) = AppUpdateInfo(
        currentVersion = current,
        availableVersion = available,
        updateAvailable = available_,
        updateCommand = "ompweb update",
        updatesDisabled = disabled,
        selfUpdateSupported = selfUpdate,
    )

    private fun omp(
        current: String = "0.9.0",
        available: String = "0.10.0",
        available_: Boolean = true,
        disabled: Boolean = false,
    ) = OmpUpdateInfo(
        currentVersion = current,
        availableVersion = available,
        updateAvailable = available_,
        updateCommand = "omp update",
        updatesDisabled = disabled,
    )

    @Test
    fun `a fresh app update is visible`() {
        val notice = selectUpdateNotice(app(), null, null, null, null)!!

        assertEquals(UpdateKind.APP, notice.kind)
        assertEquals("1.0.0", notice.currentVersion)
        assertEquals("1.1.0", notice.availableVersion)
        assertTrue(notice.visible)
    }

    @Test
    fun `dismissing hides that version only`() {
        // No other update pending: the dismissed version leaves no notice.
        assertNull(selectUpdateNotice(app(), null, "1.1.0", null, null))

        // The same server answer with a newer version is news again.
        val newer = selectUpdateNotice(app(available = "1.2.0"), null, "1.1.0", null, null)!!
        assertTrue(newer.visible)
    }

    @Test
    fun `the completed version stays hidden`() {
        assertNull(selectUpdateNotice(app(), null, null, null, "1.1.0"))

        // A pending omp update is still announced after the app's install.
        val fallback = selectUpdateNotice(app(), omp(), null, null, "1.1.0")!!
        assertEquals(UpdateKind.OMP, fallback.kind)
    }

    @Test
    fun `an app update wins over an omp update`() {
        val notice = selectUpdateNotice(app(), omp(), null, null, null)!!

        assertEquals(UpdateKind.APP, notice.kind)
    }

    @Test
    fun `a dismissed app update falls back to the omp update`() {
        // Web shows the two toasts independently; the app notice must not
        // swallow a pending omp update once its own version was dismissed.
        val dismissed = selectUpdateNotice(app(), omp(), "1.1.0", null, null)!!

        assertEquals(UpdateKind.OMP, dismissed.kind)
        assertEquals("0.10.0", dismissed.availableVersion)
        assertTrue(dismissed.visible)

        val completed = selectUpdateNotice(app(), omp(), null, null, "1.1.0")!!
        assertEquals(UpdateKind.OMP, completed.kind)

        // A newer app version is visible again and wins over the omp update.
        val newer = selectUpdateNotice(app(available = "1.2.0"), omp(), "1.1.0", null, null)!!
        assertEquals(UpdateKind.APP, newer.kind)
    }

    @Test
    fun `dismissing the only app update leaves no notice`() {
        assertNull(selectUpdateNotice(app(), null, "1.1.0", null, null))
        assertNull(selectUpdateNotice(app(), null, null, null, "1.1.0"))
    }

    @Test
    fun `the omp update shows when the app is current`() {
        val notice = selectUpdateNotice(app(available_ = false), omp(), null, null, null)!!

        assertEquals(UpdateKind.OMP, notice.kind)
        assertEquals("0.10.0", notice.availableVersion)
        assertTrue(notice.visible)
    }

    @Test
    fun `a dismissed omp update hides until a newer version`() {
        assertFalse(selectUpdateNotice(null, omp(), null, "0.10.0", null)!!.visible)
        assertTrue(selectUpdateNotice(null, omp(available = "0.11.0"), null, "0.10.0", null)!!.visible)
    }

    @Test
    fun `no update available means no notice`() {
        assertNull(selectUpdateNotice(null, null, null, null, null))
        assertNull(selectUpdateNotice(app(available_ = false), omp(available_ = false), null, null, null))
    }

    @Test
    fun `updates disabled by the server suppress the notice`() {
        assertNull(selectUpdateNotice(app(disabled = true), omp(available_ = false), null, null, null))
        assertNull(selectUpdateNotice(app(available_ = false), omp(disabled = true), null, null, null))
        // A disabled app check must not hide a pending omp update.
        assertEquals(UpdateKind.OMP, selectUpdateNotice(app(disabled = true), omp(), null, null, null)!!.kind)
    }

    @Test
    fun `an app update is announced even without self-update support`() {
        // The install button itself is gated on the raw `AppUpdateInfo`;
        // the banner only needs the versions.
        val notice = selectUpdateNotice(app(selfUpdate = false), null, null, null, null)!!

        assertEquals(UpdateKind.APP, notice.kind)
        assertEquals("1.1.0", notice.availableVersion)
        assertTrue(notice.visible)
    }

    @Test
    fun `stages map onto the card phases`() {
        assertEquals(UpdatePhase.PREPARING, updatePhaseFor("preparing"))
        assertEquals(UpdatePhase.RESTARTING, updatePhaseFor("stopping"))
        assertEquals(UpdatePhase.INSTALLING, updatePhaseFor("installing"))
        assertEquals(UpdatePhase.FINALIZING, updatePhaseFor("restarting"))
        assertEquals(UpdatePhase.FINALIZING, updatePhaseFor("finalizing"))
        // A status without a stage already passed preparation.
        assertEquals(UpdatePhase.RESTARTING, updatePhaseFor(null))
    }

    @Test
    fun `terminal states are succeeded and failed`() {
        assertTrue(isTerminalUpdateState("succeeded"))
        assertTrue(isTerminalUpdateState("failed"))
        assertFalse(isTerminalUpdateState("running"))
        assertFalse(isTerminalUpdateState("prepared"))
        assertFalse(isTerminalUpdateState(null))
    }

    @Test
    fun `a notice check is due on the first call and then once per hour`() {
        val start = 1_700_000_000_000L
        assertEquals(60L * 60L * 1000L, UPDATE_NOTICE_CHECK_INTERVAL_MILLIS)
        assertTrue("no stamp yet", isUpdateNoticeCheckDue(null, null, start))
        assertFalse(isUpdateNoticeCheckDue(start, null, start))
        assertFalse(isUpdateNoticeCheckDue(start, null, start + UPDATE_NOTICE_CHECK_INTERVAL_MILLIS - 1))
        assertTrue(isUpdateNoticeCheckDue(start, null, start + UPDATE_NOTICE_CHECK_INTERVAL_MILLIS))
        // A clock that jumped backwards must not open a second window.
        assertFalse(isUpdateNoticeCheckDue(start, null, start - 1_000L))
    }

    @Test
    fun `a check that reached no endpoint retries after a short backoff`() {
        val start = 1_700_000_000_000L
        assertTrue(
            "the retry delay must stay between one and five minutes",
            UPDATE_NOTICE_FAILURE_BACKOFF_MILLIS in 60_000L..300_000L,
        )
        // Nothing answered: due again after the backoff, far before the hour.
        assertFalse(isUpdateNoticeCheckDue(null, start, start))
        assertFalse(isUpdateNoticeCheckDue(null, start, start + UPDATE_NOTICE_FAILURE_BACKOFF_MILLIS - 1))
        assertTrue(isUpdateNoticeCheckDue(null, start, start + UPDATE_NOTICE_FAILURE_BACKOFF_MILLIS))
        assertTrue(
            "the backoff must be shorter than the success window",
            UPDATE_NOTICE_FAILURE_BACKOFF_MILLIS < UPDATE_NOTICE_CHECK_INTERVAL_MILLIS,
        )
        // A success recorded after a failure governs from then on; the stale
        // failure stamp does not shorten that window.
        val successAt = start + UPDATE_NOTICE_FAILURE_BACKOFF_MILLIS
        assertFalse(isUpdateNoticeCheckDue(successAt, start, successAt + 1_000L))
        // A clock that jumped backwards must not bypass the backoff either.
        assertFalse(isUpdateNoticeCheckDue(null, start, start - 1_000L))
    }
}
