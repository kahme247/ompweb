package io.github.kahme247.ompweb.ui.files

/**
 * The viewer mode a file tab opens in (web `DisplayMode` in
 * `components/FileViewer.tsx`). Git changes open a file in [Diff]; an
 * explorer row or a markdown link opens it in the default mode its type
 * allows.
 *
 * The enum lives in `ui.files` because the git pane's `onOpenFile` callback
 * hands it to this package; the pure availability rules are
 * `domain.fileViewerModes`.
 */
enum class FileOpenMode { Source, Preview, Diff }
