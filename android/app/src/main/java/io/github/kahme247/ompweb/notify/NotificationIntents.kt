package io.github.kahme247.ompweb.notify

/**
 * Intent extras shared by the notification renderer, the answer receiver and
 * the activity. Kept as strings because broadcasts and PendingIntents cannot
 * carry Kotlin objects.
 */
object NotificationIntents {
    const val EXTRA_SESSION_ID = "io.github.kahme247.ompweb.notify.sessionId"
    const val EXTRA_TAG = "io.github.kahme247.ompweb.notify.tag"
    const val EXTRA_REQUEST_ID = "io.github.kahme247.ompweb.notify.requestId"
    const val EXTRA_ANSWER_JSON = "io.github.kahme247.ompweb.notify.answerJson"
    const val EXTRA_REPLY_KIND = "io.github.kahme247.ompweb.notify.replyKind"
    const val EXTRA_ASK_QUESTION_ID = "io.github.kahme247.ompweb.notify.askQuestionId"
    const val EXTRA_TITLE = "io.github.kahme247.ompweb.notify.title"
    const val EXTRA_CHANNEL_ID = "io.github.kahme247.ompweb.notify.channelId"

    /**
     * Project display label stored on a posted notification (notification
     * extras, not an intent): the group summary reads it back after a process
     * restart instead of guessing from the group key.
     */
    const val EXTRA_PROJECT_LABEL = "io.github.kahme247.ompweb.notify.projectLabel"

    /**
     * `scheme://host:port` of the server the notification belongs to. The
     * answer receiver drops an action whose origin is not the configured one,
     * so a notification left over from another server can never answer into
     * the current one.
     */
    const val EXTRA_ORIGIN = "io.github.kahme247.ompweb.notify.origin"

    /**
     * HMAC of the session id under a per-installation secret (see
     * [NotificationOpenToken]). Only this app's own PendingIntents can set it,
     * so the exported [io.github.kahme247.ompweb.MainActivity] refuses a
     * foreign intent that tries to force a chat open.
     */
    const val EXTRA_OPEN_TOKEN = "io.github.kahme247.ompweb.notify.openToken"

    /** The action of the answer broadcast. */
    const val ACTION_ANSWER = "io.github.kahme247.ompweb.notify.ANSWER"

    /**
     * The action of a grouped child's delete intent: the user swiped the
     * notification away and the project's summary must be rebuilt.
     */
    const val ACTION_DISMISS = "io.github.kahme247.ompweb.notify.DISMISS"

    /** Project group of a dismissed child ([ACTION_DISMISS]). */
    const val EXTRA_GROUP_KEY = "io.github.kahme247.ompweb.notify.groupKey"

    /** RemoteInput result key of the Reply action. */
    const val REPLY_KEY = "io.github.kahme247.ompweb.notify.reply"

    /** Reply kinds of [EXTRA_REPLY_KIND]. */
    const val REPLY_INPUT = "input"
    const val REPLY_ASK = "ask"
    const val REPLY_FOLLOW_UP = "followUp"

    /**
     * True when an action's [actionOrigin] may run against the install that is
     * configured as [configuredOrigin]. An action without the configured
     * origin — a notification of a server the user left, or a foreign
     * broadcast — is dropped instead of answering into the current server.
     */
    fun acceptsOrigin(actionOrigin: String?, configuredOrigin: String?): Boolean =
        configuredOrigin != null && actionOrigin == configuredOrigin
}
