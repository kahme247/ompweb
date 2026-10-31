package io.github.kahme247.ompweb.ui.theme

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.LocalMinimumInteractiveComponentSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import io.github.kahme247.ompweb.domain.FontSizePreference
import io.github.kahme247.ompweb.domain.TouchTargetsPreference
import io.github.kahme247.ompweb.domain.UiScalePreference

/**
 * Every color token of one ompweb web theme (`app/globals.css`), with the
 * exact hex values the stylesheet resolves for that theme: a token a theme
 * block does not override keeps the `:root` value, as in the CSS cascade.
 *
 * The full token set is kept even where no current screen reads a token yet;
 * it mirrors the web palette one-to-one for the later chat and notification
 * phases instead of growing field by field.
 */
@Immutable
data class OmpColors(
    val background: Color,
    val panel: Color,
    val hover: Color,
    val selected: Color,
    val border: Color,
    val text: Color,
    val textMuted: Color,
    val textDim: Color,
    val accent: Color,
    val accentStrong: Color,
    val accentHover: Color,
    /** `--accent-2`; only the OMP Midnight theme defines a second accent. */
    val secondaryAccent: Color?,
    val userBackground: Color,
    val toolBackground: Color,
    val backgroundSubtle: Color,
    val statusError: Color,
    val statusSuccess: Color,
    val statusWarning: Color,
    val statusModified: Color,
    val statusRenamed: Color,
    val onAccent: Color,
    val overlayBackdrop: Color,
)

