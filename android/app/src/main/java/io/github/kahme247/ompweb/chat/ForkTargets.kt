package io.github.kahme247.ompweb.chat

/** The user entry omp's `branch`/`fork` command accepts for a transcript row. */
data class ForkTarget(val entryId: String, val editPrompt: Boolean)

/**
 * Fork targets for the transcript (web: `lib/chat-fork.ts`).
 *
 * omp only branches at a *user* entry. An assistant reply therefore forks at
 * the NEXT user prompt (keeping the reply in the new session's history); the
 * newest reply falls back to its own turn's prompt with edit-and-resend.
 * A row whose turn has no usable prompt, or that resolves to the very first
 * prompt of the session, gets no target.
 */
object ForkTargets {

    fun resolve(messages: List<ChatMessage>, entryIds: List<String?>): List<ForkTarget?> {
        val roles = messages.map { message ->
            when {
                message is ChatMessage.User && message.branchSummary -> "branchSummary"
                else -> message.role
            }
        }
        val targets = MutableList<ForkTarget?>(roles.size) { null }

        var nextUserEntryId: String? = null
        for (index in roles.indices.reversed()) {
            when (roles[index]) {
                "user" -> nextUserEntryId = entryIds.getOrNull(index)
                "assistant" -> {
                    val target = nextUserEntryId
                    if (target != null) targets[index] = ForkTarget(target, editPrompt = false)
                }
            }
        }

        var ownUserEntryId: String? = null
        var ownIsFirstPrompt = false
        for (index in roles.indices) {
            if (roles[index] == "user") {
                ownIsFirstPrompt = index == 0
                ownUserEntryId = entryIds.getOrNull(index)
            }
            if (targets[index] != null) continue
            val own = ownUserEntryId
            if (own == null || ownIsFirstPrompt) continue
            if (roles[index] == "user" || roles[index] == "assistant") {
                targets[index] = ForkTarget(own, editPrompt = true)
            }
        }
        return targets
    }
}

private val ChatMessage.role: String
    get() = when (this) {
        is ChatMessage.User -> "user"
        is ChatMessage.Assistant -> "assistant"
        is ChatMessage.ToolResult -> "toolResult"
        is ChatMessage.BashExecution -> "bashExecution"
        is ChatMessage.Custom -> "custom"
        is ChatMessage.Other -> role
    }
