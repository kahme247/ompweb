package io.github.kahme247.ompweb.notify

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.service.notification.StatusBarNotification
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import io.github.kahme247.ompweb.MainActivity
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.NOTIFICATION_TITLE_MAX
import io.github.kahme247.ompweb.domain.NotifyChannel
import io.github.kahme247.ompweb.domain.NotifyEvent
import io.github.kahme247.ompweb.domain.NotifyProject
import io.github.kahme247.ompweb.domain.RenderedNotification
import io.github.kahme247.ompweb.domain.ReplyTarget
import io.github.kahme247.ompweb.domain.androidChannelId
import io.github.kahme247.ompweb.domain.clipNotificationText
import io.github.kahme247.ompweb.domain.notificationActions
import io.github.kahme247.ompweb.domain.notifyChannelFor
import io.github.kahme247.ompweb.domain.quietId
import io.github.kahme247.ompweb.domain.renderNotification
import io.github.kahme247.ompweb.domain.renderTestNotification
import io.github.kahme247.ompweb.domain.supportsVibration
import io.github.kahme247.ompweb.domain.vibrationPattern
import io.github.kahme247.ompweb.domain.vibratingId
import java.util.concurrent.atomic.AtomicInteger

/**
 * Every system notification of the app, in one place: the live event
 * renderer, the Phase-7 host-tool `notify` path, the local test notification
 * and the "Sent"/"Already answered"/"Failed" result update.
 *
 * Tag `<sessionId>:<type>` replaces instead of stacking; every notification
 * carries a private public version for the lock screen, and its intents carry
 * the origin they were minted for ([origin]).
 *
 * Event notifications join the Android group of their session's project and a
 * per-project summary is refreshed after every change ("3 sessions in
 * ompwebandroid"). A grouped child also carries a delete intent, and every
 * foreground visit rebuilds all summaries, so tapping or swiping a child away
 * cannot leave a stale count/title behind. Vibration lives in the channels
 * (immutable after creation, so the vibrating `_v2` and quiet `_quiet` twins
 * exist side by side); [vibrate] picks the twin on every post.
 */