/** The 14 ompweb themes, with ids identical to the web's `omp-theme` values. */
enum class OmpTheme(
    val id: String,
    val displayName: String,
    val isDark: Boolean,
    val colors: OmpColors,
) {
    light(
        id = "light",
        displayName = "Light (default)",
        isDark = false,
        colors = OmpColors(
            background = Color(0xFFFAF9F6),
            panel = Color(0xFFF2F0EA),
            hover = Color(0xFFEAE7DF),
            selected = Color(0xFFE5E0D4),
            border = Color(0xFFE2DDD2),
            text = Color(0xFF2B2823),
            textMuted = Color(0xFF69635A),
            textDim = Color(0xFF6A6458),
            accent = Color(0xFFB03E22),
            accentStrong = Color(0xFFB03E22),
            accentHover = Color(0xFF96331B),
            secondaryAccent = null,
            userBackground = Color(0xFFF5EDE1),
            toolBackground = Color(0xFFF6F3ED),
            backgroundSubtle = Color(0x0A3C3223),
            statusError = Color(0xFFB42318),
            statusSuccess = Color(0xFF18794E),
            statusWarning = Color(0xFF8A5A00),
            statusModified = Color(0xFFA87B1F),
            statusRenamed = Color(0xFF2563EB),
            onAccent = Color(0xFFFFFFFF),
            overlayBackdrop = Color(0x3D2B2823),
        ),
    ),
    one_light(
        id = "one-light",
        displayName = "One Light",
        isDark = false,
        colors = OmpColors(
            background = Color(0xFFFAFAFA),
            panel = Color(0xFFF0F0F0),
            hover = Color(0xFFE5E5E6),
            selected = Color(0xFFDBDBDC),
            border = Color(0xFFDCDCDC),
            text = Color(0xFF383A42),
            textMuted = Color(0xFF696C77),
            textDim = Color(0xFF63666F),
            accent = Color(0xFF2F65D9),
            accentStrong = Color(0xFF2F65D9),
            accentHover = Color(0xFF1E4FB8),
            secondaryAccent = null,
            userBackground = Color(0xFFEEF3FE),
            toolBackground = Color(0xFFF2F4F8),
            backgroundSubtle = Color(0x0A383A42),
            statusError = Color(0xFFE45649),
            statusSuccess = Color(0xFF50A14F),
            statusWarning = Color(0xFFC18401),
            statusModified = Color(0xFF986801),
            statusRenamed = Color(0xFF4078F2),
            onAccent = Color(0xFFFFFFFF),
            overlayBackdrop = Color(0x3D383A42),
        ),
    ),
    catppuccin_latte(
        id = "catppuccin-latte",
        displayName = "Catppuccin Latte",
        isDark = false,
        colors = OmpColors(
            background = Color(0xFFEFF1F5),
            panel = Color(0xFFE6E9EF),
            hover = Color(0xFFDCE0E8),
            selected = Color(0xFFCCD0DA),
            border = Color(0xFFBCC0CC),
            text = Color(0xFF4C4F69),
            textMuted = Color(0xFF65687E),
            textDim = Color(0xFF5B5F72),
            accent = Color(0xFF1E66F5),
            accentStrong = Color(0xFFB03E22),
            accentHover = Color(0xFF04A5E5),
            secondaryAccent = null,
            userBackground = Color(0xFFE4E8F8),
            toolBackground = Color(0xFFE6E9EF),
            backgroundSubtle = Color(0x0D4C4F69),
            statusError = Color(0xFFD20F39),
            statusSuccess = Color(0xFF40A02B),
            statusWarning = Color(0xFFDF8E1D),
            statusModified = Color(0xFFFE640B),
            statusRenamed = Color(0xFF1E66F5),
            onAccent = Color(0xFFFFFFFF),
            overlayBackdrop = Color(0x3D4C4F69),
        ),
    ),
    rose_pine_dawn(
        id = "rose-pine-dawn",
        displayName = "Rosé Pine Dawn",
        isDark = false,
        colors = OmpColors(
            background = Color(0xFFFAF4ED),
            panel = Color(0xFFFFFAF3),
            hover = Color(0xFFF2E9E1),
            selected = Color(0xFFDFDAD9),
            border = Color(0xFFCECACD),
            text = Color(0xFF575279),
            textMuted = Color(0xFF6E6A86),
            textDim = Color(0xFF645F78),
            accent = Color(0xFF286983),
            accentStrong = Color(0xFF286983),
            accentHover = Color(0xFF1F5469),
            secondaryAccent = null,
            userBackground = Color(0xFFF5EDE8),
            toolBackground = Color(0xFFFFFBF5),
            backgroundSubtle = Color(0x0D575279),
            statusError = Color(0xFFB4637A),
            statusSuccess = Color(0xFF286983),
            statusWarning = Color(0xFFEA9D34),
            statusModified = Color(0xFFD7827E),
            statusRenamed = Color(0xFF907AA9),
            onAccent = Color(0xFFFFFFFF),
            overlayBackdrop = Color(0x3D575279),
        ),
    ),
    omp(
        id = "omp",
        displayName = "OMP Midnight",
        isDark = true,
        colors = OmpColors(
            background = Color(0xFF000000),
            panel = Color(0xFF0A0A0C),
            hover = Color(0xFF141417),
            selected = Color(0xFF1C1C21),
            border = Color(0xFF232329),
            text = Color(0xFFF5F5F5),
            textMuted = Color(0xFFC9C9D1),
            textDim = Color(0xFF8E8E96),
            accent = Color(0xFFEC5BAB),
            accentStrong = Color(0xFFAD2674),
            accentHover = Color(0xFFF483BB),
            secondaryAccent = Color(0xFF7DD7E8),
            userBackground = Color(0xFF171217),
            toolBackground = Color(0xFF101014),
            backgroundSubtle = Color(0x0AFFFFFF),
            statusError = Color(0xFFFF9B92),
            statusSuccess = Color(0xFF7DD8A8),
            statusWarning = Color(0xFFF0C36A),
            statusModified = Color(0xFFE0B24D),
            statusRenamed = Color(0xFF7CA8FF),
            onAccent = Color(0xFFFFFFFF),
            overlayBackdrop = Color(0x3DF5F5F5),
        ),
    ),
    dark(
        id = "dark",
        displayName = "Dark",
        isDark = true,
        colors = OmpColors(
            background = Color(0xFF1B1916),
            panel = Color(0xFF231F1B),
            hover = Color(0xFF2B2721),
            selected = Color(0xFF332E26),
            border = Color(0xFF38322B),
            text = Color(0xFFEBE6DC),
            textMuted = Color(0xFFA39B8E),
            textDim = Color(0xFF938C81),
            accent = Color(0xFFE07B54),
            accentStrong = Color(0xFFC2542E),
            accentHover = Color(0xFFE89371),
            secondaryAccent = null,
            userBackground = Color(0xFF2C2721),
            toolBackground = Color(0xFF26221D),
            backgroundSubtle = Color(0x0DEBE1D2),
            statusError = Color(0xFFFF8A80),
            statusSuccess = Color(0xFF69D5A5),
            statusWarning = Color(0xFFF0C36A),
            statusModified = Color(0xFFE0B24D),
            statusRenamed = Color(0xFF7CA8FF),
            onAccent = Color(0xFFFFFFFF),
            overlayBackdrop = Color(0x3DEBE6DC),
        ),
    ),
    dracula(
        id = "dracula",
        displayName = "Dracula",
        isDark = true,
        colors = OmpColors(
            background = Color(0xFF282A36),
            panel = Color(0xFF21222C),
            hover = Color(0xFF343746),
            selected = Color(0xFF44475A),
            border = Color(0xFF44475A),
            text = Color(0xFFF8F8F2),
            textMuted = Color(0xFFB4B8D0),
            textDim = Color(0xFFAEB5D0),
            accent = Color(0xFFFF79C6),
            accentStrong = Color(0xFFBD93F9),
            accentHover = Color(0xFFFFA2D8),
            secondaryAccent = null,
            userBackground = Color(0xFF2E303E),
            toolBackground = Color(0xFF21222C),
            backgroundSubtle = Color(0x0DF8F8F2),
            statusError = Color(0xFFFF5555),
            statusSuccess = Color(0xFF50FA7B),
            statusWarning = Color(0xFFFFB86C),
            statusModified = Color(0xFFF1FA8C),
            statusRenamed = Color(0xFF8BE9FD),
            onAccent = Color(0xFF282A36),
            overlayBackdrop = Color(0x3DF8F8F2),
        ),
    ),
    harbor(
        id = "harbor",
        displayName = "Harbor",
        isDark = true,
        colors = OmpColors(
            background = Color(0xFF1B1B1B),
            panel = Color(0xFF242424),
            hover = Color(0xFF2E2E2E),
            selected = Color(0xFF383838),
            border = Color(0xFF3D3D3D),
            text = Color(0xFFEFEBDC),
            textMuted = Color(0xFFC0B8A0),
            textDim = Color(0xFF817F68),
            accent = Color(0xFFE75A50),
            accentStrong = Color(0xFFD2483E),
            accentHover = Color(0xFFF0736A),
            secondaryAccent = null,
            userBackground = Color(0xFF262120),
            toolBackground = Color(0xFF202020),
            backgroundSubtle = Color(0x0DEFEBDC),
            statusError = Color(0xFFF44336),
            statusSuccess = Color(0xFF77838A),
            statusWarning = Color(0xFFE1CE98),
            statusModified = Color(0xFFDC8164),
            statusRenamed = Color(0xFFE58980),
            onAccent = Color(0xFFFFFFFF),
            overlayBackdrop = Color(0x3DEFEBDC),
        ),
    ),
    one_dark_pro(
        id = "one-dark-pro",
        displayName = "One Dark Pro",
        isDark = true,
        colors = OmpColors(
            background = Color(0xFF282C34),
            panel = Color(0xFF21252B),
            hover = Color(0xFF2C313C),
            selected = Color(0xFF3E4451),
            border = Color(0xFF3A3F4B),
            text = Color(0xFFABB2BF),
            textMuted = Color(0xFF8B94A5),
            textDim = Color(0xFFAAB2C0),
            accent = Color(0xFF61AFEF),
            accentStrong = Color(0xFF4D8CD6),
            accentHover = Color(0xFF7EC7FF),
            secondaryAccent = null,
            userBackground = Color(0xFF232731),
            toolBackground = Color(0xFF1E2227),
            backgroundSubtle = Color(0x0DABB2BF),
            statusError = Color(0xFFE06C75),
            statusSuccess = Color(0xFF98C379),
            statusWarning = Color(0xFFE5C07B),
            statusModified = Color(0xFFD19A66),
            statusRenamed = Color(0xFF61AFEF),
            onAccent = Color(0xFFFFFFFF),
            overlayBackdrop = Color(0x3DABB2BF),
        ),
    ),
    rose_pine(
        id = "rose-pine",
        displayName = "Rosé Pine",
        isDark = true,
        colors = OmpColors(
            background = Color(0xFF191724),
            panel = Color(0xFF1F1D2E),
            hover = Color(0xFF26233A),
            selected = Color(0xFF403D52),
            border = Color(0xFF393552),
            text = Color(0xFFE0DEF4),
            textMuted = Color(0xFF908CAA),
            textDim = Color(0xFF6E6A86),
            accent = Color(0xFFEBBCBA),
            accentStrong = Color(0xFFC4A7E7),
            accentHover = Color(0xFFF2CECC),
            secondaryAccent = null,
            userBackground = Color(0xFF232033),
            toolBackground = Color(0xFF1D1A2B),
            backgroundSubtle = Color(0x0DE0DEF4),
            statusError = Color(0xFFEB6F92),
            statusSuccess = Color(0xFF9CCFD8),
            statusWarning = Color(0xFFF6C177),
            statusModified = Color(0xFFEBBCBA),
            statusRenamed = Color(0xFFC4A7E7),
            onAccent = Color(0xFF191724),
            overlayBackdrop = Color(0x3DE0DEF4),
        ),
    ),
    catppuccin_mocha(
        id = "catppuccin-mocha",
        displayName = "Catppuccin Mocha",
        isDark = true,
        colors = OmpColors(
            background = Color(0xFF1E1E2E),
            panel = Color(0xFF181825),
            hover = Color(0xFF262638),
            selected = Color(0xFF313244),
            border = Color(0xFF45475A),
            text = Color(0xFFCDD6F4),
            textMuted = Color(0xFFA6ADC8),
            textDim = Color(0xFFAAB2D0),
            accent = Color(0xFFCBA6F7),
            accentStrong = Color(0xFFB4BEFE),
            accentHover = Color(0xFFD8BCF9),
            secondaryAccent = null,
            userBackground = Color(0xFF252438),
            toolBackground = Color(0xFF181825),
            backgroundSubtle = Color(0x0DCDD6F4),
            statusError = Color(0xFFF38BA8),
            statusSuccess = Color(0xFFA6E3A1),
            statusWarning = Color(0xFFF9E2AF),
            statusModified = Color(0xFFFAB387),
            statusRenamed = Color(0xFF89B4FA),
            onAccent = Color(0xFF11111B),
            overlayBackdrop = Color(0x3DCDD6F4),
        ),
    ),
    gruvbox_dark(
        id = "gruvbox-dark",
        displayName = "Gruvbox Dark",
        isDark = true,
        colors = OmpColors(
            background = Color(0xFF282828),
            panel = Color(0xFF1D2021),
            hover = Color(0xFF32302F),
            selected = Color(0xFF3C3836),
            border = Color(0xFF504945),
            text = Color(0xFFEBDBB2),
            textMuted = Color(0xFFBDAE93),
            textDim = Color(0xFF928374),
            accent = Color(0xFFFE8019),
            accentStrong = Color(0xFFD65D0E),
            accentHover = Color(0xFFFF9C42),
            secondaryAccent = null,
            userBackground = Color(0xFF322D29),
            toolBackground = Color(0xFF202020),
            backgroundSubtle = Color(0x0DEBDBB2),
            statusError = Color(0xFFFB4934),
            statusSuccess = Color(0xFFB8BB26),
            statusWarning = Color(0xFFFABD2F),
            statusModified = Color(0xFFD3869B),
            statusRenamed = Color(0xFF83A598),
            onAccent = Color(0xFFFFFFFF),
            overlayBackdrop = Color(0x3DEBDBB2),
        ),
    ),
    nord(
        id = "nord",
        displayName = "Nord",
        isDark = true,
        colors = OmpColors(
            background = Color(0xFF2E3440),
            panel = Color(0xFF272C36),
            hover = Color(0xFF3B4252),
            selected = Color(0xFF434C5E),
            border = Color(0xFF4C566A),
            text = Color(0xFFECEFF4),
            textMuted = Color(0xFFD8DEE9),
            textDim = Color(0xFF8892B0),
            accent = Color(0xFF88C0D0),
            accentStrong = Color(0xFF5E81AC),
            accentHover = Color(0xFF9BD6E6),
            secondaryAccent = null,
            userBackground = Color(0xFF343B4A),
            toolBackground = Color(0xFF262B35),
            backgroundSubtle = Color(0x0DECEFF4),
            statusError = Color(0xFFBF616A),
            statusSuccess = Color(0xFFA3BE8C),
            statusWarning = Color(0xFFEBCB8B),
            statusModified = Color(0xFFD08770),
            statusRenamed = Color(0xFF81A1C1),
            onAccent = Color(0xFF2E3440),
            overlayBackdrop = Color(0x3DECEFF4),
        ),
    ),
    tokyo_night(
        id = "tokyo-night",
        displayName = "Tokyo Night",
        isDark = true,
        colors = OmpColors(
            background = Color(0xFF1A1B26),
            panel = Color(0xFF16161E),
            hover = Color(0xFF24283B),
            selected = Color(0xFF283457),
            border = Color(0xFF2F354D),
            text = Color(0xFFC0CAF5),
            textMuted = Color(0xFF9AA5CE),
            textDim = Color(0xFFAAB6E6),
            accent = Color(0xFF7AA2F7),
            accentStrong = Color(0xFF567ECC),
            accentHover = Color(0xFF8DB4FF),
            secondaryAccent = null,
            userBackground = Color(0xFF222538),
            toolBackground = Color(0xFF161620),
            backgroundSubtle = Color(0x0DC0CAF5),
            statusError = Color(0xFFF7768E),
            statusSuccess = Color(0xFF9ECE6A),
            statusWarning = Color(0xFFE0AF68),
            statusModified = Color(0xFFFF9E64),
            statusRenamed = Color(0xFF7DCFFF),
            onAccent = Color(0xFFFFFFFF),
            overlayBackdrop = Color(0x3DC0CAF5),
        ),
    );
    companion object {
        private val byId: Map<String, OmpTheme> = entries.associateBy { it.id }

        /** [id] as stored by the web app, or `null` for "system" / unknown ids. */
        fun fromId(id: String?): OmpTheme? = id?.let(byId::get)
    }
}

