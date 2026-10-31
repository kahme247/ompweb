package io.github.kahme247.ompweb.domain

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Mirrors `lib/omp/models-config.test.mjs` and `ModelsConfig.test.mjs`: the
 * JSON round-trip that stands in for YAML, the editor rules and the System
 * tab's registry/role/fallback helpers.
 */
class ModelsConfigTest {

    private fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

    @Test
    fun `parse and toJson round-trip unknown keys and explicit nulls`() {
        val original = json(
            """
            {
              "providers": {
                "openai": {
                  "baseUrl": "https://api.example.com/v1",
                  "apiKey": "sk-x",
                  "api": "openai-completions",
                  "headers": {"X-Test": "1"},
                  "compat": {"reasoning": "yes"},
                  "models": [
                    {
                      "id": "gpt-x",
                      "name": "GPT X",
                      "reasoning": true,
                      "thinking": {
                        "mode": "effort",
                        "efforts": ["low", "high"],
                        "effortMap": {"low": "minimal"},
                        "defaultLevel": "low",
                        "custom": "keep"
                      },
                      "input": ["text", "image"],
                      "contextWindow": 128000,
                      "maxTokens": 16384,
                      "cost": {"input": 1.0, "output": 2.0, "cacheRead": 0.5, "cacheWrite": 0.25, "currency": "usd"},
                      "baseUrl": "http://localhost:9999/v1",
                      "extra": null
                    }
                  ]
                },
                "empty": {"auth": null}
              },
              "otherKey": {"a": 1},
              "explicitNull": null
            }
            """,
        )
        assertEquals(original, parseModelsFile(original).toJson())
    }

    @Test
    fun `shaped oddities are preserved verbatim instead of dropped`() {
        val original = json(
            """
            {
              "providers": {
                "p": {
                  "models": "not-a-list",
                  "headers": ["not", "a", "map"]
                },
                "q": {
                  "api": "openai-completions",
                  "models": [{"id": "m", "input": {"broken": true}, "thinking": 3}]
                }
              }
            }
            """,
        )
        val parsed = parseModelsFile(original)
        assertEquals(original, parsed.toJson())
    }

    @Test
    fun `untouched model drafts and blank ids never reach the save body`() {
        val start = ModelsFileConfig(
            providers = mapOf(
                "p" to ProviderConfig(
                    baseUrl = "https://example.test/v1",
                    apiKey = "k",
                    api = "openai-completions",
                    models = listOf(ModelConfig(id = "keep")),
                ),
            ),
        )
        val (withDraft, index) = start.addModelDraft("p")
        assertEquals(1, index)
        assertEquals(1, start.forSave().providers.getValue("p").models.size)
        assertEquals(2, withDraft.providers.getValue("p").models.size)
        assertEquals(1, withDraft.forSave().providers.getValue("p").models.size)
        assertTrue(withDraft.providers.getValue("p").models.last().isUntouchedDraft)

        val saveable = ModelsFileConfig(
            providers = mapOf("p" to ProviderConfig(models = listOf(ModelConfig(id = ""), ModelConfig(id = "kept")))),
        ).forSave()
        assertEquals(listOf("kept"), saveable.providers.getValue("p").models.map { it.id })
    }

    @Test
    fun `validation mirrors the server messages`() {
        val models = listOf(ModelConfig(id = "m", api = "openai-completions"))

        assertEquals(
            "Provider p: \"baseUrl\" is required when defining custom models.",
            validateModelsConfig(ModelsFileConfig(providers = mapOf("p" to ProviderConfig(models = models)))),
        )

        assertEquals(
            "Provider p: \"baseUrl\" must be an http:// or https:// URL.",
            validateModelsConfig(
                ModelsFileConfig(
                    providers = mapOf(
                        "p" to ProviderConfig(
                            baseUrl = "not-a-url",
                            auth = "none",
                            api = "openai-completions",
                        ),
                    ),
                ),
            ),
        )

        assertNull(
            validateModelsConfig(
                ModelsFileConfig(
                    providers = mapOf(
                        "p" to ProviderConfig(
                            baseUrl = "http://localhost:11434/v1",
                            auth = "none",
                            api = "openai-completions",
                            models = models,
                        ),
                    ),
                ),
            ),
        )

        assertEquals(
            "Provider p, model m: no \"api\" specified. Set at provider or model level.",
            validateModelsConfig(
                ModelsFileConfig(
                    providers = mapOf(
                        "p" to ProviderConfig(
                            baseUrl = "http://x.test/v1",
                            auth = "none",
                            models = listOf(ModelConfig(id = "m")),
                        ),
                    ),
                ),
            ),
        )

        assertEquals(
            "Provider p, model m: invalid contextWindow",
            validateModelsConfig(
                ModelsFileConfig(
                    providers = mapOf(
                        "p" to ProviderConfig(
                            baseUrl = "http://x.test/v1",
                            auth = "none",
                            api = "openai-completions",
                            models = listOf(ModelConfig(id = "m", contextWindow = 0)),
                        ),
                    ),
                ),
            ),
        )

        assertEquals(
            "Provider p, model m: cost.input is required (cost needs input, output, cacheRead, and cacheWrite)",
            validateModelsConfig(
                ModelsFileConfig(
                    providers = mapOf(
                        "p" to ProviderConfig(
                            baseUrl = "http://x.test/v1",
                            auth = "none",
                            api = "openai-completions",
                            models = listOf(
                                ModelConfig(id = "m", cost = ModelCostConfig(output = 1.0, cacheRead = 0.0, cacheWrite = 0.0)),
                            ),
                        ),
                    ),
                ),
            ),
        )
    }

