package io.github.kahme247.ompweb.ui.settings

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.VerticalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import io.github.kahme247.ompweb.AppContainer
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.LOCAL_SETTINGS_SEARCH_ENTRIES
import io.github.kahme247.ompweb.domain.NativeCategory
import io.github.kahme247.ompweb.domain.SETTINGS_CATEGORIES
import io.github.kahme247.ompweb.domain.SettingsCategory
import io.github.kahme247.ompweb.domain.SettingsScope
import io.github.kahme247.ompweb.domain.SettingsSearchEntry
import io.github.kahme247.ompweb.domain.SettingsTab
import io.github.kahme247.ompweb.domain.searchSettings
import io.github.kahme247.ompweb.domain.searchSettingsCategories
import io.github.kahme247.ompweb.domain.settingsSearchEntries
import io.github.kahme247.ompweb.domain.settingsShowsDetail
import io.github.kahme247.ompweb.ui.theme.OmpTheme
import io.github.kahme247.ompweb.ui.theme.SYSTEM_THEME_ID
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import kotlinx.coroutines.launch

/**
 * The full Settings surface: adaptive navigation (list → detail on phones,
 * rail + content from 840 dp), cross-tab search with jump + highlight, and
 * all ten web tabs in the web's order.
 *
 * Native (Slice B) and providers/agents (Slice C) content is injected as
 * composables by the host; the shell only owns navigation, local preferences,
 * Usage, Notifications and System.
 */
