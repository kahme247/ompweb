package io.github.kahme247.ompweb.notify

import io.github.kahme247.ompweb.domain.NotifyEvent
import io.github.kahme247.ompweb.domain.NotifyProject

/**
 * Every system-notification operation [NotificationCenter] and the answer
 * receiver need. [AndroidNotifier] posts for real; a JVM test supplies a fake
 * to exercise the delivery rules (post refusal → in-app notice) without the
 * NotificationManager.
 */
interface Notifier {

    fun ensureChannels()

    /**
     * One live event; `false` when the app may not post (permission/channel).
     * [project] is the session's project when known: the notification joins
     * that project's group and the group summary is refreshed.
     */
    fun post(event: NotifyEvent, project: NotifyProject?): Boolean

    /** Settings "Send test notification" without a push subscription. */
    fun postTest(): Boolean

    /** Replaces an answered dialog's notification with the result text. */
    fun postResult(tag: String, title: String, channelId: String, text: String, sessionId: String): Boolean

    fun cancelAll()

    /**
     * Closes every posted notification of one session (all event types and
     * results). The app calls this when the user opens that chat: what is on
     * screen is read there, not in the shade.
     */
    fun cancelSession(sessionId: String)

    /** Closes the notification of [tag] only while it still belongs to [requestId]. */
    fun cancelIfMatches(tag: String, requestId: String)

    /**
     * A grouped child was dismissed from the shade; [tag] must be treated as
     * gone even while the system's own list still contains it.
     */
    fun onGroupChildDismissed(groupKey: String, tag: String)

    /**
     * Rebuilds every group summary from the live notifications; a tap
     * auto-cancels a child without a dismiss callback, so the app calls this
     * when it comes to the foreground.
     */
    fun refreshGroupSummaries()
}