class AndroidNotifier(
    private val context: Context,
    private val origin: () -> String?,
    /** The current "Vibrate" setting; channels cannot be edited after creation. */
    private val vibrate: () -> Boolean = { true },
) : Notifier {

    override fun ensureChannels() {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        // A user who blocked a legacy channel keeps that decision on the new
        // twins; `createNotificationChannels` never raises an importance.
        val blocked = NotifyChannel.entries
            .filter { it.supportsVibration }
            .filter { manager.getNotificationChannel(it.id)?.importance == NotificationManager.IMPORTANCE_NONE }
            .toSet()
        manager.createNotificationChannels(
            buildList {
                addAll(
                    eventChannels(
                        NotifyChannel.NeedsInput,
                        R.string.notify_channel_needs_input,
                        R.string.notify_channel_needs_input_description,
                        NotificationManager.IMPORTANCE_HIGH,
                        blocked,
                    ),
                )
                addAll(
                    eventChannels(
                        NotifyChannel.Errors,
                        R.string.notify_channel_errors,
                        R.string.notify_channel_errors_description,
                        NotificationManager.IMPORTANCE_HIGH,
                        blocked,
                    ),
                )
                addAll(
                    eventChannels(
                        NotifyChannel.Completed,
                        R.string.notify_channel_completed,
                        R.string.notify_channel_completed_description,
                        NotificationManager.IMPORTANCE_DEFAULT,
                        blocked,
                    ),
                )
                add(
                    channel(
                        NotifyChannel.ModelSwitch.id,
                        R.string.notify_channel_model_switch,
                        R.string.notify_channel_model_switch_description,
                        NotificationManager.IMPORTANCE_LOW,
                    ),
                )
                add(
                    channel(
                        NotifyChannel.ConnectionStatus.id,
                        R.string.notify_channel_connection,
                        R.string.notify_channel_connection_description,
                        NotificationManager.IMPORTANCE_MIN,
                    ).apply {
                        setSound(null, null)
                        enableVibration(false)
                        setShowBadge(false)
                        lockscreenVisibility = Notification.VISIBILITY_SECRET
                    },
                )
                add(
                    channel(
                        NotifyChannel.AgentMessages.id,
                        R.string.notify_channel_agent_messages,
                        R.string.notify_channel_agent_messages_description,
                        NotificationManager.IMPORTANCE_DEFAULT,
                    ),
                )
            },
        )
        // The legacy event channel ids have no vibration pattern and can never
        // get one; the `_v2`/`_quiet` twins replace them. Deleting the old ids
        // keeps the system list free of duplicates (posting no longer uses them).
        NotifyChannel.entries
            .filter { it.supportsVibration }
            .forEach { manager.deleteNotificationChannel(it.id) }
    }

    /** The vibrating and the quiet twin of one event channel. */
    private fun eventChannels(
        channel: NotifyChannel,
        name: Int,
        description: Int,
        importance: Int,
        blocked: Set<NotifyChannel>,
    ): List<NotificationChannel> {
        val pattern = channel.vibrationPattern() ?: return emptyList()
        val effectiveImportance = if (channel in blocked) NotificationManager.IMPORTANCE_NONE else importance
        return listOf(
            channel(channel.vibratingId, name, description, effectiveImportance).apply {
                enableVibration(true)
                vibrationPattern = pattern
            },
            channel(channel.quietId, name, description, effectiveImportance).apply {
                this.name = context.getString(name) + context.getString(R.string.notify_channel_quiet_suffix)
                enableVibration(false)
            },
        )
    }

    private fun channel(
        id: String,
        name: Int,
        description: Int,
        importance: Int,
    ): NotificationChannel = NotificationChannel(
        id,
        context.getString(name),
        importance,
    ).apply {
        this.description = context.getString(description)
    }

    fun canPostNotifications(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) return false
        }
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    /**
     * Posts one live event. The tag replaces an older notification of the same
     * session/type and carries the answerable dialog actions.
     */
    @SuppressLint("MissingPermission", "NotificationPermission")
    override fun post(event: NotifyEvent, project: NotifyProject?): Boolean {
        if (!canPostNotifications()) return false
        ensureChannels()
        val rendered = renderNotification(event)
        val plan = notificationActions(event, context.getString(R.string.notify_reply_label))
        val builder = baseBuilder(rendered, rendered.channel.androidChannelId(vibrate()))
            .setContentIntent(openSessionIntent(event.sessionId, rendered.tag))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setWhen(System.currentTimeMillis())
            .setShowWhen(true)
            .addExtras(
                Bundle().apply {
                    event.answerRequestId?.let { putString(NotificationIntents.EXTRA_REQUEST_ID, it) }
                    putString(NotificationIntents.EXTRA_SESSION_ID, event.sessionId)
                    project?.let { putString(NotificationIntents.EXTRA_PROJECT_LABEL, it.label) }
                },
            )
        project?.let {
            builder
                .setGroup(it.key)
                .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
                .setDeleteIntent(dismissIntent(rendered.tag, it.key))
        }

        plan.buttons.forEachIndexed { index, button ->
            val intent = answerIntent(
                tag = rendered.tag,
                index = index,
                sessionId = event.sessionId,
                requestId = event.answerRequestId,
                answerJson = button.answer.toJson().toString(),
                replyKind = null,
                askQuestionId = null,
                title = rendered.title,
                channelId = rendered.channel.id,
            )
            builder.addAction(
                actionBuilder(button.label, intent).build(),
            )
        }

        plan.reply?.let { reply ->
            val (kind, questionId) = when (val target = reply.target) {
                ReplyTarget.Input -> NotificationIntents.REPLY_INPUT to null
                is ReplyTarget.Ask -> NotificationIntents.REPLY_ASK to target.questionId
                ReplyTarget.FollowUp -> NotificationIntents.REPLY_FOLLOW_UP to null
            }
            val intent = answerIntent(
                tag = rendered.tag,
                index = 10,
                sessionId = event.sessionId,
                requestId = event.answerRequestId,
                answerJson = null,
                replyKind = kind,
                askQuestionId = questionId,
                title = rendered.title,
                channelId = rendered.channel.id,
                remoteInput = true,
            )
            val remoteInput = RemoteInput.Builder(NotificationIntents.REPLY_KEY)
                .setLabel(context.getString(R.string.notify_reply_hint))
                .build()
            builder.addAction(
                actionBuilder(reply.label, intent)
                    .addRemoteInput(remoteInput)
                    .build(),
            )
        }

        val posted = notify(rendered.tag, EVENT_NOTIFICATION_ID, builder.build())
        if (posted && project != null) {
            refreshGroupSummary(
                groupKey = project.key,
                added = GroupChild(
                    tag = rendered.tag,
                    sessionId = event.sessionId,
                    title = rendered.title,
                    label = project.label,
                    channel = rendered.channel,
                    postedAt = System.currentTimeMillis(),
                ),
            )
        }
        return posted
    }

    /**
     * The Phase-7 host-tool `notify` path: same builder, channel and private
     * public version as every other notification, one tag per message so
     * stacked messages stay individual.
     */
    @SuppressLint("MissingPermission", "NotificationPermission")
    fun postAgentMessage(title: String, message: String): Boolean {
        if (!canPostNotifications()) return false
        ensureChannels()
        val number = agentMessageIds.getAndIncrement() % 1_000_000
        val rendered = RenderedNotification(
            title = clipNotificationText(title, NOTIFICATION_TITLE_MAX),
            body = clipNotificationText(message),
            tag = "agent-message:$number",
            channel = NotifyChannel.AgentMessages,
        )
        val notification = baseBuilder(rendered, rendered.channel.androidChannelId(vibrate()))
            .setContentIntent(openSessionIntent(null, rendered.tag))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()
        return notify(rendered.tag, AGENT_MESSAGE_ID_BASE + number, notification)
    }

    /** Settings "Send test notification" without a push subscription. */
    @SuppressLint("MissingPermission", "NotificationPermission")
    override fun postTest(): Boolean {
        if (!canPostNotifications()) return false
        ensureChannels()
        val rendered = renderTestNotification(
            title = context.getString(R.string.notify_status_title),
            body = context.getString(R.string.notify_test_body),
        )
        val notification = baseBuilder(rendered, rendered.channel.androidChannelId(vibrate()))
            .setContentIntent(openSessionIntent(null, rendered.tag))
            .build()
        return notify(rendered.tag, TEST_NOTIFICATION_ID, notification)
    }

    /**
     * Replaces an answered notification by its result ("Sent" / "Already
     * answered" / "Failed — open app"). The request id is deliberately not
     * part of the updated notification, so a dismiss frame for the answered
     * request cannot close the result.
     *
     * The result never vibrates (answering/sending is not an event), so it
     * moves to the channel's quiet twin. It keeps the group of the replaced
     * notification, otherwise the project's summary would shrink by one.
     */
    @SuppressLint("MissingPermission", "NotificationPermission")
    override fun postResult(tag: String, title: String, channelId: String, text: String, sessionId: String): Boolean {
        if (!canPostNotifications()) return false
        ensureChannels()
        val channel = notifyChannelFor(channelId) ?: NotifyChannel.Completed
        val previous = activeNotification(tag)
        val group = previous?.notification?.group
        val label = previous?.notification?.extras?.getString(NotificationIntents.EXTRA_PROJECT_LABEL)
        val builder = NotificationCompat.Builder(context, channel.quietId)
            .setSmallIcon(iconFor(channel))
            .setColor(colorFor(channel))
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(openSessionIntent(sessionId.takeIf { it.isNotBlank() }, tag))
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(privateVersion(NotifyChannel.Completed))
        builder.addExtras(
            Bundle().apply {
                if (sessionId.isNotBlank()) putString(NotificationIntents.EXTRA_SESSION_ID, sessionId)
                label?.let { putString(NotificationIntents.EXTRA_PROJECT_LABEL, it) }
            },
        )
        group?.let {
            builder
                .setGroup(it)
                .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
                .setDeleteIntent(dismissIntent(tag, it))
        }
        val posted = notify(tag, EVENT_NOTIFICATION_ID, builder.build())
        if (posted && group != null) {
            refreshGroupSummary(
                groupKey = group,
                added = GroupChild(
                    tag = tag,
                    sessionId = sessionId,
                    title = title,
                    label = label.orEmpty(),
                    channel = channel,
                    postedAt = System.currentTimeMillis(),
                ),
            )
        }
        return posted
    }

    /**
     * The one builder every posted notification starts from: channel, icon,
     * title/body, priority and the private lock-screen version.
     */
    private fun baseBuilder(rendered: RenderedNotification, channelId: String): NotificationCompat.Builder =
        NotificationCompat.Builder(context, channelId)
            .setSmallIcon(iconFor(rendered.channel))
            .setColor(colorFor(rendered.channel))
            .setContentTitle(rendered.title)
            .setContentText(rendered.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(rendered.body))
            .setAutoCancel(true)
            .setPriority(priority(rendered.channel))
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(privateVersion(rendered.channel))

    /** Closes every notification this app posted (sign-out/server switch). */
    override fun cancelAll() {
        runCatching { NotificationManagerCompat.from(context).cancelAll() }
    }

    /**
     * Closes every notification that carries [sessionId] — all event types and
     * the answered result — and repairs each affected group summary. Opening a
     * chat makes its notifications read in the transcript, so the shade must
     * not keep a second copy.
     */
    @SuppressLint("MissingPermission")
    override fun cancelSession(sessionId: String) {
        val session = sessionId.takeIf { it.isNotBlank() } ?: return
        val active = readActiveNotifications() ?: return
        val manager = NotificationManagerCompat.from(context)
        val groups = LinkedHashSet<String>()
        val cancelled = HashSet<String>()
        for (shown in active) {
            val tag = shown.tag ?: continue
            val notification = shown.notification
            if (notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) continue
            if (notification.extras.getString(NotificationIntents.EXTRA_SESSION_ID) != session) continue
            cancelled += tag
            notification.group?.let(groups::add)
            manager.cancel(tag, shown.id)
        }
        if (cancelled.isEmpty()) return
        // Cancelling is asynchronous; the system's list still holds the closed
        // entries, so the summaries are rebuilt from this snapshot minus them.
        val remaining = active.filterNot { it.tag in cancelled }
        groups.forEach { refreshGroupSummary(groupKey = it, active = remaining) }
    }

    /**
     * Closes the notification of [tag] only when it still belongs to
     * [requestId]: a buffered dismiss must not close the next dialog's
     * notification of the same tag.
     */
    @SuppressLint("MissingPermission")
    override fun cancelIfMatches(tag: String, requestId: String) {
        val manager = NotificationManagerCompat.from(context)
        val match = try {
            manager.activeNotifications.firstOrNull { shown ->
                shown.tag == tag &&
                    shown.notification.extras.getString(NotificationIntents.EXTRA_REQUEST_ID) == requestId
            }
        } catch (_: SecurityException) {
            null
        } ?: return
        val group = match.notification.group
        manager.cancel(match.tag, match.id)
        // Cancelling is asynchronous; excluding the tag keeps the summary exact.
        group?.let { refreshGroupSummary(groupKey = it, removedTag = tag) }
    }

    /**
     * A child was swiped away from the shade. Its delete intent carries the
     * group and tag because the system's own list still contains the child
     * while the broadcast is delivered.
     */
    override fun onGroupChildDismissed(groupKey: String, tag: String) {
        refreshGroupSummary(groupKey = groupKey, removedTag = tag)
    }

    /**
     * Rebuilds every summary the shade currently shows. A tap auto-cancels a
     * child without firing its delete intent, so the app repairs all summaries
     * when it comes to the foreground; the group keys come from the system's
     * list, which survives process death.
     */
    override fun refreshGroupSummaries() {
        val active = readActiveNotifications() ?: return
        val groups = active.mapNotNullTo(LinkedHashSet()) { it.notification.group }
        groups.forEach { refreshGroupSummary(groupKey = it, active = active) }
    }

    /** One child of a project group: exactly what the summary needs. */
    private data class GroupChild(
        val tag: String,
        val sessionId: String,
        val title: String,
        val label: String,
        val channel: NotifyChannel,
        val postedAt: Long,
    )

    private fun activeNotification(tag: String): StatusBarNotification? =
        readActiveNotifications()?.firstOrNull { it.tag == tag }

    private fun readActiveNotifications(): List<StatusBarNotification>? = try {
        NotificationManagerCompat.from(context).activeNotifications
    } catch (_: SecurityException) {
        null
    }

    /**
     * Rebuilds the group's summary from the notifications that exist right
     * now, plus the child just posted ([added]) or minus the one just closed
     * ([removedTag]) — the system's own list lags one binder call behind.
     * A group without children loses its summary.
     */
    private fun refreshGroupSummary(
        groupKey: String,
        added: GroupChild? = null,
        removedTag: String? = null,
        active: List<StatusBarNotification>? = null,
    ) {
        // Without the system's list a summary built from [added] alone would
        // undercount the group; leaving the old one is less wrong.
        val shown = active ?: readActiveNotifications() ?: return
        val children = groupChildren(shown, groupKey, added, removedTag)
        val manager = NotificationManagerCompat.from(context)
        if (children.isEmpty()) {
            runCatching { manager.cancel(groupSummaryTag(groupKey), GROUP_SUMMARY_ID) }
            return
        }
        val label = children.firstNotNullOfOrNull { it.label.takeIf(String::isNotBlank) }
            ?: groupKey.substringAfterLast('/').takeIf { it.isNotBlank() }
            ?: context.getString(R.string.notify_status_title)
        val sessions = children.mapTo(HashSet()) { it.sessionId.ifBlank { it.tag } }
        val titles = children.map { it.title }.filter { it.isNotBlank() }
        val summaryChannel = children.map { it.channel }.maxByOrNull { it.summaryRank } ?: NotifyChannel.Completed
        val style = NotificationCompat.InboxStyle()
        titles.take(MAX_SUMMARY_LINES).forEach(style::addLine)
        val summary = NotificationCompat.Builder(context, summaryChannel.androidChannelId(vibrate = false))
            .setSmallIcon(R.drawable.ic_notify_summary)
            .setColor(ContextCompat.getColor(context, R.color.notify_accent_summary))
            .setContentTitle(
                context.resources.getQuantityString(R.plurals.notify_group_summary, sessions.size, sessions.size, label),
            )
            .setContentText(titles.firstOrNull() ?: label)
            .setStyle(style)
            .setContentIntent(openSessionIntent(null, groupSummaryTag(groupKey)))
            .setGroup(groupKey)
            .setGroupSummary(true)
            // The children alert on their own; the summary must not repeat it.
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .setSilent(true)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(privateVersion(summaryChannel))
            .build()
        notify(groupSummaryTag(groupKey), GROUP_SUMMARY_ID, summary)
    }

    private fun groupChildren(
        active: List<StatusBarNotification>?,
        groupKey: String,
        added: GroupChild?,
        removedTag: String?,
    ): List<GroupChild> {
        val fromSystem = active.orEmpty().mapNotNull { shown ->
            val notification = shown.notification
            val tag = shown.tag ?: return@mapNotNull null
            if (tag == removedTag || tag == added?.tag) return@mapNotNull null
            if (notification.group != groupKey) return@mapNotNull null
            if (notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return@mapNotNull null
            GroupChild(
                tag = tag,
                sessionId = notification.extras.getString(NotificationIntents.EXTRA_SESSION_ID).orEmpty(),
                title = notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty(),
                label = notification.extras.getString(NotificationIntents.EXTRA_PROJECT_LABEL).orEmpty(),
                channel = notifyChannelFor(notification.channelId) ?: NotifyChannel.Completed,
                postedAt = shown.postTime,
            )
        }
        return (fromSystem + listOfNotNull(added))
            .sortedByDescending { it.postedAt }
    }

    private fun groupSummaryTag(groupKey: String): String = "group:$groupKey"

    /** Which child's channel the summary borrows its importance from. */
    private val NotifyChannel.summaryRank: Int get() = when (this) {
        NotifyChannel.NeedsInput -> 3
        NotifyChannel.Errors -> 2
        NotifyChannel.Completed -> 1
        NotifyChannel.ModelSwitch, NotifyChannel.AgentMessages -> 0
        NotifyChannel.ConnectionStatus -> -1
    }

    private fun notify(tag: String, id: Int, notification: Notification): Boolean = try {
        NotificationManagerCompat.from(context).notify(tag, id, notification)
        true
    } catch (_: SecurityException) {
        false
    }

    /**
     * Fired by the system when the user swipes a grouped child away (a tap
     * auto-cancels without it, hence the foreground rebuild). The receiver
     * re-derives the summary; without it the count/title would stay stale
     * until the next post into the group.
     */
    private fun dismissIntent(tag: String, groupKey: String): PendingIntent {
        val intent = Intent(context, NotificationActionReceiver::class.java).apply {
            action = NotificationIntents.ACTION_DISMISS
            // Unique data per tag: PendingIntent equality would otherwise
            // merge the delete intents of two children into one.
            data = Uri.parse("ompweb://notify/${Uri.encode(tag)}/dismiss")
            putExtra(NotificationIntents.EXTRA_TAG, tag)
            putExtra(NotificationIntents.EXTRA_GROUP_KEY, groupKey)
        }
        return PendingIntent.getBroadcast(
            context,
            tag.hashCode() * 31 + DISMISS_REQUEST_CODE,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun openSessionIntent(sessionId: String?, tag: String): PendingIntent {
        val session = sessionId?.takeIf { it.isNotBlank() }
        val intent = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            session?.let {
                putExtra(NotificationIntents.EXTRA_SESSION_ID, it)
                // Only this app's own PendingIntent can carry a valid token, so
                // the exported activity can tell a tap from a foreign intent.
                putExtra(NotificationIntents.EXTRA_OPEN_TOKEN, NotificationOpenToken.sign(context, it))
                origin()?.let { server -> putExtra(NotificationIntents.EXTRA_ORIGIN, server) }
            }
        }
        return PendingIntent.getActivity(
            context,
            tag.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun answerIntent(
        tag: String,
        index: Int,
        sessionId: String,
        requestId: String?,
        answerJson: String?,
        replyKind: String?,
        askQuestionId: String?,
        title: String,
        channelId: String,
        remoteInput: Boolean = false,
    ): PendingIntent {
        val intent = Intent(context, NotificationActionReceiver::class.java).apply {
            action = NotificationIntents.ACTION_ANSWER
            // Unique data per tag/action: otherwise PendingIntent equality
            // would merge the answer of one dialog into another.
            data = Uri.parse("ompweb://notify/${Uri.encode(tag)}/$index")
            putExtra(NotificationIntents.EXTRA_SESSION_ID, sessionId)
            putExtra(NotificationIntents.EXTRA_TAG, tag)
            putExtra(NotificationIntents.EXTRA_TITLE, title)
            putExtra(NotificationIntents.EXTRA_CHANNEL_ID, channelId)
            origin()?.let { putExtra(NotificationIntents.EXTRA_ORIGIN, it) }
            requestId?.let { putExtra(NotificationIntents.EXTRA_REQUEST_ID, it) }
            answerJson?.let { putExtra(NotificationIntents.EXTRA_ANSWER_JSON, it) }
            replyKind?.let { putExtra(NotificationIntents.EXTRA_REPLY_KIND, it) }
            askQuestionId?.let { putExtra(NotificationIntents.EXTRA_ASK_QUESTION_ID, it) }
        }
        // Android 12 refuses to post a notification whose RemoteInput action
        // carries an immutable PendingIntent and ignores the fill-in intent that
        // holds the typed text. Only the Reply action is mutable; buttons and
        // content intents stay immutable.
        val mutability = if (remoteInput && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            PendingIntent.FLAG_MUTABLE
        } else {
            PendingIntent.FLAG_IMMUTABLE
        }
        return PendingIntent.getBroadcast(
            context,
            tag.hashCode() * 31 + index,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or mutability,
        )
    }

    /**
     * Every answer/reply action needs an unlocked device on API 31+ (the
     * compat builder forwards this to the platform action). Below 31 the
     * receiver's own keyguard check opens the app instead.
     */
    private fun actionBuilder(
        label: String,
        intent: PendingIntent,
    ): NotificationCompat.Action.Builder {
        val builder = NotificationCompat.Action.Builder(R.drawable.ic_notification, label, intent)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setAuthenticationRequired(true)
        }
        return builder
    }

    private fun privateVersion(channel: NotifyChannel): Notification =
        NotificationCompat.Builder(context, channel.androidChannelId(vibrate = false))
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.app_name))
            .setContentText(context.getString(R.string.notify_private_body))
            .setContentIntent(openSessionIntent(null, channel.quietId))
            .setPriority(priority(channel))
            .build()

    private fun priority(channel: NotifyChannel): Int = when (channel) {
        NotifyChannel.NeedsInput, NotifyChannel.Errors -> NotificationCompat.PRIORITY_HIGH
        NotifyChannel.Completed, NotifyChannel.AgentMessages -> NotificationCompat.PRIORITY_DEFAULT
        NotifyChannel.ModelSwitch -> NotificationCompat.PRIORITY_LOW
        NotifyChannel.ConnectionStatus -> NotificationCompat.PRIORITY_MIN
    }

    /** The monochrome 24 dp small icon of one notification type. */
    private fun iconFor(channel: NotifyChannel): Int = when (channel) {
        NotifyChannel.Completed -> R.drawable.ic_notify_completed
        NotifyChannel.NeedsInput -> R.drawable.ic_notify_input
        NotifyChannel.Errors -> R.drawable.ic_notify_error
        NotifyChannel.ModelSwitch -> R.drawable.ic_notify_model_switch
        NotifyChannel.ConnectionStatus -> R.drawable.ic_notify_connection
        NotifyChannel.AgentMessages -> R.drawable.ic_notify_message
    }

    /** The accent the system tints the icon and app name with (theme status tokens). */
    private fun colorFor(channel: NotifyChannel): Int = ContextCompat.getColor(
        context,
        when (channel) {
            NotifyChannel.Completed -> R.color.notify_accent_completed
            NotifyChannel.NeedsInput -> R.color.notify_accent_input
            NotifyChannel.Errors -> R.color.notify_accent_error
            NotifyChannel.ModelSwitch -> R.color.notify_accent_model_switch
            NotifyChannel.ConnectionStatus -> R.color.notify_accent_connection
            NotifyChannel.AgentMessages -> R.color.notify_accent_message
        },
    )

    private companion object {
        const val EVENT_NOTIFICATION_ID = 1
        const val TEST_NOTIFICATION_ID = 2
        const val GROUP_SUMMARY_ID = 3
        const val AGENT_MESSAGE_ID_BASE = 4_100

        /** Separates the delete intent's request code from the answer actions'. */
        const val DISMISS_REQUEST_CODE = 6

        /** The summary's inbox never needs more lines than the shade shows. */
        const val MAX_SUMMARY_LINES = 5

        val agentMessageIds = AtomicInteger()
    }
}
