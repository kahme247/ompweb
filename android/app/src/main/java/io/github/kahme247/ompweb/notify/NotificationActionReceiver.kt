package io.github.kahme247.ompweb.notify

import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import io.github.kahme247.ompweb.MainActivity
import io.github.kahme247.ompweb.OmpWebApplication
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.NotifyAnswer
import io.github.kahme247.ompweb.domain.NotifyChannel
import io.github.kahme247.ompweb.domain.ReplyTarget
import io.github.kahme247.ompweb.domain.parseNotifyAnswer
import io.github.kahme247.ompweb.domain.replyAnswer
import io.github.kahme247.ompweb.domain.sanitizeReplyText
import io.github.kahme247.ompweb.net.AnswerOutcome
import io.github.kahme247.ompweb.net.captureApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

/**
 * Answers a notification action without opening the app: `goAsync()` plus one
 * short coroutine (no WorkManager). The server's answer route never spawns
 * omp; a completed run's Reply is a regular follow-up prompt instead.
 *
 * Results replace the notification: "Sent", "Already answered" or "Failed —
 * open app". On API < 31 the notification cannot require authentication, so a
 * locked device opens the app instead of answering; API 31+ actions are
 * marked `setAuthenticationRequired(true)` by the renderer.
 */
class NotificationActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == NotificationIntents.ACTION_DISMISS) {
            // Rebuilding a summary only needs the NotificationManager; going
            // through the app container would boot stores, network and the
            // event service from a swipe on the shade.
            dismiss(
                intent,
                AndroidNotifier(context.applicationContext, origin = { null }, vibrate = { false }),
            )
            return
        }
        if (intent.action != NotificationIntents.ACTION_ANSWER) return
        val sessionId = intent.getStringExtra(NotificationIntents.EXTRA_SESSION_ID) ?: return
        val tag = intent.getStringExtra(NotificationIntents.EXTRA_TAG) ?: return
        val application = context.applicationContext as? OmpWebApplication ?: return

        val keyguard = context.getSystemService(KeyguardManager::class.java)
        if (keyguard?.isDeviceLocked == true) {
            openApp(context, sessionId)
            return
        }

        val pending = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                withTimeout(TIMEOUT_MILLIS) {
                    handle(application, intent, sessionId, tag)
                }
            } catch (_: TimeoutCancellationException) {
                showResult(context, intent, tag, sessionId, R.string.notify_result_failed)
            } catch (_: Exception) {
                showResult(context, intent, tag, sessionId, R.string.notify_result_failed)
            } finally {
                pending.finish()
            }
        }
    }

    private suspend fun handle(
        application: OmpWebApplication,
        intent: Intent,
        sessionId: String,
        tag: String,
    ) {
        val container = application.container
        // A cold process (notification action after the app was swiped away)
        // has no origin until the first DataStore emission; without this wait
        // every request is NotConfigured and the answer is lost.
        container.settings.awaitLoaded()
        // A notification of a server the user left must never answer into the
        // configured one (mirrors the origin-bound cookie): silently drop it.
        if (
            !NotificationIntents.acceptsOrigin(
                intent.getStringExtra(NotificationIntents.EXTRA_ORIGIN),
                container.settings.originNow()?.origin,
            )
        ) {
            return
        }
        val replyKind = intent.getStringExtra(NotificationIntents.EXTRA_REPLY_KIND)

        if (replyKind != null) {
            val text = sanitizeReplyText(
                RemoteInput.getResultsFromIntent(intent)?.getCharSequence(NotificationIntents.REPLY_KEY),
            )
            if (text == null) {
                openApp(application, sessionId)
                return
            }
            val target = when (replyKind) {
                NotificationIntents.REPLY_INPUT -> ReplyTarget.Input
                NotificationIntents.REPLY_FOLLOW_UP -> ReplyTarget.FollowUp
                NotificationIntents.REPLY_ASK -> {
                    val questionId = intent.getStringExtra(NotificationIntents.EXTRA_ASK_QUESTION_ID)
                    if (questionId.isNullOrBlank()) {
                        showResult(application, intent, tag, sessionId, R.string.notify_result_failed)
                        return
                    }
                    ReplyTarget.Ask(questionId)
                }
                else -> {
                    showResult(application, intent, tag, sessionId, R.string.notify_result_failed)
                    return
                }
            }
            val answer = replyAnswer(target, text)
            if (answer == null) {
                // `completed` Reply: a follow-up prompt, not a dialog answer.
                val result = captureApi { container.notificationsApi.followUp(sessionId, text) }
                result.fold(
                    onSuccess = { showResult(application, intent, tag, sessionId, R.string.notify_result_sent) },
                    onFailure = { showResult(application, intent, tag, sessionId, R.string.notify_result_failed) },
                )
            } else {
                answer(application, intent, tag, sessionId, answer)
            }
            return
        }

        val requestId = intent.getStringExtra(NotificationIntents.EXTRA_REQUEST_ID)
        val answer = parseNotifyAnswer(intent.getStringExtra(NotificationIntents.EXTRA_ANSWER_JSON))
        if (requestId.isNullOrBlank() || answer == null) {
            showResult(application, intent, tag, sessionId, R.string.notify_result_failed)
            return
        }
        answer(application, intent, tag, sessionId, answer)
    }

    private suspend fun answer(
        application: OmpWebApplication,
        intent: Intent,
        tag: String,
        sessionId: String,
        answer: NotifyAnswer,
    ) {
        val requestId = intent.getStringExtra(NotificationIntents.EXTRA_REQUEST_ID)
        if (requestId.isNullOrBlank()) {
            showResult(application, intent, tag, sessionId, R.string.notify_result_failed)
            return
        }
        val outcome = captureApi {
            application.container.notificationsApi.answer(sessionId, requestId, answer)
        }
        val text = outcome.fold(
            onSuccess = { status ->
                when (status) {
                    AnswerOutcome.Answered -> R.string.notify_result_sent
                    AnswerOutcome.AlreadySettled -> R.string.notify_result_already
                    AnswerOutcome.SessionGone -> R.string.notify_result_failed
                }
            },
            onFailure = { R.string.notify_result_failed },
        )
        showResult(application, intent, tag, sessionId, text)
    }

    private fun showResult(
        context: Context,
        intent: Intent,
        tag: String,
        sessionId: String,
        textRes: Int,
    ) {
        val application = context.applicationContext as? OmpWebApplication ?: return
        val title = intent.getStringExtra(NotificationIntents.EXTRA_TITLE)
            ?: context.getString(R.string.notify_status_title)
        val channelId = intent.getStringExtra(NotificationIntents.EXTRA_CHANNEL_ID)
            ?: NotifyChannel.Completed.id
        application.container.notifications.notifier.postResult(
            tag = tag,
            title = title,
            channelId = channelId,
            text = context.getString(textRes),
            sessionId = sessionId,
        )
    }

    private fun openApp(context: Context, sessionId: String) {
        val application = context.applicationContext as? OmpWebApplication ?: return
        val launch = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(NotificationIntents.EXTRA_SESSION_ID, sessionId)
            putExtra(NotificationIntents.EXTRA_OPEN_TOKEN, NotificationOpenToken.sign(application, sessionId))
            application.container.settings.originNow()?.origin?.let {
                putExtra(NotificationIntents.EXTRA_ORIGIN, it)
            }
        }
        runCatching { context.startActivity(launch) }
    }

    internal companion object {
        /** Long enough for a slow Tailscale round trip, short enough for a broadcast. */
        const val TIMEOUT_MILLIS = 20_000L

        /**
         * A grouped child was swiped away: rebuild its project's summary. The
         * tag is handed over as removed because the system's list still holds
         * the child when the delete broadcast arrives.
         */
        fun dismiss(intent: Intent, notifier: Notifier) {
            if (intent.action != NotificationIntents.ACTION_DISMISS) return
            val tag = intent.getStringExtra(NotificationIntents.EXTRA_TAG) ?: return
            val groupKey = intent.getStringExtra(NotificationIntents.EXTRA_GROUP_KEY) ?: return
            notifier.onGroupChildDismissed(groupKey, tag)
        }
    }
}
