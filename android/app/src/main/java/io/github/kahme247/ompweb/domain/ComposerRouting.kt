package io.github.kahme247.ompweb.domain

/**
 * Where a composer submission goes. The chat and new-session composers share
 * these rules (web `handleSend` / `sendQueued`) so a `!cmd`, a web slash
 * command, a client built-in and a plain prompt behave identically on both
 * surfaces.
 */
sealed interface ComposerRoute {
    /** `!cmd` / `!!cmd`, only valid without attachments. */
    data class Bash(val invocation: BashInvocation) : ComposerRoute

    /** A web slash command expanded into a real instruction. */
    data class WebPrompt(
        val name: String,
        val args: String,
        val prompt: String,
    ) : ComposerRoute

    /** A web command whose required argument is missing; the text stays. */
    data class Usage(val command: String, val argumentHint: String) : ComposerRoute

    /** A client-owned action command (`/compact`, `/reload`, …). */
    data class Builtin(val name: String, val args: String) : ComposerRoute

    /** Everything else: send [prompt] (text attachments already inlined). */
    data class Prompt(val prompt: String) : ComposerRoute
}

/**
 * Classify [raw] before routing. [prompt] is the resolved prompt (attachments
 * inlined); [bash] is the parsed shell invocation when the composer accepted
 * one. Attachments disable both shell mode and slash routing, exactly like the
 * web composer.
 */
fun routeComposerSubmission(
    raw: String,
    prompt: String,
    hasAttachments: Boolean,
    hasImages: Boolean,
    bash: BashInvocation?,
): ComposerRoute {
    if (bash != null) return ComposerRoute.Bash(bash)
    if (hasAttachments || hasImages || !raw.startsWith("/")) return ComposerRoute.Prompt(prompt)
    val match = Regex("^/(\\S+)(?:\\s+([\\s\\S]*))?$").find(raw) ?: return ComposerRoute.Prompt(prompt)
    val name = match.groupValues[1]
    val args = match.groupValues[2].trim()
    if (getWebSlashCommand(name) != null) {
        return when (val expansion = expandWebSlashCommand(raw)) {
            is WebSlashExpansion.Expand -> ComposerRoute.WebPrompt(name, args, expansion.prompt)
            is WebSlashExpansion.UsageError ->
                ComposerRoute.Usage(expansion.command, expansion.argumentHint)
            WebSlashExpansion.NotWeb -> ComposerRoute.Prompt(prompt)
        }
    }
    if (isClientBuiltinCommand(name)) return ComposerRoute.Builtin(name, args)
    return ComposerRoute.Prompt(prompt)
}
