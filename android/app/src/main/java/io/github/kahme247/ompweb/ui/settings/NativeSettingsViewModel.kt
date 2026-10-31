package io.github.kahme247.ompweb.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.kahme247.ompweb.net.McpApi
import io.github.kahme247.ompweb.net.NativeSettingsApi
import io.github.kahme247.ompweb.net.PluginsApi
import io.github.kahme247.ompweb.net.SkillsApi
import io.github.kahme247.ompweb.ui.settings.native.McpController
import io.github.kahme247.ompweb.ui.settings.native.NativeSettingsController
import io.github.kahme247.ompweb.ui.settings.native.PluginsController
import io.github.kahme247.ompweb.ui.settings.native.SkillsController

/**
 * Holds the four Slice B controllers so the settings shell can hand them to
 * the native tab and the Extensions panels. Controllers are stateless between
 * loads apart from their `StateFlow`.
 *
 * The controllers run on [viewModelScope]: clearing the settings store (close,
 * sign-out, server switch) cancels their in-flight loads instead of leaving
 * them on the process scope.
 */
class NativeSettingsViewModel(
    settingsApi: NativeSettingsApi,
    mcpApi: McpApi,
    skillsApi: SkillsApi,
    pluginsApi: PluginsApi,
) : ViewModel() {
    val settings = NativeSettingsController(settingsApi, viewModelScope)
    val mcp = McpController(mcpApi, viewModelScope)
    val skills = SkillsController(skillsApi, viewModelScope)
    val plugins = PluginsController(pluginsApi, viewModelScope)
}
