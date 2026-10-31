package io.github.kahme247.ompweb.domain

/**
 * Policy and text format for the environment variables handed to the `omp`
 * child process — the port of `lib/omp/agent-env-policy.ts`, so the Settings
 * editor rejects exactly what the server would reject instead of letting an
 * invalid line travel to `PUT /api/web-settings` first.
 *
 * Users only add variables, never rewrite the plumbing omp-web depends on:
 * process plumbing (`PATH`, `NODE_OPTIONS`, …), omp's own state roots
 * (`HOME`, `PI_CODING_AGENT_DIR`, …) and the keys the server strips from every
 * child spawn (`PORT`, `NODE_ENV`, `NEXT_*`) are denied. Matching is
 * case-insensitive because Windows environment names are.
 */
data class AgentEnvParseResult(
    val values: Map<String, String>,
    /** One English problem per offending line, prefixed with the line number. */
    val errors: List<String>,
) {
    val valid: Boolean get() = errors.isEmpty()
}

object AgentEnv {

    /** Shell-style variable name: no dots, dashes or leading digits. */
    val NAME_PATTERN: Regex = Regex("^[A-Za-z_][A-Za-z0-9_]*$")

    /**
     * Exact names that may never be overridden, compared upper-cased. Grouped
     * by the failure they prevent (see the file comment).
     */
    val DENIED_NAMES: Set<String> = setOf(
        // Process plumbing: a rewritten PATH breaks omp's binary/tool lookup,
        // NODE_OPTIONS injects code into every child node process.
        "PATH",
        "PATHEXT",
        "COMSPEC",
        "SYSTEMROOT",
        "WINDIR",
        "NODE_OPTIONS",
        // Where omp keeps its state; redirecting these splits the child from
        // the ~/.omp omp-web enumerates.
        "HOME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "PI_CODING_AGENT_DIR",
        "PI_CONFIG_DIR",
        "OMP_PROFILE",
        "PI_PROFILE",
        // Stripped from every spawn by lib/project-command-env.ts, so a user
        // override would be discarded without a word.
        "PORT",
        "NODE_ENV",
    )

    /** Prefixes that may never be overridden (compared upper-cased). */
    val DENIED_PREFIXES: List<String> = listOf(
        "OMP_WEB_", // omp-web's own plumbing (auth, ports, binary overrides)
        "NEXT_", // stripped by sanitizeProjectCommandEnvironment
        "_", // shell-internal namespace
    )

    /** True when [name] is reserved by omp-web and may not be overridden. */
    fun isDeniedName(name: String): Boolean {
        val comparable = name.uppercase()
        return comparable in DENIED_NAMES || DENIED_PREFIXES.any { comparable.startsWith(it) }
    }

    /**
     * Parses `KEY=VALUE` text. Blank lines and `#` comments are ignored, an
     * `export ` prefix is tolerated and values are literal after the first
     * `=` (trimmed, no quote/escape processing). A later assignment wins.
     * Rejected lines are reported and left out of [AgentEnvParseResult.values].
     */
    fun parse(raw: String?): AgentEnvParseResult {
        val values = LinkedHashMap<String, String>()
        val errors = mutableListOf<String>()
        val lines = (raw ?: "").split(Regex("\r?\n"))
        lines.forEachIndexed { index, rawLine ->
            val line = index + 1
            val trimmed = rawLine.trim()
            if (trimmed.isEmpty() || trimmed.startsWith("#")) return@forEachIndexed
            // `export KEY=VALUE` is what a NixOS-style generated .env looks like.
            val body = trimmed.replace(Regex("^export\\s+"), "")
            val separator = body.indexOf('=')
            if (separator == -1) {
                errors += "Line $line: expected KEY=VALUE"
                return@forEachIndexed
            }
            val name = body.substring(0, separator).trim()
            if (name.isEmpty()) {
                errors += "Line $line: missing variable name"
                return@forEachIndexed
            }
            if (!NAME_PATTERN.matches(name)) {
                errors += "Line $line: \"$name\" is not a valid variable name"
                return@forEachIndexed
            }
            if (isDeniedName(name)) {
                errors += "Line $line: \"$name\" is reserved by omp-web and cannot be set"
                return@forEachIndexed
            }
            values[name] = body.substring(separator + 1).trim()
        }
        return AgentEnvParseResult(values, errors)
    }

    /** Validates an already-structured record with the same rules (server payloads). */
    fun sanitize(values: Map<String, String>): AgentEnvParseResult =
        parse(values.entries.joinToString("\n") { (name, value) -> "$name=$value" })

    /** Canonical `KEY=VALUE` text, sorted by name so saves stay stable and diffable. */
    fun format(values: Map<String, String>): String =
        values.entries.sortedBy { it.key }.joinToString("\n") { (name, value) -> "$name=$value" }
}
