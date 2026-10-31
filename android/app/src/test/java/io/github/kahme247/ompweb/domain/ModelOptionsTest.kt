package io.github.kahme247.ompweb.domain

import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Mirrors `ChatInput.test.mjs` ("filters model options…", "nested model picker
 * groups by provider…") and `ModelsConfig.test.mjs` (`providerInitials`), plus
 * the allow-list/sort rules of `ChatInput-model-options.ts`.
 */
class ModelOptionsTest {

    private val collator = ModelNameComparator(Locale.US)

    private val options = listOf(
        ModelOption("OpenAI", "gpt-5.2", "GPT-5.2"),
        ModelOption("Anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
    )

    @Test
    fun `filters model options by display name, identifier, and provider`() {
        assertEquals(listOf(options[1]), filterModelOptions(options, "sonnet", Locale.US))
        assertEquals(listOf(options[0]), filterModelOptions(options, "5.2", Locale.US))
        assertEquals(listOf(options[0]), filterModelOptions(options, "OPENAI", Locale.US))
        assertEquals(options, filterModelOptions(options, "   ", Locale.US))
    }

    @Test
    fun `a blank name falls back to the id for display and matching`() {
        val unnamed = ModelOption("acme", "acme-fast")
        assertEquals("acme-fast", unnamed.displayName)
        assertEquals(listOf(unnamed), filterModelOptions(listOf(unnamed), "acme-fast", Locale.US))
    }

    @Test
    fun `nested model picker groups by provider and pins the current provider first`() {
        val rows = listOf(
            ModelOption("anthropic", "claude", "Claude"),
            ModelOption("openai", "gpt-5.6-sol", "GPT-5.6 Sol"),
            ModelOption("openai", "gpt-5.5", "GPT-5.5"),
            ModelOption("pi", "pi-1", "Pi"),
        )
        val grouped = groupModelOptionsByProvider(rows)
        assertEquals(listOf("anthropic", "openai", "pi"), grouped.map { it.provider })
        assertEquals(2, grouped[1].options.size)

        val ordered = orderProviderGroups(grouped, "openai")
        assertEquals(listOf("openai", "anthropic", "pi"), ordered.map { it.provider })
        assertEquals(listOf("anthropic", "openai", "pi"), orderProviderGroups(grouped, null).map { it.provider })
        assertEquals(listOf("anthropic", "openai", "pi"), orderProviderGroups(grouped, "missing").map { it.provider })
    }

    @Test
    fun `provider initials take the first letter of up to two parts`() {
        assertEquals("AP", providerInitials("acme-provider"))
        assertEquals("MC", providerInitials("my_custom_gateway"))
        assertEquals("P", providerInitials("provider"))
        assertEquals("?", providerInitials(""))
    }

    @Test
    fun `the allow-list filters the catalog before it is name-sorted`() {
        val rows = listOf(
            ModelOption("openai", "gpt-5.10", "GPT-5.10"),
            ModelOption("openai", "gpt-5.2", "GPT-5.2"),
            ModelOption("anthropic", "claude", "Claude"),
        )
        // Never written: every model is visible.
        assertEquals(
            listOf("Claude", "GPT-5.2", "GPT-5.10"),
            buildModelOptions(rows, null, collator).map { it.displayName },
        )
        // Stored empty list: the picker offers nothing.
        assertEquals(emptyList<ModelOption>(), buildModelOptions(rows, emptySet(), collator))
        assertEquals(
            listOf("GPT-5.10"),
            buildModelOptions(rows, setOf("openai:gpt-5.10"), collator).map { it.displayName },
        )
    }

    @Test
    fun `the name comparator sorts digit runs by value`() {
        val rows = listOf(
            ModelOption("p", "x-10", "X 10"),
            ModelOption("p", "x-2", "X 2"),
            ModelOption("p", "x-1", "X 1"),
        )
        assertEquals(
            listOf("X 1", "X 2", "X 10"),
            buildModelOptions(rows, null, collator).map { it.displayName },
        )
    }

    @Test
    fun `name ties break by provider then id`() {
        val rows = listOf(
            ModelOption("zeta", "a", "Same"),
            ModelOption("alpha", "b", "Same"),
            ModelOption("alpha", "a", "Same"),
        )
        assertEquals(
            listOf("alpha:a", "alpha:b", "zeta:a"),
            buildModelOptions(rows, null, collator).map { it.key },
        )
    }
}
