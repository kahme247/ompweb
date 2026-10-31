package io.github.kahme247.ompweb.ui.chat

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/**
 * The Material `terminal` glyph for the system-prompt action (web `AppShell`
 * uses lucide's `Terminal`). `material-icons-core` ships no terminal icon and
 * `material-icons-extended` would add several megabytes for a single glyph.
 */
internal val SystemPromptIcon: ImageVector by lazy {
    ImageVector.Builder(
        name = "SystemPrompt",
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        path(fill = SolidColor(Color.Black)) {
            moveTo(20f, 4f)
            horizontalLineTo(4f)
            curveTo(2.89f, 4f, 2f, 4.9f, 2f, 6f)
            verticalLineToRelative(12f)
            curveTo(2f, 19.1f, 2.89f, 20f, 4f, 20f)
            horizontalLineToRelative(16f)
            curveTo(21.1f, 20f, 22f, 19.1f, 22f, 18f)
            verticalLineTo(6f)
            curveTo(22f, 4.9f, 21.1f, 4f, 20f, 4f)
            close()
            moveTo(20f, 18f)
            horizontalLineTo(4f)
            verticalLineTo(8f)
            horizontalLineToRelative(16f)
            verticalLineTo(18f)
            close()
            moveTo(18f, 17f)
            horizontalLineToRelative(-6f)
            verticalLineToRelative(-2f)
            horizontalLineToRelative(6f)
            verticalLineTo(17f)
            close()
            moveTo(7.5f, 17f)
            lineTo(6.09f, 15.59f)
            lineTo(8.67f, 13f)
            lineTo(6.09f, 10.41f)
            lineTo(7.5f, 9f)
            lineTo(11.5f, 13f)
            lineTo(7.5f, 17f)
            close()
        }
    }.build()
}