    @Test
    fun `baseUrl scheme is case-insensitive and invalid shapes stay blocked`() {
        assertTrue(isValidProviderBaseUrl("HTTPS://api.example.test/v1"))
        assertTrue(isValidProviderBaseUrl(" Http://localhost:11434/v1 "))
        assertTrue(isValidProviderBaseUrl(""))
        assertTrue(isValidProviderBaseUrl(null))
        assertFalse(isValidProviderBaseUrl("not-a-url"))
        assertFalse(isValidProviderBaseUrl("ftp://x.test"))

        assertNull(
            validateModelsConfig(
                ModelsFileConfig(
                    providers = mapOf(
                        "p" to ProviderConfig(
                            baseUrl = "HTTPS://api.example.test/v1",
                            auth = "none",
                            api = "openai-completions",
                            models = listOf(ModelConfig(id = "m")),
                        ),
                    ),
                ),
            ),
        )
    }

    @Test
    fun `thinking levels follow the web setLevel rules`() {
        var allDisabled: ThinkingConfig? = null
        MODEL_THINKING_LEVELS.forEach { level ->
            allDisabled = withThinkingLevel(allDisabled, level, included = false, customEffort = null)
        }
        assertNull(allDisabled)

        val allButLow = withThinkingLevel(null, "low", included = false, customEffort = null)
        assertNotNull(allButLow)
        assertEquals("effort", allButLow!!.mode)
        assertEquals(listOf("minimal", "medium", "high", "xhigh", "max"), allButLow.efforts)

        val custom = withThinkingLevel(null, "low", included = true, customEffort = "minimal")
        assertEquals(listOf("minimal", "low", "medium", "high", "xhigh", "max"), custom!!.efforts)
        assertEquals(mapOf("low" to "minimal"), custom.effortMap)

        val reenabled = withThinkingLevel(custom, "low", included = true, customEffort = "")
        assertNull(reenabled)

        // Re-including the last missing level with no override resets to auto.
        assertNull(withThinkingLevel(allButLow, "low", included = true, customEffort = null))

        // Unknown level is a no-op, not a crash.
        assertEquals(custom, withThinkingLevel(custom, "off", included = true, customEffort = null))
    }

    @Test
    fun `role selectors round-trip model and effort`() {
        val selector = parseModelRoleSelector("anthropic/claude-sonnet:high")
        assertEquals("anthropic/claude-sonnet", selector.model)
        assertEquals("high", selector.effort)
        assertEquals("anthropic/claude-sonnet:high", selector.wire)

        val bare = parseModelRoleSelector("openai/gpt")
        assertNull(bare.effort)
        assertEquals("openai/gpt", bare.wire)

        assertEquals("", composeModelRoleSelector("", "high"))
        assertEquals("openai/gpt", composeModelRoleSelector("openai/gpt", ""))
    }

    @Test
    fun `fallback chains dedupe, remove and swap neighbours`() {
        val chain = listOf("a/1", "b/2")
        assertEquals(chain + "c/3", addFallbackModel(chain, " c/3 "))
        assertEquals(chain, addFallbackModel(chain, "a/1"))
        assertEquals(chain, addFallbackModel(chain, "  "))
        assertEquals(listOf("a/1"), removeFallbackModel(chain, "b/2"))
        assertEquals(listOf("b/2", "a/1"), moveFallbackModel(chain, 0, 1))
        assertEquals(chain, moveFallbackModel(chain, 0, -1))
        assertEquals(chain, moveFallbackModel(chain, 9, 1))
    }

    @Test
    fun `registry helpers keep stored order and toggle the allow list`() {
        assertEquals(
            listOf("zeta", "openai", "anthropic"),
            orderedRegistryProviders(listOf("zeta"), listOf("openai", "anthropic", "zeta")),
        )
        assertEquals(
            listOf("zeta", "openai"),
            orderedRegistryProviders(listOf("zeta"), listOf("openai", "zeta")),
        )
        assertEquals(listOf("a", "b"), toggleModelAllowList(emptyList(), listOf("a", "b"), true))
        assertEquals(emptyList<String>(), toggleModelAllowList(listOf("a"), listOf("a", "b"), false))
        assertEquals(listOf("a", "b"), toggleEnabledModel(listOf("a"), "b", true))
        assertEquals(listOf("a"), toggleEnabledModel(listOf("b", "a"), "b", false))
        assertEquals(listOf("p"), toggleDisabledProvider(emptyList(), "p", true))
        assertEquals(listOf("q"), toggleDisabledProvider(listOf("p", "q"), "p", false))
    }