/** Stored preference that follows the device's light/dark setting. */
const val SYSTEM_THEME_ID = "system"

/** Fallback of `hooks/useTheme.ts`: nothing stored means OMP Midnight. */
const val DEFAULT_THEME_ID = "omp"

/**
 * The repo ships no JetBrains Mono under `app/fonts/` (only Noto Serif SC and
 * a Nerd-Font subset), so the app uses the platform's monospace family.
 */
val OmpMonoFontFamily: FontFamily = FontFamily.Monospace

/** Web `--radius-card`: the one radius cards, bubbles and panels share. */
val OmpCardRadius = 12.dp

val LocalOmpColors = staticCompositionLocalOf { OmpTheme.omp.colors }

/**
 * The display preferences [OmpWebTheme] applied, so a dialog window can apply
 * the same ones: a dialog composes in its own window and does not see the
 * [OmpDisplayScaling] provider around the rest of the app.
 */
@Immutable
data class OmpDisplayPreferences(
    val themeId: String = DEFAULT_THEME_ID,
    val fontSize: FontSizePreference = FontSizePreference.DEFAULT,
    val uiScale: UiScalePreference = UiScalePreference.DEFAULT,
    val touchTargets: TouchTargetsPreference = TouchTargetsPreference.DEFAULT,
)

