package io.github.kahme247.ompweb.domain

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeSettingsTest {

    private fun objectOf(vararg pairs: Pair<String, kotlinx.serialization.json.JsonElement>): JsonObject =
        JsonObject(pairs.toMap())

    @Test
    fun `display defaults match the web settings panel`() {
        val document = NativeSettingsDocument()
        assertEquals("high", document.thinkingLevel())
        assertEquals("classifier", document.autoThinkingSource())
        assertEquals("medium", document.textVerbosity())
        assertEquals("default", document.personality())
        assertFalse(document.hideThinkingBlock())
        assertFalse(document.externalThinking())
        assertEquals("yolo", document.approvalMode())
        assertEquals("prompt", document.bashApproval())
        assertEquals("prompt", document.extensionApproval())
        assertTrue(document.showStartupDiagnostics())
        assertTrue(document.compactionEnabled())
        assertTrue(document.compactionAutoContinue())
        assertTrue(document.compactionMidTurn())
        assertEquals(DEFAULT_COMPACTION_METHOD_ORDER, document.compactionMethodOrder())
        assertEquals("mnemopi", document.memoryBackend())
        assertTrue(document.autolearnEnabled())
        assertEquals("per-project", document.memoryScope())
        assertTrue(document.autoRecall())
        assertTrue(document.autoRetain())
        assertTrue(document.retryEnabled())
        assertEquals(2, document.maxRetries())
        assertFalse(document.modelFallback())
        assertTrue(document.mcpProjectConfig())
        assertTrue(document.mcpRenderMarkdown())
        assertFalse(document.mcpNotifications())
        assertTrue(validateNativeSettings(document).isEmpty())
    }

    @Test
    fun `nested setters create and remove sections`() {
        val document = NativeSettingsDocument()
            .withSectionString("tools", "approvalMode", "always-ask")
            .withNestedSectionString("tools", "approval", "bash", "deny")
            .withSectionBool("mcp", "notifications", true)
        assertEquals("always-ask", document.sectionString("tools", "approvalMode"))
        assertEquals("deny", document.bashApproval())
        assertTrue(document.mcpNotifications())

        val removed = document
            .withNestedSectionString("tools", "approval", "bash", null)
        assertEquals("prompt", removed.bashApproval())
        assertEquals("always-ask", removed.sectionString("tools", "approvalMode"))

        val empty = document.withSectionString("tools", "approvalMode", null)
            .withNestedSectionString("tools", "approval", "bash", null)
        assertNull(empty.root["tools"])
    }

    @Test
    fun `unknown keys survive every edit`() {
        val root = buildJsonObject {
            put("defaultThinkingLevel", "low")
            put("customUserKey", "keep me")
            put("retry", buildJsonObject { put("enabled", true); put("customRetry", 7) })
        }
        val document = NativeSettingsDocument(root)
            .withString("defaultThinkingLevel", "max")
            .withSectionInt("retry", "maxRetries", 4)
        assertEquals("keep me", document.string("customUserKey"))
        assertEquals(7, document.sectionInt("retry", "customRetry"))
        assertEquals("max", document.thinkingLevel())
        assertEquals(4, document.maxRetries())
    }

    @Test
    fun `serialization round-trips including unknown keys`() {
        val document = NativeSettingsDocument(
            buildJsonObject {
                put("textVerbosity", "high")
                put("somethingNew", buildJsonObject { put("nested", true) })
                put("compaction", buildJsonObject { put("methodOrder", kotlinx.serialization.json.JsonArray(listOf())) })
            },
        )
        val encoded = document.root.toString()
        val decoded = NativeSettingsDocument(Json.parseToJsonElement(encoded).jsonObject)
        assertEquals(document, decoded)
        assertEquals("high", decoded.textVerbosity())
        assertEquals(emptyList<String>(), decoded.compactionMethodOrder())
    }

    @Test
    fun `compaction method order keeps only known methods once`() {
        val document = NativeSettingsDocument(
            objectOf(
                "compaction" to buildJsonObject {
                    put(
                        "methodOrder",
                        kotlinx.serialization.json.JsonArray(
                            listOf("soft", "bogus", "remote", "soft").map { kotlinx.serialization.json.JsonPrimitive(it) },
                        ),
                    )
                },
            ),
        )
        assertEquals(listOf("soft", "remote"), document.compactionMethodOrder())
    }

    @Test
    fun `compaction editor toggles and moves checked methods`() {
        val initial = listOf("remote", "soft")
        assertEquals(listOf("remote", "soft", "handoff"), toggleCompactionMethod(initial, "handoff", true))
        assertEquals(listOf("remote"), toggleCompactionMethod(initial, "soft", false))
        assertEquals(listOf("soft", "remote"), moveCompactionMethod(initial, "remote", 1))
        assertEquals(initial, moveCompactionMethod(initial, "remote", -1))
        assertEquals(initial, moveCompactionMethod(initial, "handoff", 1))

        val rows = compactionMethodRows(listOf("soft"))
        assertEquals("soft", rows.first().first)
        assertEquals(0, rows.first().second)
        assertEquals(listOf("remote", "snapcompact", "handoff", "shake"), rows.drop(1).map { it.first })
        assertTrue(rows.drop(1).all { it.second == -1 })
    }

    @Test
    fun `validation mirrors the server rules`() {
        fun issues(root: JsonObject) = validateNativeSettings(NativeSettingsDocument(root))

        assertTrue(issues(buildJsonObject { put("defaultThinkingLevel", "turbo") }).isNotEmpty())
        assertTrue(issues(buildJsonObject { put("textVerbosity", "loud") }).isNotEmpty())
        assertTrue(issues(buildJsonObject { put("personality", "sassy") }).isNotEmpty())
        assertTrue(issues(buildJsonObject { put("hideThinkingBlock", "yes") }).isNotEmpty())
        assertTrue(issues(buildJsonObject { put("skills", buildJsonObject { put("unknown", true) }) }).isNotEmpty())
        assertTrue(issues(buildJsonObject { put("tools", buildJsonObject { put("approvalMode", "maybe") }) }).isNotEmpty())
        assertTrue(
            issues(buildJsonObject { put("tools", buildJsonObject { put("approval", "yolo") }) }).isNotEmpty(),
        )
        assertTrue(
            issues(buildJsonObject { put("retry", buildJsonObject { put("maxRetries", 21) }) }).isNotEmpty(),
        )
        assertTrue(
            issues(buildJsonObject { put("retry", buildJsonObject { put("fallbackRevertPolicy", "sometimes") }) })
                .isNotEmpty(),
        )
        assertTrue(
            issues(
                buildJsonObject {
                    put(
                        "compaction",
                        buildJsonObject {
                            put(
                                "methodOrder",
                                kotlinx.serialization.json.JsonArray(
                                    listOf("remote", "remote").map { kotlinx.serialization.json.JsonPrimitive(it) },
                                ),
                            )
                        },
                    )
                },
            ).isNotEmpty(),
        )
        assertTrue(issues(buildJsonObject { put("memory", buildJsonObject { put("backend", "redis") }) }).isNotEmpty())
        assertTrue(
            issues(buildJsonObject { put("mnemopi", buildJsonObject { put("scoping", "galaxy") }) }).isNotEmpty(),
        )
        assertTrue(
            issues(buildJsonObject { put("enabledModels", kotlinx.serialization.json.JsonArray(emptyList())) })
                .isEmpty(),
        )
        assertTrue(
            issues(
                buildJsonObject {
                    put(
                        "enabledModels",
                        kotlinx.serialization.json.JsonArray(
                            listOf(kotlinx.serialization.json.JsonPrimitive("")),
                        ),
                    )
                },
            ).isNotEmpty(),
        )
        assertTrue(
            issues(
                buildJsonObject {
                    put(
                        "compaction",
                        buildJsonObject {
                            put(
                                "methodOrder",
                                kotlinx.serialization.json.JsonArray(
                                    listOf("remote", "handoff", "soft", "shake", "snapcompact")
                                        .map { kotlinx.serialization.json.JsonPrimitive(it) },
                                ),
                            )
                        },
                    )
                },
            ).isEmpty(),
        )
    }

    @Test
    fun `save queue coalesces pending edits`() {
        val first = NativeSettingsDocument().withString("textVerbosity", "low")
        val second = NativeSettingsDocument().withString("textVerbosity", "high")
        val queue = NativeSettingsSaveQueue()
        assertEquals(0, queue.confirmed.root.size)
        queue.edit(first)
        queue.edit(second)
        assertEquals(second, queue.current)
        assertTrue(queue.hasPending)
        assertEquals(second, queue.take())
        assertFalse(queue.hasPending)
        assertNull(queue.take())
        assertEquals("medium", queue.current.textVerbosity())
    }

    @Test
    fun `save queue confirms canonical settings and reverts failures`() {
        val queue = NativeSettingsSaveQueue()
        val sent = queue.edit(NativeSettingsDocument().withBool("externalThinking", true))
        val canonical = NativeSettingsDocument().withBool("externalThinking", false)
        queue.confirm(canonical)
        assertEquals(canonical, queue.current)
        queue.edit(sent)
        assertEquals(sent, queue.current)
        assertEquals(sent, queue.take())
        assertEquals(canonical, queue.fail())
        assertEquals(canonical, queue.current)
        assertFalse(queue.hasPending)
    }

    /** B21: the web's autolearn card (`AutolearnConfig.tsx`) defaults auto-continue on. */
    @Test
    fun autolearnAutoContinueDefaultAndSetter() {
        assertEquals(true, NativeSettingsDefaults.AUTOLEARN_AUTO_CONTINUE)
        assertTrue(NativeSettingsDocument().autolearnAutoContinue())

        val off = NativeSettingsDocument().withSectionBool("autolearn", "autoContinue", false)
        assertEquals(false, off.autolearnAutoContinue())
        assertEquals(false, off.sectionBool("autolearn", "autoContinue"))

        // Setting it back on removes the false flag, so the default applies again.
        val on = off.withSectionBool("autolearn", "autoContinue", null)
        assertNull(on.sectionBool("autolearn", "autoContinue"))
        assertTrue(on.autolearnAutoContinue())
        assertTrue(validateNativeSettings(on).isEmpty())
    }

    @Test
    fun `save queue keeps a draft made while the save is in flight`() {
        val queue = NativeSettingsSaveQueue()
        val first = queue.edit(NativeSettingsDocument().withString("textVerbosity", "low"))
        assertEquals(first, queue.take())
        val second = queue.edit(NativeSettingsDocument().withString("textVerbosity", "high"))
        queue.confirm(NativeSettingsDocument().withString("textVerbosity", "low"))
        assertEquals(second, queue.current)
        assertTrue(queue.hasPending)
        assertEquals(second, queue.take())
    }
}
