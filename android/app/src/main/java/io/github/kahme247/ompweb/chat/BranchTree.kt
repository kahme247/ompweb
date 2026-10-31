package io.github.kahme247.ompweb.chat

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull

/** One projected branch node of `GET /api/sessions/{id}` (`tree`). */
data class BranchNode(
    val id: String,
    val type: String,
    val role: String?,
    val text: String?,
    val children: List<BranchNode>,
    val compressedEntryIds: List<String>,
    val previewRole: String?,
    val previewText: String?,
)

/** One rendered row of the branch navigator (single-child chains compressed). */
data class BranchRow(
    val selectId: String,
    val label: String,
    val role: String?,
    val depth: Int,
    val isLast: Boolean,
    val parentLines: List<Boolean>,
    val skipped: Int,
    val active: Boolean,
    val onPath: Boolean,
    val children: List<BranchRow>,
)

/**
 * Server-side branch tree parsing and compression (web:
 * `components/BranchNavigator.tsx`). omp accepts a leaf entry id; the
 * navigator therefore selects the deepest node of a compressed chain.
 */
object BranchTree {

    fun parse(nodes: List<JsonObject>): List<BranchNode> = nodes.mapNotNull(::parseNode)

    private fun parseNode(node: JsonObject): BranchNode? {
        val entry = node.obj("entry") ?: return null
        val id = entry.string("id") ?: return null
        val type = entry.string("type") ?: ""
        val message = entry.obj("message")
        val preview = node.obj("branchPreview")
        return BranchNode(
            id = id,
            type = type,
            role = message?.string("role"),
            text = message?.let { contentText(it["content"]) },
            children = (node.array("children") ?: JsonArray(emptyList())).mapNotNull { parseNode(it as? JsonObject ?: return@mapNotNull null) },
            compressedEntryIds = (node.array("compressedEntryIds") ?: JsonArray(emptyList()))
                .mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull },
            previewRole = preview?.string("role"),
            previewText = preview?.string("text"),
        )
    }

    fun hasBranch(nodes: List<BranchNode>): Boolean {
        if (nodes.size > 1) return true
        for (node in nodes) {
            if (node.children.size > 1) return true
            if (hasBranch(node.children)) return true
        }
        return false
    }

    fun activePathIds(nodes: List<BranchNode>, targetId: String?): Set<String> {
        if (targetId == null) return emptySet()
        fun search(current: List<BranchNode>, path: List<String>): List<String>? {
            for (node in current) {
                val next = path + node.id
                if (node.id == targetId || targetId in node.compressedEntryIds) return next
                search(node.children, next)?.let { return it }
            }
            return null
        }
        return search(nodes, emptyList())?.toSet() ?: emptySet()
    }

    fun rows(tree: List<BranchNode>, activeLeafId: String?): List<BranchRow> {
        val active = activePathIds(tree, activeLeafId)
        fun build(nodes: List<BranchNode>, depth: Int, parentLines: List<Boolean>): List<BranchRow> {
            return nodes.flatMapIndexed { index, node ->
                val last = index == nodes.lastIndex
                val compressed = compress(node)
                val row = BranchRow(
                    selectId = compressed.representative.id,
                    label = compressed.label,
                    role = compressed.role,
                    depth = depth,
                    isLast = last,
                    parentLines = parentLines,
                    skipped = compressed.skipped,
                    active = compressed.representative.id in active,
                    onPath = node.id in active || compressed.representative.id in active,
                    children = build(compressed.representative.children, depth + 1, parentLines + (!last)),
                )
                listOf(row)
            }
        }
        return build(tree, 0, emptyList())
    }

    private data class Compressed(
        val representative: BranchNode,
        val skipped: Int,
        val label: String,
        val role: String?,
    )

    private fun compress(node: BranchNode): Compressed {
        var current = node
        var previewText = current.previewText
        var previewRole = current.previewRole
        var labelNode = current
        if (current.type == "message") {
            previewText = previewText ?: messagePreview(current)
            labelNode = current
        }
        var skipped = current.compressedEntryIds.size
        while (current.children.size == 1) {
            current = current.children[0]
            if (previewText == null) previewText = current.previewText ?: messagePreview(current)
            if (labelNode.type != "message" && current.type == "message") labelNode = current
            skipped += 1 + current.compressedEntryIds.size
        }
        val label = previewText ?: messagePreview(labelNode) ?: labelNode.type
        val role = previewRole ?: labelNode.role
        return Compressed(current, skipped, label, role)
    }

    private fun messagePreview(node: BranchNode): String? {
        if (node.type != "message") return null
        val text = node.text?.replace(WHITESPACE, " ")?.trim().orEmpty()
        if (text.isEmpty()) return if (node.role == "assistant") "assistant" else "message"
        return if (text.length > 40) text.take(40) + "…" else text
    }

    private val WHITESPACE = Regex("\\s+")
}