val LocalOmpDisplayPreferences = staticCompositionLocalOf { OmpDisplayPreferences() }

/** Resolves a stored theme id the way `resolveTheme` does in the web app. */
@Composable
fun resolveOmpTheme(themeId: String): OmpTheme {
    if (themeId == SYSTEM_THEME_ID) {
        return if (isSystemInDarkTheme()) OmpTheme.dark else OmpTheme.light
    }
    return OmpTheme.fromId(themeId) ?: OmpTheme.omp
}

@Composable
fun OmpWebTheme(
    themeId: String = DEFAULT_THEME_ID,
    fontSize: FontSizePreference = FontSizePreference.DEFAULT,
    uiScale: UiScalePreference = UiScalePreference.DEFAULT,
    touchTargets: TouchTargetsPreference = TouchTargetsPreference.DEFAULT,
    content: @Composable () -> Unit,
) {
    val theme = resolveOmpTheme(themeId)
    val displayPreferences = remember(themeId, fontSize, uiScale, touchTargets) {
        OmpDisplayPreferences(themeId, fontSize, uiScale, touchTargets)
    }
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = view.context.findActivity()?.window ?: return@SideEffect
            val controller = WindowCompat.getInsetsController(window, view)
            controller.isAppearanceLightStatusBars = !theme.isDark
            controller.isAppearanceLightNavigationBars = !theme.isDark
        }
    }
    CompositionLocalProvider(LocalOmpDisplayPreferences provides displayPreferences) {
        OmpDisplayScaling(fontSize = fontSize, uiScale = uiScale, touchTargets = touchTargets) {
            CompositionLocalProvider(LocalOmpColors provides theme.colors) {
                MaterialTheme(colorScheme = theme.colors.toColorScheme(theme.isDark), content = content)
            }
        }
    }
}

