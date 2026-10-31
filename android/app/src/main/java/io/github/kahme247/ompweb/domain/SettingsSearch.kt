package io.github.kahme247.ompweb.domain

/**
 * Settings tabs in the web's sidebar order (`SettingsTabs.tsx`).
 *
 * [needsWorkspace] is the invariant that a workspace-bound tab (Agents, MCP)
 * stays disabled until a session/project directory is known. The web's
 * legacy `extensions`/`skills`/`plugins` ids all normalize to [MCP].
 */
enum class SettingsTab(val wire: String, val needsWorkspace: Boolean = false) {
    GENERAL("general"),
    SAFETY("safety"),
    MODELS("models"),
    PROVIDERS("providers"),
    USAGE("usage"),
    INTELLIGENCE("intelligence"),
    AGENTS("agents", true),
    MCP("mcp"),
    NOTIFICATIONS("notifications"),
    SYSTEM("system"),
    ;

    companion object {
        fun fromWire(value: String?): SettingsTab? =
            entries.firstOrNull { it.wire == value }
    }
}

/** The web's per-row provenance chip. */
enum class SettingsScope {
    UI,
    NATIVE_OMP,
    WORKSPACE,
}

/**
 * One searchable settings row, mirroring the web's `SettingIndexEntry`
 * (`components/SettingsConfig.tsx:154-224`).
 *
 * Slice A owns the type and its own rows; the native slice appends its rows
 * with [SettingsTab] and [SettingsScope] instead of raw web strings.
 */
data class SettingsSearchEntry(
    val id: String,
    val tab: SettingsTab,
    val section: String,
    val label: String,
    val description: String,
    val scope: SettingsScope? = null,
)

/** Sidebar category, searchable by its localized label and description. */
data class SettingsCategory(
    val tab: SettingsTab,
    val label: String,
    val description: String,
)

/**
 * The sidebar order (the web's `SettingsTabs.tsx`). Labels and descriptions
 * live in the string resources so the navigation and the search index cannot
 * drift apart; [SettingsScreen] builds the searchable [SettingsCategory] list
 * from them.
 */
val SETTINGS_CATEGORIES: List<SettingsTab> = SettingsTab.entries

private const val SECTION_INTERFACE = "Interface & Behavior"
private const val SECTION_USAGE = "Usage"
private const val SECTION_SYSTEM = "System & Updates"
private const val SECTION_NOTIFICATIONS = "Notifications"

/**
 * Slice A's rows: the local UI preferences, the Usage tab's sections, the
 * app-side System & Updates rows and the notification rows. Native OMP and
 * the providers/agents rows come from the other slices and are merged by
 * [settingsSearchEntries].
 */
