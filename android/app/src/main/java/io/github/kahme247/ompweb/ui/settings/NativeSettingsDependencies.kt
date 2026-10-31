package io.github.kahme247.ompweb.ui.settings

import androidx.compose.runtime.staticCompositionLocalOf

/**
 * What the native settings tab needs from the shell. [sessionId] is the
 * currently open chat session (if any): MCP live status and the plugins
 * "reload session" action are only available with one. The MCP/Skills/
 * Plugins clients live on [viewModel]'s controllers, so the shell does not
 * create a second set of API instances.
 */
data class NativeSettingsDependencies(
    val viewModel: NativeSettingsViewModel,
    val sessionId: String? = null,
)

val LocalNativeSettingsDependencies = staticCompositionLocalOf<NativeSettingsDependencies?> { null }