/**
 * The three display preferences map onto Compose's own scaling primitives:
 * UI scale multiplies the density (every dp grows/shrinks, like the web's
 * `zoom`), font size multiplies the font scale (sp-only), and touch targets
 * set Material's minimum interactive size.
 *
 * This provider wraps the app's own composition. It does not reach a dialog
 * or bottom sheet, which composes in its own window with the window's base
 * density: dialogs that show app content use `OmpDialog`, `OmpAlertDialog` or
 * `OmpDialogContent` (see `OmpDialogScaling.kt`), which re-apply
 * [LocalOmpDisplayPreferences] inside the dialog window.
 */
@Composable
fun OmpDisplayScaling(
    fontSize: FontSizePreference,
    uiScale: UiScalePreference,
    touchTargets: TouchTargetsPreference,
    content: @Composable () -> Unit,
) {
    val base = LocalDensity.current
    val density = remember(base.density, base.fontScale, uiScale, fontSize) {
        Density(
            density = base.density * uiScale.densityScale,
            fontScale = base.fontScale * fontSize.fontScale,
        )
    }
    val minimumTarget = touchTargets.minimumSizeDp.dp
    CompositionLocalProvider(
        LocalDensity provides density,
        LocalMinimumInteractiveComponentSize provides minimumTarget,
        content = content,
    )
}