val LOCAL_SETTINGS_SEARCH_ENTRIES: List<SettingsSearchEntry> = listOf(
    // Interface & Behavior (General tab)
    SettingsSearchEntry(
        "completion-sound",
        SettingsTab.GENERAL,
        SECTION_INTERFACE,
        "Completion sound",
        "Play a tone when the agent completes a run.",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "keep-tool-calls-collapsed",
        SettingsTab.GENERAL,
        SECTION_INTERFACE,
        "Keep tool calls collapsed",
        "Show only compact headers while tools execute.",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "expand-thinking-by-default",
        SettingsTab.GENERAL,
        SECTION_INTERFACE,
        "Expand thinking blocks by default",
        "Open every thinking block as it appears, including while it streams, so reasoning is readable without clicking each one. Collapsing a block by hand still works.",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "hide-tool-activity",
        SettingsTab.GENERAL,
        SECTION_INTERFACE,
        "Hide tool activity while working",
        "Fold a running turn's tool calls into one Process details row, the same way a finished turn folds them. Expand the row to see each call and its result.",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "open-url-automatically",
        SettingsTab.GENERAL,
        SECTION_INTERFACE,
        "Open agent links without asking",
        "Links the agent opens from the session you are viewing open right away. Links from other sessions always ask first.",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "tts-autoplay",
        SettingsTab.GENERAL,
        SECTION_INTERFACE,
        "Auto-read assistant responses",
        "Automatically read aloud new assistant replies when completed.",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "tts-voice",
        SettingsTab.GENERAL,
        SECTION_INTERFACE,
        "Speech Voice",
        "Select the installed device voice for text-to-speech reading.",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "chat-font-size",
        SettingsTab.GENERAL,
        SECTION_INTERFACE,
        "Chat Font Size",
        "Adjust text size for conversation messages, code blocks, and markdown output.",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "ui-scale",
        SettingsTab.GENERAL,
        SECTION_INTERFACE,
        "Interface Scale",
        "Adjust overall UI zoom and display density across dialogs, buttons, and toolbars.",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "touch-targets",
        SettingsTab.GENERAL,
        SECTION_INTERFACE,
        "Touch Targets",
        "Adjust interactive target sizes for buttons and toolbar controls.",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "message-during-active-run",
        SettingsTab.GENERAL,
        SECTION_INTERFACE,
        "Message during active run",
        "What the composer does on submit while the agent runs. Steer interrupts; Queue follow-up delivers after finish.",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "word-completion",
        SettingsTab.GENERAL,
        SECTION_INTERFACE,
        "Word completion",
        "Ghost text from omp's word prediction. Auto enables it only with a hardware keyboard.",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "dictation-engine",
        SettingsTab.GENERAL,
        SECTION_INTERFACE,
        "Dictation engine",
        "Auto uses the connected server and falls back to this phone. On-device recognition types the words into the message while you speak; the server path uploads a recording.",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "dictation-language",
        SettingsTab.GENERAL,
        SECTION_INTERFACE,
        "Dictation language",
        "Language for on-device speech recognition. Default follows the device language.",
        SettingsScope.UI,
    ),
    // Usage & Analytics
    SettingsSearchEntry(
        "usage-summary",
        SettingsTab.USAGE,
        SECTION_USAGE,
        "Usage & Analytics",
        "Tokens, costs, cache analytics, and model breakdown",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "token-cost",
        SettingsTab.USAGE,
        SECTION_USAGE,
        "Raw Token Cost",
        "Token expenditure across providers and models",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "cache-savings",
        SettingsTab.USAGE,
        SECTION_USAGE,
        "Cache Savings",
        "Prompt caching savings and cost quality breakdown",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "usage-time-series",
        SettingsTab.USAGE,
        SECTION_USAGE,
        "Spend over time",
        "Token spend over the selected usage range, as cost or tokens.",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "model-breakdown",
        SettingsTab.USAGE,
        SECTION_USAGE,
        "Model Breakdown",
        "Historical token usage and cost per model, day, and project",
        SettingsScope.UI,
    ),
    // System & Updates
    SettingsSearchEntry(
        "auto-resume-sessions",
        SettingsTab.SYSTEM,
        SECTION_SYSTEM,
        "Resume running sessions after a restart",
        "When omp-web restarts while agents are working, restart those sessions and tell each agent: \"Session interrupted and resumed. Continue as you would have done without the interruption.\" Work in progress at the moment of the restart, such as a running command, is lost.",
    ),
    SettingsSearchEntry(
        "agent-env",
        SettingsTab.SYSTEM,
        SECTION_SYSTEM,
        "Agent environment variables",
        "Extra environment variables passed to the omp process, one KEY=VALUE per line. Applied to sessions started after saving.",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "system-app-update",
        SettingsTab.SYSTEM,
        SECTION_SYSTEM,
        "App update",
        "The connected server's version, the available release and the update command.",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "system-omp-update",
        SettingsTab.SYSTEM,
        SECTION_SYSTEM,
        "omp runtime update",
        "Check the installed omp version and copy its update command.",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "system-restart-sessions",
        SettingsTab.SYSTEM,
        SECTION_SYSTEM,
        "Restart active sessions",
        "Restart every live RPC session after an update so agents load fresh code.",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "system-mobile",
        SettingsTab.SYSTEM,
        SECTION_SYSTEM,
        "Mobile app",
        "The server's binding, reachable addresses, password state and setup commands.",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "windows-service-autostart",
        SettingsTab.SYSTEM,
        "Windows Background Service & System Tray",
        "Start with Windows",
        "Launch background service quietly in system tray when logging into Windows.",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "windows-service-shortcuts",
        SettingsTab.SYSTEM,
        "Windows Background Service & System Tray",
        "Install Service & Shortcuts",
        "Manage background service execution, system tray monitor, Windows logon autostart, and Desktop shortcuts.",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "about-app",
        SettingsTab.SYSTEM,
        "About",
        "App version and updates",
        "The installed Android app version, its update check against GitHub Releases, and the connected server's version and API.",
        SettingsScope.UI,
    ),
    // Notifications
    SettingsSearchEntry(
        "notifications-enable",
        SettingsTab.NOTIFICATIONS,
        SECTION_NOTIFICATIONS,
        "Enable notifications",
        "Asks the system for permission to show notifications.",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "notifications-completed",
        SettingsTab.NOTIFICATIONS,
        SECTION_NOTIFICATIONS,
        "Task finished",
        "A prompt and the background work it started are done. Subagents never notify.",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "notifications-input",
        SettingsTab.NOTIFICATIONS,
        SECTION_NOTIFICATIONS,
        "Waiting for input",
        "The agent asks a question or needs an approval.",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "notifications-error",
        SettingsTab.NOTIFICATIONS,
        SECTION_NOTIFICATIONS,
        "Run failed",
        "A run stops with an error after retries and fallbacks, or the omp process exits.",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "notifications-modelSwitch",
        SettingsTab.NOTIFICATIONS,
        SECTION_NOTIFICATIONS,
        "Model switched automatically",
        "omp switches models on its own: a fallback after a refusal, rate limit, or usage limit, or a prewalk / plan hand-off.",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "notifications-vibrate",
        SettingsTab.NOTIFICATIONS,
        SECTION_NOTIFICATIONS,
        "Vibrate",
        "One short pulse when a task finishes, a double pulse when an agent waits for input, one long pulse on errors. Never when you send.",
        SettingsScope.UI,
    ),
    SettingsSearchEntry(
        "notifications-when-active",
        SettingsTab.NOTIFICATIONS,
        SECTION_NOTIFICATIONS,
        "When I'm using omp-web in another tab",
        "Nothing is shown for the session you are viewing.",
        SettingsScope.UI,
    ),
)

