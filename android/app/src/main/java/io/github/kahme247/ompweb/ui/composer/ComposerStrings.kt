package io.github.kahme247.ompweb.ui.composer

import android.content.Context
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.SlashCommandItem
import io.github.kahme247.ompweb.domain.SlashCommandSource

/**
 * Localized strings the composer view models need but cannot read themselves
 * (they hold no `Context`). Resolved once in `AppContainer` so the VMs stay
 * plain JVM code.
 */
data class ComposerStrings(
    val queuedWhileShellRunning: String = "",
    val queueRestoreUncertain: String = "",
    val queueDiscardFailed: String = "",
    val commandRequiresArgs: String = "Usage: %1\$s %2\$s",
    val advisorDisabled: String = "",
    val noSession: String = "",
    /** A9: why a Send on an unvalidated workspace does nothing. */
    val cwdInvalid: String = "",
    val nameUsage: String = "",
    val sessionRenamed: String = "Session renamed to %1\$s",
    val noMessageToCopy: String = "",
    val copiedLastMessage: String = "",
    val compactedContext: String = "",
    val reloadedResources: String = "",
    val unknownCommand: String = "/%1\$s is not a command this session can run — it was sent as plain text.",
    val queuedRemovalUnavailable: String = "",
    val queuedPromotionUnavailable: String = "",
    val shellSessionFailed: String = "",
    /** The submit-time live-state read failed; the draft was kept. */
    val liveStateUnknown: String = "",
    /** The chat was left (or signed out) while the submit waited; nothing was sent, the draft stays. */
    val submitAbandoned: String = "",
    /** Another omp process runs the chat: the send was refused, the draft stays. */
    val foreignSendBlocked: String = "",
    /** Another omp process runs the chat: a non-send command was refused (409). */
    val foreignCommandBlocked: String = "",
    /** `/btw` refuses attachments; the draft (and its files) stay in the field. */
    val btwAttachmentsUnsupported: String = "",
    val imageSkipped: String = "%1\$d image(s) skipped (up to %2\$s each).",
    val filesSkipped: String = "%1\$d file(s) skipped.",
    /** Localized `[hint]` per web-command key (`WebSlashCommand.argumentHintKey`). */
    val usageHints: Map<String, String> = emptyMap(),
    val builtinCommands: List<SlashCommandItem> = emptyList(),
) {
    fun requiresArgs(command: String, argumentHintKey: String): String =
        String.format(commandRequiresArgs, command, usageHints[argumentHintKey] ?: argumentHintKey)

    fun renamed(name: String): String = String.format(sessionRenamed, name)

    fun unknownCommand(name: String): String = String.format(unknownCommand, name)

    companion object {
        /** The client-owned palette rows (`BUILTIN_SLASH_COMMAND_NAMES`, localized descriptions). */
        fun builtinPalette(context: Context): List<SlashCommandItem> {
            val app = context.applicationContext
            fun item(name: String, desc: Int, hint: Int? = null) = SlashCommandItem(
                name = name,
                description = app.getString(desc),
                argumentHint = hint?.let(app::getString),
                source = SlashCommandSource.BUILTIN,
            )
            return listOf(
                item("goal", R.string.composer_cmd_goal_desc, R.string.composer_cmd_goal_arg),
                item("plan", R.string.composer_cmd_plan_desc, R.string.composer_cmd_plan_arg),
                item("review", R.string.composer_cmd_review_desc, R.string.composer_cmd_review_arg),
                item("fix", R.string.composer_cmd_fix_desc, R.string.composer_cmd_fix_arg),
                item("test", R.string.composer_cmd_test_desc, R.string.composer_cmd_test_arg),
                item("explain", R.string.composer_cmd_explain_desc, R.string.composer_cmd_explain_arg),
                item("simplify", R.string.composer_cmd_simplify_desc, R.string.composer_cmd_simplify_arg),
                item("commit", R.string.composer_cmd_commit_desc, R.string.composer_cmd_commit_arg),
                item("advisor", R.string.composer_cmd_advisor_desc, R.string.composer_cmd_advisor_arg),
                item("loop", R.string.composer_cmd_loop_desc, R.string.composer_cmd_loop_arg),
                item("btw", R.string.composer_cmd_btw_desc, R.string.composer_cmd_btw_arg),
                item("compact", R.string.composer_cmd_compact_desc),
                item("reload", R.string.composer_cmd_reload_desc),
                item("name", R.string.composer_cmd_name_desc),
                item("session", R.string.composer_cmd_session_desc),
                item("copy", R.string.composer_cmd_copy_desc),
            )
        }

        fun from(context: Context): ComposerStrings {
            val app = context.applicationContext
            return ComposerStrings(
                queuedWhileShellRunning = app.getString(R.string.composer_notice_queued_while_shell),
                queueRestoreUncertain = app.getString(R.string.composer_notice_queue_restore_uncertain),
                queueDiscardFailed = app.getString(R.string.composer_notice_queue_discard_failed),
                commandRequiresArgs = app.getString(R.string.composer_notice_command_requires_args),
                advisorDisabled = app.getString(R.string.composer_notice_advisor_disabled),
                noSession = app.getString(R.string.composer_notice_no_session),
                cwdInvalid = app.getString(R.string.cwd_invalid),
                nameUsage = app.getString(R.string.composer_notice_name_usage),
                sessionRenamed = app.getString(R.string.composer_notice_session_renamed),
                noMessageToCopy = app.getString(R.string.composer_notice_no_message_copy),
                copiedLastMessage = app.getString(R.string.composer_notice_copied),
                compactedContext = app.getString(R.string.composer_notice_compacted),
                reloadedResources = app.getString(R.string.composer_notice_reloaded),
                unknownCommand = app.getString(R.string.composer_notice_unknown_command),
                queuedRemovalUnavailable = app.getString(R.string.composer_notice_queued_removal_unavailable),
                queuedPromotionUnavailable = app.getString(R.string.composer_notice_queued_promotion_unavailable),
                shellSessionFailed = app.getString(R.string.composer_notice_shell_session_failed),
                liveStateUnknown = app.getString(R.string.composer_notice_live_state_unknown),
                submitAbandoned = app.getString(R.string.composer_notice_submit_abandoned),
                foreignSendBlocked = app.getString(R.string.composer_notice_foreign_owner_blocked),
                foreignCommandBlocked = app.getString(R.string.composer_notice_foreign_owner_command_blocked),
                btwAttachmentsUnsupported = app.getString(R.string.btw_attachments_unsupported),
                imageSkipped = app.getString(R.string.composer_attach_image_skipped),
                filesSkipped = app.getString(R.string.composer_attach_file_skipped),
                usageHints = mapOf(
                    "composer_cmd_goal_arg" to app.getString(R.string.composer_cmd_goal_arg),
                    "composer_cmd_plan_arg" to app.getString(R.string.composer_cmd_plan_arg),
                    "composer_cmd_review_arg" to app.getString(R.string.composer_cmd_review_arg),
                    "composer_cmd_fix_arg" to app.getString(R.string.composer_cmd_fix_arg),
                    "composer_cmd_test_arg" to app.getString(R.string.composer_cmd_test_arg),
                    "composer_cmd_explain_arg" to app.getString(R.string.composer_cmd_explain_arg),
                    "composer_cmd_simplify_arg" to app.getString(R.string.composer_cmd_simplify_arg),
                    "composer_cmd_commit_arg" to app.getString(R.string.composer_cmd_commit_arg),
                    "composer_cmd_advisor_arg" to app.getString(R.string.composer_cmd_advisor_arg),
                    "composer_cmd_loop_arg" to app.getString(R.string.composer_cmd_loop_arg),
                ),
                builtinCommands = builtinPalette(app),
            )
        }
    }
}
