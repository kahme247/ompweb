package io.github.kahme247.ompweb.domain

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The `todoPhases` omp publishes in `get_state` and the panel renders
 * (web `components/TodoList.tsx`). Wire shapes are parsed leniently: a
 * malformed task must not hide the rest of the plan.
 */
enum class TodoStatus(val wireName: String) {
    PENDING("pending"),
    IN_PROGRESS("in_progress"),
    COMPLETED("completed"),
    BLOCKED("blocked"),
    ABANDONED("abandoned"),

    /** A status from a newer omp; rendered like `pending`. */
    UNKNOWN("unknown"),
    ;

    companion object {
        fun fromWire(value: String?): TodoStatus =
            entries.firstOrNull { it.wireName == value && it != UNKNOWN } ?: UNKNOWN
    }
}

data class TodoItem(
    val id: String?,
    val content: String,
    val status: TodoStatus,
    val blocker: String?,
)

data class TodoPhase(
    val id: String?,
    val name: String,
    val tasks: List<TodoItem>,
)

/**
 * Parse omp's `todoPhases` array; empty when absent or the wrong shape.
 *
 * All-or-nothing like the web parser (`lib/session-reader.ts`
 * `parseTodoPhases`): one malformed phase or task rejects the snapshot instead
 * of rendering a partial plan. An unknown *status* string is the exception —
 * it renders as [TodoStatus.UNKNOWN] so a newer omp cannot hide the plan.
 */
fun parseTodoPhases(element: JsonElement?): List<TodoPhase> {
    val array = element as? JsonArray ?: return emptyList()
    val phases = ArrayList<TodoPhase>(array.size)
    for (raw in array) {
        val phase = raw as? JsonObject ?: return emptyList()
        val name = phase["name"].asStringOrNull() ?: return emptyList()
        val tasksRaw = phase["tasks"] as? JsonArray ?: return emptyList()
        val tasks = ArrayList<TodoItem>(tasksRaw.size)
        for (taskRaw in tasksRaw) {
            val task = taskRaw as? JsonObject ?: return emptyList()
            val content = task["content"].asStringOrNull() ?: return emptyList()
            val status = task["status"].asStringOrNull() ?: return emptyList()
            val blocker = task["blocker"]
            if (blocker != null && blocker.asStringOrNull() == null) return emptyList()
            tasks += TodoItem(
                id = task["id"].asStringOrNull(),
                content = content,
                status = TodoStatus.fromWire(status),
                blocker = blocker.asStringOrNull()?.takeIf { it.isNotBlank() },
            )
        }
        phases += TodoPhase(id = phase["id"].asStringOrNull(), name = name, tasks = tasks)
    }
    return phases
}

private fun JsonElement?.asStringOrNull(): String? =
    (this as? JsonPrimitive)?.takeIf { it.isString }?.content

/** `done/total` over every phase, as the panel header shows it. */
data class TodoProgress(val done: Int, val total: Int)

fun todoProgress(phases: List<TodoPhase>): TodoProgress {
    val tasks = phases.flatMap { it.tasks }
    return TodoProgress(done = tasks.count { it.status == TodoStatus.COMPLETED }, total = tasks.size)
}

/** The phases the collapsed panel previews and whether anything was cut. */
data class TodoPreview(val phases: List<TodoPhase>, val truncated: Boolean)

/** Collapsed preview window: 4 phases and 5 tasks in total (web `TodoList`). */
const val TODO_PREVIEW_PHASES = 4
const val TODO_PREVIEW_TASKS = 5

/**
 * Collapsed-preview order inside one phase: in-progress work first, then
 * completed, so a long first phase cannot hide the live work behind "Show all".
 */
fun todoPreviewTaskOrder(status: TodoStatus): Int = when (status) {
    TodoStatus.IN_PROGRESS -> 0
    TodoStatus.COMPLETED -> 1
    else -> 2
}

/**
 * The preview rows for [phases]: first four phases, at most five tasks across
 * them, per-phase ordered by [todoPreviewTaskOrder], empty phases dropped and
 * [TodoPreview.truncated] when the preview hides work.
 */
fun todoPreview(phases: List<TodoPhase>, expanded: Boolean): TodoPreview {
    val tasks = phases.flatMap { it.tasks }
    if (expanded) return TodoPreview(phases, truncated = false)
    var remaining = TODO_PREVIEW_TASKS
    val displayed = phases.take(TODO_PREVIEW_PHASES).mapNotNull { phase ->
        val ordered = phase.tasks.sortedBy { todoPreviewTaskOrder(it.status) }
        val shown = ordered.take(remaining.coerceAtLeast(0))
        remaining -= shown.size
        if (shown.isEmpty()) null else phase.copy(tasks = shown)
    }
    val displayedCount = displayed.sumOf { it.tasks.size }
    return TodoPreview(displayed, truncated = displayedCount < tasks.size)
}
