package io.github.kahme247.ompweb.domain

/**
 * The four local display preferences of Settings → Interface & Behavior
 * (`hooks/useFontSize.ts`, `hooks/useUiScale.ts`, `hooks/useTouchTargets.ts`).
 *
 * The web stores the wire values verbatim under `omp-font-size`,
 * `omp-ui-scale` and `omp-touch-targets`; an unknown or missing value falls
 * back to the documented default instead of throwing, so a hand-edited
 * DataStore cannot break the UI.
 */
enum class FontSizePreference(val wire: String, val fontScale: Float) {
    SM("sm", 0.875f),
    MD("md", 1f),
    LG("lg", 1.125f),
    XL("xl", 1.25f);

    companion object {
        val DEFAULT = MD

        fun fromWire(value: String?): FontSizePreference =
            entries.firstOrNull { it.wire == value } ?: DEFAULT
    }
}

enum class UiScalePreference(val wire: String, val densityScale: Float) {
    COMPACT("compact", 0.9f),
    STANDARD("standard", 1f),
    COMFORTABLE("comfortable", 1.1f),
    LARGE("large", 1.2f);

    companion object {
        val DEFAULT = STANDARD

        fun fromWire(value: String?): UiScalePreference =
            entries.firstOrNull { it.wire == value } ?: DEFAULT
    }
}

enum class TouchTargetsPreference(val wire: String, val minimumSizeDp: Float) {
    /** Material's own 48 dp minimum. */
    AUTO("auto", 48f),
    COMPACT("compact", 40f),
    ACCESSIBLE("accessible", 56f);

    companion object {
        val DEFAULT = AUTO

        fun fromWire(value: String?): TouchTargetsPreference =
            entries.firstOrNull { it.wire == value } ?: DEFAULT
    }
}