/**
 * Merges the slices' row lists (order preserved) and drops duplicate ids so
 * two slices cannot make the same row appear twice. First occurrence wins.
 */
fun settingsSearchEntries(vararg slices: List<SettingsSearchEntry>): List<SettingsSearchEntry> {
    val seen = HashSet<String>()
    val merged = ArrayList<SettingsSearchEntry>()
    for (slice in slices) {
        for (entry in slice) {
            if (seen.add(entry.id)) merged.add(entry)
        }
    }
    return merged
}

/**
 * Case-insensitive substring search over label, description and section, the
 * same haystack the web searches (`SettingsConfig.tsx:1228`). A blank query
 * finds nothing; categories are matched separately by [searchSettingsCategories].
 */
fun searchSettings(query: String, entries: List<SettingsSearchEntry>): List<SettingsSearchEntry> {
    val needle = query.trim().lowercase()
    if (needle.isEmpty()) return emptyList()
    return entries.filter { entry ->
        "${entry.label} ${entry.description} ${entry.section}".lowercase().contains(needle)
    }
}

fun searchSettingsCategories(query: String, categories: List<SettingsCategory>): List<SettingsCategory> {
    val needle = query.trim().lowercase()
    if (needle.isEmpty()) return emptyList()
    return categories.filter { category ->
        "${category.label} ${category.description}".lowercase().contains(needle)
    }
}

/**
 * Phone layout: a selected tab or a non-blank query replaces the category
 * list. On a tablet both stay visible.
 */
fun settingsShowsDetail(wide: Boolean, selected: SettingsTab?, query: String): Boolean =
    wide || selected != null || query.isNotBlank()
