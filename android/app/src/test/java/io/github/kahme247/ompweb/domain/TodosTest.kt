package io.github.kahme247.ompweb.domain

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Mirrors `components/TodoList.test.mjs`: the collapsed preview window, the
 * ordering rule and the progress count the panel header shows.
 */
class TodosTest {

    private fun json(text: String): kotlinx.serialization.json.JsonElement = Json.parseToJsonElement(text)

    private fun phases(phases: String): List<TodoPhase> = parseTodoPhases(json(phases))

    @Test
    fun `parses phases, task states and blockers`() {
        val parsed = phases(
            """
            [{"id":"phase-1","name":"Implementation","tasks":[
              {"id":"task-1","content":"Trace todo state","status":"completed"},
              {"id":"task-2","content":"Render task list","status":"in_progress"},
              {"id":"task-3","content":"Verify in browser","status":"blocked","blocker":"Server unavailable"}
            ]}]
            """,
        )
        assertEquals(1, parsed.size)
        assertEquals("Implementation", parsed[0].name)
        assertEquals(listOf(TodoStatus.COMPLETED, TodoStatus.IN_PROGRESS, TodoStatus.BLOCKED), parsed[0].tasks.map { it.status })
        assertEquals("Server unavailable", parsed[0].tasks[2].blocker)
        assertEquals(TodoProgress(done = 1, total = 3), todoProgress(parsed))
    }

    @Test
    fun `missing or malformed phases render nothing`() {
        assertEquals(emptyList<TodoPhase>(), parseTodoPhases(null))
        assertEquals(emptyList<TodoPhase>(), parseTodoPhases(json("[]")))
        assertEquals(emptyList<TodoPhase>(), parseTodoPhases(json("\"nope\"")))
        assertEquals(emptyList<TodoPhase>(), parseTodoPhases(json("[{\"tasks\":[]}]")))
        assertEquals(emptyList<TodoPhase>(), parseTodoPhases(json("[{\"name\":\"x\",\"tasks\":[{\"status\":\"pending\"}]}]")))
    }

    @Test
    fun `counts only completed tasks and collapses long plans`() {
        val parsed = phases(
            """
            [{"name":"Tasks","tasks":[
              {"content":"One","status":"completed"},
              {"content":"Two","status":"abandoned"},
              {"content":"Three","status":"pending"},
              {"content":"Four","status":"pending"},
              {"content":"Five","status":"pending"},
              {"content":"Six","status":"pending"}
            ]}]
            """,
        )
        assertEquals(TodoProgress(done = 1, total = 6), todoProgress(parsed))
        val preview = todoPreview(parsed, expanded = false)
        assertTrue(preview.truncated)
        assertEquals(5, preview.phases.single().tasks.size)
        assertFalse(preview.phases.single().tasks.any { it.content == "Six" })
        // Expanded shows every row and is never truncated.
        val expanded = todoPreview(parsed, expanded = true)
        assertFalse(expanded.truncated)
        assertEquals(6, expanded.phases.single().tasks.size)
    }

    @Test
    fun `the preview surfaces in-progress work before completed and pending rows`() {
        val parsed = phases(
            """
            [{"name":"Tasks","tasks":[
              {"content":"Pending one","status":"pending"},
              {"content":"Done","status":"completed"},
              {"content":"Live","status":"in_progress"},
              {"content":"Pending two","status":"pending"},
              {"content":"Pending three","status":"pending"},
              {"content":"Pending four","status":"pending"}
            ]}]
            """,
        )
        assertEquals(listOf("Live", "Done", "Pending one", "Pending two", "Pending three"), todoPreview(parsed, false).phases.single().tasks.map { it.content })
    }

    @Test
    fun `the preview takes four phases and five tasks and drops empty phases`() {
        val parsed = phases(
            """
            [
              {"name":"A","tasks":[{"content":"a1","status":"pending"},{"content":"a2","status":"pending"}]},
              {"name":"B","tasks":[{"content":"b1","status":"pending"},{"content":"b2","status":"pending"}]},
              {"name":"C","tasks":[{"content":"c1","status":"pending"},{"content":"c2","status":"pending"}]},
              {"name":"D","tasks":[]},
              {"name":"E","tasks":[{"content":"e1","status":"pending"}]}
            ]
            """,
        )
        val preview = todoPreview(parsed, expanded = false)
        assertEquals(listOf("A", "B", "C"), preview.phases.map { it.name })
        assertEquals(5, preview.phases.sumOf { it.tasks.size })
        assertTrue(preview.truncated)
        // A plan that fits the window hides nothing.
        val small = phases("""[{"name":"A","tasks":[{"content":"a1","status":"pending"}]}]""")
        assertFalse(todoPreview(small, expanded = false).truncated)
    }

    @Test
    fun `unknown statuses count as other and keep their text`() {
        val parsed = phases("""[{"name":"A","tasks":[{"content":"future","status":"blocked_by_user"}]}]""")
        assertEquals(TodoStatus.UNKNOWN, parsed.single().tasks.single().status)
        assertEquals(2, todoPreviewTaskOrder(TodoStatus.UNKNOWN))
        assertEquals(1, todoPreview(parsed, expanded = false).phases.single().tasks.size)
    }

    @Test
    fun `blank blocker is not a blocker`() {
        val parsed = phases("""[{"name":"A","tasks":[{"content":"x","status":"blocked","blocker":"   "}]}]""")
        assertNull(parsed.single().tasks.single().blocker)
    }
}
