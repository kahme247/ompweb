package io.github.kahme247.ompweb.ui.settings

import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.data.SettingsSnapshot
import io.github.kahme247.ompweb.data.SettingsStore
import io.github.kahme247.ompweb.domain.DictationEnginePreference
import io.github.kahme247.ompweb.domain.FontSizePreference
import io.github.kahme247.ompweb.domain.SubmitDuringRunBehavior
import io.github.kahme247.ompweb.domain.TouchTargetsPreference
import io.github.kahme247.ompweb.domain.UiScalePreference
import io.github.kahme247.ompweb.domain.dictationLanguageLabel
import io.github.kahme247.ompweb.domain.offeredDictationLanguages
import io.github.kahme247.ompweb.ui.chat.SpeechVoiceOption
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import kotlinx.coroutines.launch

/**
 * General tab: every local Interface & Behavior preference (Phase 6/7 keys
 * included) plus the native OMP rows of the same web section.
 */
@Composable
fun GeneralSettingsTab(
    settings: SettingsStore,
    snapshot: SettingsSnapshot,
    themeLabel: String,
    highlight: String?,
    voices: List<SpeechVoiceOption>,
    onRefreshVoices: () -> Unit,
    onPickTheme: () -> Unit,
    onVoiceSelected: (String?) -> Unit,
    modifier: Modifier = Modifier,
    nativeContent: @Composable (String?) -> Unit,
) {
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { onRefreshVoices() }

    SettingsPage(
        title = stringResource(R.string.settings_interface_title),
        modifier = modifier,
    ) {
        item(key = "general-appearance") {
            SettingsCard {
                SettingsRow(
                    title = stringResource(R.string.settings_theme),
                    description = stringResource(R.string.settings_theme_desc),
                    scope = io.github.kahme247.ompweb.domain.SettingsScope.UI,
                    onClick = onPickTheme,
                    trailing = {
                        Text(
                            text = themeLabel,
                            style = MaterialTheme.typography.bodyMedium,
                            color = LocalOmpColors.current.textMuted,
                        )
                    },
                )
                SettingsRow(
                    title = stringResource(R.string.settings_font_size),
                    description = stringResource(R.string.settings_font_size_desc),
                    scope = io.github.kahme247.ompweb.domain.SettingsScope.UI,
                    highlighted = highlight == "chat-font-size",
                    trailing = {
                        SettingsSelect(
                            options = listOf(
                                FontSizePreference.SM to stringResource(R.string.settings_font_sm),
                                FontSizePreference.MD to stringResource(R.string.settings_font_md),
                                FontSizePreference.LG to stringResource(R.string.settings_font_lg),
                                FontSizePreference.XL to stringResource(R.string.settings_font_xl),
                            ),
                            selected = FontSizePreference.fromWire(snapshot.fontSize),
                            onSelect = { scope.launch { settings.setFontSize(it) } },
                        )
                    },
                )
                SettingsRow(
                    title = stringResource(R.string.settings_ui_scale),
                    description = stringResource(R.string.settings_ui_scale_desc),
                    scope = io.github.kahme247.ompweb.domain.SettingsScope.UI,
                    highlighted = highlight == "ui-scale",
                    trailing = {
                        SettingsSelect(
                            options = listOf(
                                UiScalePreference.COMPACT to stringResource(R.string.settings_scale_compact),
                                UiScalePreference.STANDARD to stringResource(R.string.settings_scale_standard),
                                UiScalePreference.COMFORTABLE to stringResource(R.string.settings_scale_comfortable),
                                UiScalePreference.LARGE to stringResource(R.string.settings_scale_large),
                            ),
                            selected = UiScalePreference.fromWire(snapshot.uiScale),
                            onSelect = { scope.launch { settings.setUiScale(it) } },
                        )
                    },
                )
                SettingsRow(
                    title = stringResource(R.string.settings_touch_targets),
                    description = stringResource(R.string.settings_touch_targets_desc),
                    scope = io.github.kahme247.ompweb.domain.SettingsScope.UI,
                    highlighted = highlight == "touch-targets",
                    trailing = {
                        SettingsSelect(
                            options = listOf(
                                TouchTargetsPreference.AUTO to stringResource(R.string.settings_touch_auto),
                                TouchTargetsPreference.COMPACT to stringResource(R.string.settings_touch_compact),
                                TouchTargetsPreference.ACCESSIBLE to stringResource(R.string.settings_touch_accessible),
                            ),
                            selected = TouchTargetsPreference.fromWire(snapshot.touchTargets),
                            onSelect = { scope.launch { settings.setTouchTargets(it) } },
                        )
                    },
                )
            }
        }

        item(key = "general-behavior") {
            SettingsCard {
                SettingsRow(
                    title = stringResource(R.string.settings_completion_sound),
                    description = stringResource(R.string.settings_completion_sound_desc),
                    scope = io.github.kahme247.ompweb.domain.SettingsScope.UI,
                    highlighted = highlight == "completion-sound",
                    trailing = {
                        SettingsSwitch(snapshot.soundEnabled, { scope.launch { settings.setSoundEnabled(it) } })
                    },
                )
                SettingsRow(
                    title = stringResource(R.string.settings_keep_tool_calls),
                    description = stringResource(R.string.settings_keep_tool_calls_desc),
                    scope = io.github.kahme247.ompweb.domain.SettingsScope.UI,
                    highlighted = highlight == "keep-tool-calls-collapsed",
                    trailing = {
                        SettingsSwitch(snapshot.toolCallsCollapsed, { scope.launch { settings.setToolCallsCollapsed(it) } })
                    },
                )
                SettingsRow(
                    title = stringResource(R.string.settings_expand_thinking),
                    description = stringResource(R.string.settings_expand_thinking_desc),
                    scope = io.github.kahme247.ompweb.domain.SettingsScope.UI,
                    highlighted = highlight == "expand-thinking-by-default",
                    trailing = {
                        SettingsSwitch(snapshot.expandThinking, { scope.launch { settings.setExpandThinking(it) } })
                    },
                )
                SettingsRow(
                    title = stringResource(R.string.settings_hide_tool_activity),
                    description = stringResource(R.string.settings_hide_tool_activity_desc),
                    scope = io.github.kahme247.ompweb.domain.SettingsScope.UI,
                    highlighted = highlight == "hide-tool-activity",
                    trailing = {
                        SettingsSwitch(snapshot.hideToolActivity, { scope.launch { settings.setHideToolActivity(it) } })
                    },
                )
                SettingsRow(
                    title = stringResource(R.string.settings_open_links),
                    description = stringResource(R.string.settings_open_links_desc),
                    scope = io.github.kahme247.ompweb.domain.SettingsScope.UI,
                    highlighted = highlight == "open-url-automatically",
                    trailing = {
                        SettingsSwitch(snapshot.openUrlAutomatically, { scope.launch { settings.setOpenUrlAutomatically(it) } })
                    },
                )
            }
        }

        item(key = "general-speech") {
            SettingsCard {
                SettingsRow(
                    title = stringResource(R.string.settings_tts_autoplay),
                    description = stringResource(R.string.settings_tts_autoplay_desc),
                    scope = io.github.kahme247.ompweb.domain.SettingsScope.UI,
                    highlighted = highlight == "tts-autoplay",
                    trailing = {
                        SettingsSwitch(snapshot.ttsAutoplay, { scope.launch { settings.setTtsAutoplay(it) } })
                    },
                )
                SettingsRow(
                    title = stringResource(R.string.settings_tts_voice),
                    description = stringResource(R.string.settings_tts_voice_desc),
                    scope = io.github.kahme247.ompweb.domain.SettingsScope.UI,
                    highlighted = highlight == "tts-voice",
                    trailing = {
                        val defaultLabel = stringResource(R.string.settings_voice_default)
                        SettingsSelect(
                            options = listOf(null to defaultLabel) + voices.map {
                                it.name to "${it.name} (${it.locale})"
                            },
                            selected = snapshot.ttsVoice,
                            onSelect = onVoiceSelected,
                        )
                    },
                )
                if (voices.isEmpty()) {
                    Text(
                        text = stringResource(R.string.settings_voice_none),
                        style = MaterialTheme.typography.bodySmall,
                        color = LocalOmpColors.current.textDim,
                    )
                }
            }
        }

        item(key = "general-dictation") {
            SettingsCard {
                SettingsRow(
                    title = stringResource(R.string.settings_dictation_engine),
                    description = stringResource(R.string.settings_dictation_engine_desc),
                    scope = io.github.kahme247.ompweb.domain.SettingsScope.UI,
                    highlighted = highlight == "dictation-engine",
                    trailing = {
                        val selectedEngine = DictationEnginePreference.fromWire(snapshot.dictationEngine)
                        // "On this phone" needs the API-31 on-device recognizer;
                        // below it the choice would only ever fail. A stored
                        // choice made on a newer phone stays visible so the
                        // button never reads blank.
                        val showOnDevice = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ||
                            selectedEngine == DictationEnginePreference.ON_DEVICE
                        SettingsSelect(
                            options = buildList {
                                add(
                                    DictationEnginePreference.AUTO to
                                        stringResource(R.string.settings_dictation_engine_auto),
                                )
                                if (showOnDevice) {
                                    add(
                                        DictationEnginePreference.ON_DEVICE to
                                            stringResource(R.string.settings_dictation_engine_on_device),
                                    )
                                }
                                add(
                                    DictationEnginePreference.SERVER to
                                        stringResource(R.string.settings_dictation_engine_server),
                                )
                            },
                            selected = selectedEngine,
                            onSelect = { scope.launch { settings.setDictationEngine(it.wire) } },
                        )
                    },
                )
                SettingsRow(
                    title = stringResource(R.string.settings_dictation_language),
                    description = stringResource(R.string.settings_dictation_language_desc),
                    scope = io.github.kahme247.ompweb.domain.SettingsScope.UI,
                    highlighted = highlight == "dictation-language",
                    trailing = {
                        // Observable configuration read instead of Locale.getDefault():
                        // composing must re-run when the device language changes.
                        val deviceLocale = LocalConfiguration.current.locales[0]
                        val deviceLanguage = stringResource(R.string.settings_dictation_language_device)
                        SettingsSelect(
                            options = listOf<Pair<String?, String>>(null to deviceLanguage) +
                                offeredDictationLanguages(deviceLocale).map { tag ->
                                    tag to dictationLanguageLabel(tag, deviceLocale)
                                },
                            selected = snapshot.dictationLanguage,
                            onSelect = { scope.launch { settings.setDictationLanguage(it) } },
                        )
                    },
                )
            }
        }

        item(key = "general-composer") {
            SettingsCard {
                SettingsRow(
                    title = stringResource(R.string.settings_word_completion),
                    description = stringResource(R.string.settings_word_completion_desc),
                    scope = io.github.kahme247.ompweb.domain.SettingsScope.UI,
                    highlighted = highlight == "word-completion",
                    trailing = {
                        SettingsSelect(
                            options = listOf(
                                "auto" to stringResource(R.string.settings_word_auto),
                                "on" to stringResource(R.string.settings_word_on),
                                "off" to stringResource(R.string.settings_word_off),
                            ),
                            selected = snapshot.wordCompletion,
                            onSelect = { scope.launch { settings.setWordCompletion(it) } },
                        )
                    },
                )
                SettingsRow(
                    title = stringResource(R.string.settings_submit_mode),
                    description = stringResource(R.string.settings_submit_mode_desc),
                    scope = io.github.kahme247.ompweb.domain.SettingsScope.UI,
                    highlighted = highlight == "message-during-active-run",
                    trailing = {
                        SettingsSelect(
                            options = listOf(
                                SubmitDuringRunBehavior.STEER to stringResource(R.string.settings_submit_steer),
                                SubmitDuringRunBehavior.QUEUE to stringResource(R.string.settings_submit_queue),
                            ),
                            selected = snapshot.submitDuringRun,
                            onSelect = { scope.launch { settings.setSubmitDuringRun(it) } },
                        )
                    },
                )
            }
        }

        item(key = "general-native") {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    text = stringResource(R.string.settings_native_section),
                    style = MaterialTheme.typography.titleSmall,
                    color = LocalOmpColors.current.textMuted,
                    modifier = Modifier.padding(start = 4.dp),
                )
                nativeContent(highlight)
            }
        }
    }
}