private fun Context.findActivity(): Activity? {
    var context: Context? = this
    while (context is ContextWrapper) {
        if (context is Activity) return context
        context = context.baseContext
    }
    return null
}

/**
 * Maps an ompweb palette onto Material 3. The palette stays authoritative:
 * every surface and text slot comes from the same token the web uses, so the
 * app cannot drift into a second color language.
 */
internal fun OmpColors.toColorScheme(dark: Boolean): ColorScheme {
    val base = if (dark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = accent,
        onPrimary = onAccent,
        primaryContainer = userBackground,
        onPrimaryContainer = text,
        inversePrimary = accentHover,
        secondary = textMuted,
        onSecondary = background,
        secondaryContainer = hover,
        onSecondaryContainer = text,
        tertiary = statusWarning,
        onTertiary = background,
        tertiaryContainer = hover,
        onTertiaryContainer = text,
        background = background,
        onBackground = text,
        surface = background,
        onSurface = text,
        surfaceVariant = panel,
        onSurfaceVariant = textMuted,
        surfaceTint = accent,
        surfaceContainerLowest = background,
        surfaceContainerLow = panel,
        surfaceContainer = panel,
        surfaceContainerHigh = hover,
        surfaceContainerHighest = selected,
        outline = textDim,
        outlineVariant = border,
        error = statusError,
        onError = onAccent,
        errorContainer = hover,
        onErrorContainer = text,
        inverseSurface = text,
        inverseOnSurface = background,
    )
}