@Composable
fun SettingsScreen(
    container: AppContainer,
    cwd: String?,
    viewModelStoreOwner: ViewModelStoreOwner,
    onClose: () -> Unit,
    onSignOut: () -> Unit,
    onChangeServer: () -> Unit,
    onThemeSelected: (String) -> Unit,
    searchEntries: List<SettingsSearchEntry> = settingsSearchEntries(LOCAL_SETTINGS_SEARCH_ENTRIES),
    nativeContent: @Composable (NativeCategory, String?, String?) -> Unit = { _, _, _ -> },
    providersContent: @Composable (String?) -> Unit = {},
    agentsContent: @Composable (String?, String?) -> Unit = { _, _ -> },
) {
    val snapshot by container.settings.snapshot.collectAsStateWithLifecycle()
    val voices by container.speech.voices.collectAsStateWithLifecycle()
    val viewModel: SettingsViewModel = viewModel(
        viewModelStoreOwner = viewModelStoreOwner,
        factory = container.settingsViewModelFactory,
    )
    val scope = rememberCoroutineScope()

    // Tab, highlight and search live in the composition, saved across rotation
    // and process death (the settings surface is reopened by the shell's own
    // `rememberSaveable` flag). Re-applying the display density recomposes the
    // dialog without recreating this composition, so the tab also survives a
    // font-size change.
    var selectedWire by rememberSaveable { mutableStateOf<String?>(null) }
    var highlightId by rememberSaveable { mutableStateOf<String?>(null) }
    var searchQuery by rememberSaveable { mutableStateOf("") }
    val highlight = highlightId
    val query = searchQuery
    var themePickerOpen by rememberSaveable { mutableStateOf(false) }

    val selected = selectedWire?.let(SettingsTab::fromWire)
    val themeLabel = if (snapshot.themeId == SYSTEM_THEME_ID) {
        stringResource(R.string.settings_theme_system)
    } else {
        OmpTheme.fromId(snapshot.themeId)?.displayName ?: stringResource(R.string.settings_theme_system)
    }

    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val wide = maxWidth >= 840.dp
        // On a phone the category list is one screen and the tab/query another;
        // with a blank query and no tab the list must stay visible (that is the
        // only place the search field lives).
        val showingDetail = settingsShowsDetail(wide, selected, query)

        BackHandler {
            if (query.isNotBlank()) {
                searchQuery = ""
            } else if (!wide && selected != null) {
                selectedWire = null
                highlightId = null
            } else {
                onClose()
            }
        }

        Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Column(modifier = Modifier.fillMaxSize().safeDrawingPadding()) {
                SettingsTopBar(
                    title = if (!wide && selected != null && query.isBlank()) {
                        tabLabel(selected)
                    } else {
                        stringResource(R.string.settings_title)
                    },
                    onBack = if (!wide && (selected != null || query.isNotBlank())) {
                        {
                            if (query.isNotBlank()) {
                                searchQuery = ""
                            } else {
                                selectedWire = null
                                highlightId = null
                            }
                        }
                    } else {
                        null
                    },
                    // The search field lives in the category list; from an open
                    // tab this returns there so search stays one tap away.
                    onSearch = if (!wide && selected != null && query.isBlank()) {
                        {
                            selectedWire = null
                            highlightId = null
                        }
                    } else {
                        null
                    },
                    onClose = onClose,
                )
                HorizontalDivider(color = LocalOmpColors.current.border)
                Row(modifier = Modifier.fillMaxSize()) {
                    if (wide || !showingDetail) {
                        SettingsNavigation(
                            modifier = if (wide) Modifier.width(340.dp).fillMaxHeight() else Modifier.fillMaxSize(),
                            selected = selected,
                            cwd = cwd,
                            query = query,
                            onQueryChange = { searchQuery = it },
                            onSelect = { tab ->
                                selectedWire = tab.wire
                                highlightId = null
                                searchQuery = ""
                            },
                            usageBar = {
                                ProviderUsageBar(viewModel = viewModel)
                            },
                        )
                    }
                    if (wide) {
                        VerticalDivider(
                            modifier = Modifier.fillMaxHeight(),
                            color = LocalOmpColors.current.border,
                        )
                    }
                    if (showingDetail) {
                        Box(modifier = Modifier.weight(1f).fillMaxHeight()) {
                            val activeTab = selected ?: SettingsTab.GENERAL
                            if (query.isNotBlank()) {
                                Column(modifier = Modifier.fillMaxSize()) {
                                    if (!wide) {
                                        SettingsSearchField(
                                            query = query,
                                            onQueryChange = { searchQuery = it },
                                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                                            autoFocus = true,
                                        )
                                    }
                                    Box(modifier = Modifier.weight(1f)) {
                                        SearchResults(
                                            query = query,
                                            entries = searchEntries,
                                            onSelectSetting = { entry ->
                                                selectedWire = entry.tab.wire
                                                highlightId = entry.id
                                                searchQuery = ""
                                            },
                                            onSelectCategory = { tab ->
                                                selectedWire = tab.wire
                                                highlightId = null
                                                searchQuery = ""
                                            },
                                        )
                                    }
                                }
                            } else {
                                SettingsTabContent(
                                    tab = activeTab,
                                    cwd = cwd,
                                    highlight = highlight,
                                    container = container,
                                    viewModel = viewModel,
                                    snapshot = snapshot,
                                    themeLabel = themeLabel,
                                    voices = voices,
                                    onRefreshVoices = { container.speech.refreshVoices() },
                                    onPickTheme = { themePickerOpen = true },
                                    onVoiceSelected = { name ->
                                        scope.launch { container.settings.setTtsVoice(name) }
                                        container.speech.setVoice(name)
                                    },
                                    onSignOut = {
                                        onClose()
                                        onSignOut()
                                    },
                                    onChangeServer = {
                                        onClose()
                                        onChangeServer()
                                    },
                                    nativeContent = nativeContent,
                                    providersContent = providersContent,
                                    agentsContent = agentsContent,
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    if (themePickerOpen) {
        ThemePickerDialog(
            selectedThemeId = snapshot.themeId,
            onSelect = { themeId ->
                themePickerOpen = false
                onThemeSelected(themeId)
            },
            onDismiss = { themePickerOpen = false },
        )
    }
}

@Composable
private fun SettingsTopBar(
    title: String,
    onBack: (() -> Unit)?,
    onSearch: (() -> Unit)?,
    onClose: () -> Unit,
) {
    val colors = LocalOmpColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.background)
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) {
            IconButton(onClick = onBack) {
                Icon(
                    Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = stringResource(R.string.nav_back),
                    tint = colors.text,
                )
            }
        }
        Text(
            text = title,
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.SemiBold,
            color = colors.text,
            modifier = Modifier.weight(1f).padding(start = if (onBack == null) 12.dp else 0.dp),
        )
        if (onSearch != null) {
            IconButton(onClick = onSearch) {
                Icon(
                    Icons.Filled.Search,
                    contentDescription = stringResource(R.string.settings_search_hint),
                    tint = colors.text,
                )
            }
        }
        IconButton(onClick = onClose) {
            Icon(
                Icons.Filled.Close,
                contentDescription = stringResource(R.string.settings_close),
                tint = colors.textMuted,
            )
        }
    }
}

@Composable
private fun SettingsSearchField(
    query: String,
    onQueryChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    autoFocus: Boolean = false,
) {
    val focusRequester = remember { FocusRequester() }
    LaunchedEffect(autoFocus) {
        if (autoFocus) focusRequester.requestFocus()
    }
    OutlinedTextField(
        value = query,
        onValueChange = onQueryChange,
        modifier = modifier
            .fillMaxWidth()
            .focusRequester(focusRequester),
        placeholder = { Text(stringResource(R.string.settings_search_hint)) },
        singleLine = true,
    )
}

@Composable
internal fun SettingsNavigation(
    modifier: Modifier,
    selected: SettingsTab?,
    cwd: String?,
    query: String,
    onQueryChange: (String) -> Unit,
    onSelect: (SettingsTab) -> Unit,
    /** Provider usage strip, pinned at the bottom (web `SettingsNavigation`). */
    usageBar: @Composable () -> Unit = {},
) {
    val colors = LocalOmpColors.current
    // One requester per row so a key handler can move the actual focus, not
    // just the selection (web: onSelect + targetBtn.focus()).
    val focusRequesters = remember { SETTINGS_CATEGORIES.map { FocusRequester() } }
    val enabledTabs = remember(cwd) { enabledSettingsTabs(cwd) }

    fun handleKey(tab: SettingsTab, event: KeyEvent): Boolean {
        if (event.type != KeyEventType.KeyDown) return false
        val action = settingsNavKeyFor(event.key) ?: return false
        val current = enabledTabs.indexOf(tab)
        if (current < 0) return false
        val targetIndex = settingsNavTarget(current, action, enabledTabs.size) ?: return false
        val target = enabledTabs[targetIndex]
        onSelect(target)
        if (action != SettingsNavKey.ACTIVATE) {
            focusRequesters[SETTINGS_CATEGORIES.indexOf(target)].requestFocus()
        }
        return true
    }

    Column(
        modifier = modifier.background(colors.panel).padding(horizontal = 12.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        SettingsSearchField(query = query, onQueryChange = onQueryChange)
        Column(
            modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            for ((index, tab) in SETTINGS_CATEGORIES.withIndex()) {
                val enabled = !tab.needsWorkspace || cwd != null
                val active = tab == selected
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .focusRequester(focusRequesters[index])
                        .onPreviewKeyEvent { event -> handleKey(tab, event) }
                        .clip(RoundedCornerShape(10.dp))
                        .background(if (active) colors.selected else colors.panel)
                        .clickable(enabled = enabled) { onSelect(tab) }
                        .padding(horizontal = 12.dp, vertical = 9.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Text(
                        text = tabLabel(tab),
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                        color = when {
                            !enabled -> colors.textDim
                            active -> colors.accent
                            else -> colors.text
                        },
                    )
                    Text(
                        text = tabDescription(tab),
                        style = MaterialTheme.typography.bodySmall,
                        color = if (enabled) colors.textMuted else colors.textDim,
                    )
                }
            }
            if (cwd == null) {
                Text(
                    text = stringResource(R.string.settings_workspace_hint),
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textDim,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                )
            }
        }
        usageBar()
    }
}

@Composable
private fun SettingsTabContent(
    tab: SettingsTab,
    cwd: String?,
    highlight: String?,
    container: AppContainer,
    viewModel: SettingsViewModel,
    snapshot: io.github.kahme247.ompweb.data.SettingsSnapshot,
    themeLabel: String,
    voices: List<io.github.kahme247.ompweb.ui.chat.SpeechVoiceOption>,
    onRefreshVoices: () -> Unit,
    onPickTheme: () -> Unit,
    onVoiceSelected: (String?) -> Unit,
    onSignOut: () -> Unit,
    onChangeServer: () -> Unit,
    nativeContent: @Composable (NativeCategory, String?, String?) -> Unit,
    providersContent: @Composable (String?) -> Unit,
    agentsContent: @Composable (String?, String?) -> Unit,
) {
    when (tab) {
        SettingsTab.GENERAL -> GeneralSettingsTab(
            settings = container.settings,
            snapshot = snapshot,
            themeLabel = themeLabel,
            highlight = highlight,
            voices = voices,
            onRefreshVoices = onRefreshVoices,
            onPickTheme = onPickTheme,
            onVoiceSelected = onVoiceSelected,
            nativeContent = { nativeContent(NativeCategory.GENERAL, cwd, it) },
        )
        SettingsTab.SAFETY -> SettingsTabScroll {
            nativeContent(NativeCategory.SAFETY, cwd, highlight)
        }
        SettingsTab.MODELS -> SettingsTabScroll {
            nativeContent(NativeCategory.MODELS, cwd, highlight)
        }
        SettingsTab.PROVIDERS -> providersContent(highlight)
        SettingsTab.USAGE -> UsageSettingsTab(viewModel, highlight = highlight)
        SettingsTab.INTELLIGENCE -> SettingsTabScroll {
            nativeContent(NativeCategory.INTELLIGENCE, cwd, highlight)
        }
        SettingsTab.AGENTS -> if (cwd == null) {
            WorkspaceRequired()
        } else {
            agentsContent(cwd, highlight)
        }
        SettingsTab.MCP -> SettingsTabScroll {
            nativeContent(NativeCategory.EXTENSIONS, cwd, highlight)
        }
        SettingsTab.NOTIFICATIONS -> NotificationSettingsTab(container, highlight = highlight)
        SettingsTab.SYSTEM -> SystemSettingsTab(
            viewModel = viewModel,
            onSignOut = onSignOut,
            onChangeServer = onChangeServer,
            highlight = highlight,
            androidUpdates = container.androidUpdates,
            appVersion = container.appVersion,
        )
    }
}

/**
 * Scroll host for the tabs whose content is a plain column (the native rows of
 * a category, `NativeSettingsTab`). The detail area is height-bounded, and
 * Compose measures each column child against the height that is left: a tab
 * that does not scroll therefore shrinks its trailing children instead of
 * moving them out of the way. A tall editor collapsed the button row below it
 * to zero height, so editor and buttons shared one band and nothing scrolled.
 * Tabs that bring their own scroll container (agents, providers, the pages
 * built on `SettingsPage`) are not wrapped.
 */
@Composable
private fun SettingsTabScroll(content: @Composable () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 20.dp),
    ) {
        content()
    }
}

@Composable
private fun WorkspaceRequired() {
    Box(modifier = Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Text(
            text = stringResource(R.string.settings_workspace_required),
            style = MaterialTheme.typography.bodyMedium,
            color = LocalOmpColors.current.textMuted,
        )
    }
}

private data class SearchHit(
    val tab: SettingsTab,
    val label: String,
    val description: String,
    val section: String,
    val scope: SettingsScope?,
    val entry: SettingsSearchEntry?,
)

@Composable
private fun SearchResults(
    query: String,
    entries: List<SettingsSearchEntry>,
    onSelectSetting: (SettingsSearchEntry) -> Unit,
    onSelectCategory: (SettingsTab) -> Unit,
) {
    val colors = LocalOmpColors.current
    val categories = searchSettingsCategories(
        query,
        SETTINGS_CATEGORIES.map { tab -> SettingsCategory(tab, tabLabel(tab), tabDescription(tab)) },
    )
    val matches = searchSettings(query, entries)
    val hits = categories.map { category ->
        SearchHit(
            tab = category.tab,
            label = category.label,
            description = category.description,
            section = stringResource(R.string.settings_search_section),
            scope = null,
            entry = null,
        )
    } + matches.map { entry ->
        SearchHit(
            tab = entry.tab,
            label = entry.label,
            description = entry.description,
            section = entry.section,
            scope = entry.scope,
            entry = entry,
        )
    }

    androidx.compose.foundation.lazy.LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item(key = "search-count") {
            Text(
                text = if (hits.isEmpty()) {
                    stringResource(R.string.settings_search_no_results, query)
                } else {
                    stringResource(R.string.settings_search_results, hits.size, query)
                },
                style = MaterialTheme.typography.bodyMedium,
                color = colors.textMuted,
            )
        }
        for (hit in hits) {
            item(key = "${hit.tab.wire}-${hit.label}-${hit.entry?.id ?: "section"}") {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(12.dp))
                        .background(colors.panel)
                        .clickable {
                            val entry = hit.entry
                            if (entry != null) {
                                onSelectSetting(entry)
                            } else {
                                onSelectCategory(hit.tab)
                            }
                        }
                        .padding(horizontal = 14.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            text = hit.label,
                            style = MaterialTheme.typography.bodyLarge,
                            fontWeight = FontWeight.Medium,
                            color = colors.text,
                        )
                        if (hit.scope != null) SettingsScopeChip(hit.scope)
                    }
                    Text(
                        text = "${hit.section} · ${hit.description}",
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.textMuted,
                    )
                }
            }
        }
    }
}

