package io.github.kahme247.ompweb.ui.sessions

/** Visible bounds of one draggable list row, in viewport coordinates. */
internal data class DragItemBounds(
    val key: String,
    val offset: Int,
    val size: Int,
)

/**
 * Key of the row under [pointerY], or null when the pointer is inside the
 * viewport but in the gap above/below every row.
 *
 * The old code targeted the row containing the dragged header's *centre*,
 * which never matched a tall expanded block after the pointer left the
 * header — the drop silently went to the neighbouring project.
 */
internal fun dropTargetKey(items: List<DragItemBounds>, pointerY: Float): String? =
    items.firstOrNull { pointerY >= it.offset && pointerY < it.offset + it.size }?.key

/**
 * Project a drop at [dropIndex] moves [draggedPath] to, or null when nothing
 * should move.
 *
 * [dropIndex] is always an index into the rendered project list: the pinned
 * shortcut above it is its own list item and never shifts these indices. A
 * gesture that ends where it started therefore resolves to the dragged row
 * itself and must not reorder anything (long-press without dragging).
 */
internal fun dropTargetPath(
    projectPaths: List<String>,
    dropIndex: Int,
    draggedPath: String,
): String? = projectPaths.getOrNull(dropIndex)?.takeIf { it != draggedPath }