    @Test
    fun `an empty cost block is dropped but a partial one survives`() {
        assertNull(normalizedModelCost(ModelCostConfig()))
        assertNull(normalizedModelCost(null))
        assertEquals(ModelCostConfig(input = 0.0), normalizedModelCost(ModelCostConfig(input = 0.0)))
    }

    @Test
    fun `composer visibility materializes all models before hiding one`() {
        val options = listOf(
            ModelOption("a", "1", "One"),
            ModelOption("a", "2", "Two"),
            ModelOption("b", "3", "Three"),
        )
        assertEquals(
            setOf("a:1", "b:3"),
            toggleComposerModelVisibility(null, options, "a:2", false),
        )
        assertEquals(
            setOf("a:1", "a:2"),
            toggleComposerProviderVisibility(setOf("a:1"), options, "a", true),
        )
        assertEquals(
            setOf("a:1", "a:2", "b:3"),
            toggleComposerProviderVisibility(null, options, "a", true),
        )
        assertEquals(
            setOf("a:1", "a:2"),
            toggleComposerProviderVisibility(setOf("a:1", "a:2", "b:3"), options, "b", false),
        )
        assertEquals(3, visibleComposerModelCount(null, options))
        assertEquals(2, visibleComposerModelCount(setOf("a:1", "b:3"), options))
    }

    @Test
    fun `config serialization omits blank optional providers but keeps the provider map`() {
        val file = ModelsFileConfig(providers = emptyMap(), extras = mapOf("note" to JsonNull))
        assertEquals(json("""{"providers":{},"note":null}"""), file.toJson())
        val rebuilt = ModelsFileConfig(
            providers = mapOf("p" to ProviderConfig(api = "openai-completions", models = listOf(ModelConfig(id = "m")))),
        )
        assertEquals(
            buildJsonObject {
                put("providers", json("""{"p":{"api":"openai-completions","models":[{"id":"m"}]}}"""))
            },
            rebuilt.toJson(),
        )
    }

    @Test
    fun `fresh provider drafts never serialize empty credentials`() {
        // The web writes `{api: "openai-completions"}`; an empty baseUrl/apiKey
        // would be a real (broken) value to omp.
        val provider = ProviderConfig(baseUrl = "", apiKey = "", api = "openai-completions")
        assertEquals(json("""{"api":"openai-completions"}"""), provider.toJson())
    }

    @Test
    fun `role and fallback pickers offer provider slash model keys`() {
        val options = listOf(ModelOption("anthropic", "claude-sonnet-4-5", "Claude Sonnet"))
        // A role stored in the web's `provider/model` format resolves to a picker entry.
        val stored = parseModelRoleSelector("anthropic/claude-sonnet-4-5:high")
        assertTrue(roleModelKeys(options).contains(stored.model))
        assertEquals(listOf("anthropic/claude-sonnet-4-5"), roleModelKeys(options))
        // The composer's `provider:model` key must never leak into a selector.
        assertFalse(roleModelKeys(options).contains(options.single().key))
    }

    @Test
    fun `a save is blocked when the file changed since it was loaded`() {
        val loaded = json("""{"providers":{"p":{"baseUrl":"https://a.test"}}}""")
        assertFalse(modelsConfigConflict(loaded, json("""{"providers":{"p":{"baseUrl":"https://a.test"}}}""")))
        assertTrue(modelsConfigConflict(loaded, json("""{"providers":{"p":{"baseUrl":"https://b.test"}}}""")))
        assertTrue(modelsConfigConflict(loaded, json("""{"providers":{"p":{},"q":{}}}""")))
        // Without a fresh read the editor cannot know the current file.
        assertTrue(modelsConfigConflict(loaded, null))
    }

    @Test
    fun `non-object providers and models are reported instead of dropped silently`() {
        val parsed = parseModelsFile(
            json("""{"providers":{"ok":{"models":[{"id":"m"},"oops",{"id":"n"}]},"broken":"value"}}"""),
        )
        assertEquals(listOf("ok"), parsed.providers.keys.toList())
        assertEquals(listOf("m", "n"), parsed.providers.getValue("ok").models.map { it.id })
        assertEquals(listOf("providers.ok.models[1]", "providers.broken"), parsed.unparsedEntries)
    }

    @Test
    fun `native settings writes need a loaded snapshot without an error`() {
        val settings = json("""{"retry":{"enabled":true}}""")
        assertTrue(nativeSettingsWritable(settings, null))
        assertFalse(nativeSettingsWritable(null, null))
        assertFalse(nativeSettingsWritable(settings, "HTTP 500"))
        assertFalse(nativeSettingsWritable(null, "HTTP 500"))
    }
}