@Composable
private fun tabLabel(tab: SettingsTab): String = stringResource(
    when (tab) {
        SettingsTab.GENERAL -> R.string.settings_tab_general
        SettingsTab.SAFETY -> R.string.settings_tab_safety
        SettingsTab.MODELS -> R.string.settings_tab_models
        SettingsTab.PROVIDERS -> R.string.settings_tab_providers
        SettingsTab.USAGE -> R.string.settings_tab_usage
        SettingsTab.INTELLIGENCE -> R.string.settings_tab_intelligence
        SettingsTab.AGENTS -> R.string.settings_tab_agents
        SettingsTab.MCP -> R.string.settings_tab_mcp
        SettingsTab.NOTIFICATIONS -> R.string.settings_tab_notifications
        SettingsTab.SYSTEM -> R.string.settings_tab_system
    },
)

@Composable
private fun tabDescription(tab: SettingsTab): String = stringResource(
    when (tab) {
        SettingsTab.GENERAL -> R.string.settings_tab_general_desc
        SettingsTab.SAFETY -> R.string.settings_tab_safety_desc
        SettingsTab.MODELS -> R.string.settings_tab_models_desc
        SettingsTab.PROVIDERS -> R.string.settings_tab_providers_desc
        SettingsTab.USAGE -> R.string.settings_tab_usage_desc
        SettingsTab.INTELLIGENCE -> R.string.settings_tab_intelligence_desc
        SettingsTab.AGENTS -> R.string.settings_tab_agents_desc
        SettingsTab.MCP -> R.string.settings_tab_mcp_desc
        SettingsTab.NOTIFICATIONS -> R.string.settings_tab_notifications_desc
        SettingsTab.SYSTEM -> R.string.settings_tab_system_desc
    },
)
