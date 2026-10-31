package io.github.kahme247.ompweb.chat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BranchTreeTest {

    private fun node(
        id: String,
        role: String? = "user",
        text: String = id,
        children: String = "[]",
        compressed: List<String> = emptyList(),
        previewRole: String? = null,
        previewText: String? = null,
    ): JsonObject {
        val compressedJson = compressed.joinToString(",") { "\"$it\"" }
        return Json.parseToJsonElement(
            """
            {
              "entry": {"id": "$id", "type": "message", "message": {"role": ${role?.let { "\"$it\"" } ?: "null"}, "content": "$text"}},
              "children": $children,
              "compressedEntryIds": [$compressedJson],
              "branchPreview": ${if (previewText != null) """{"role": "${previewRole ?: "user"}", "text": "$previewText"}""" else "null"}
            }
            """.trimIndent(),
        ).jsonObject
    }

    private fun parse(vararg roots: JsonObject): List<BranchNode> = BranchTree.parse(roots.toList())

    @Test
    fun `parses nested tree and previews`() {
        val leaf = node("b2", role = "assistant", text = "answer")
        val child = node("b1", children = "[$leaf]")
        val root = node("root", text = "hello", children = "[$child]")
        val parsed = parse(root)
        assertEquals(1, parsed.size)
        assertEquals("root", parsed[0].id)
        assertEquals("hello", parsed[0].text)
        assertEquals(1, parsed[0].children.size)
        assertEquals("b2", parsed[0].children[0].children[0].id)
    }

    @Test
    fun `detects a branch anywhere in the tree`() {
        val singlePath = node("a", children = "[${node("b")}]")
        assertFalse(BranchTree.hasBranch(parse(singlePath)))
        val fork = node("a", children = "[${node("b")}, ${node("c")}]")
        assertTrue(BranchTree.hasBranch(parse(fork)))
    }

    @Test
    fun `active path includes compressed ids and their ancestors`() {
        val target = node("leaf", compressed = listOf("chain-1", "chain-2"))
        val middle = node("middle", children = "[$target]")
        val root = node("root", children = "[$middle]")
        val tree = parse(root)
        assertEquals(setOf("root", "middle", "leaf"), BranchTree.activePathIds(tree, "chain-2"))
        assertEquals(setOf("root", "middle"), BranchTree.activePathIds(tree, "middle"))
        assertTrue(BranchTree.activePathIds(tree, "missing").isEmpty())
        assertTrue(BranchTree.activePathIds(tree, null).isEmpty())
    }

    @Test
    fun `rows mark the active branch and keep siblings`() {
        val branchA = node("a1", text = "first")
        val branchB = node("b1", text = "second")
        val root = node("root", children = "[$branchA, $branchB]")
        val rows = BranchTree.rows(parse(root), "b1")
        assertEquals(1, rows.size)
        assertEquals("root", rows[0].label)
        assertTrue(rows[0].active)
        assertEquals(2, rows[0].children.size)
        assertEquals("first", rows[0].children[0].label)
        assertFalse(rows[0].children[0].active)
        assertTrue(rows[0].children[1].active)
        assertFalse(rows[0].children[0].isLast)
        assertTrue(rows[0].children[1].isLast)
    }
}
