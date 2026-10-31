package io.github.kahme247.ompweb.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Mirrors `lib/thinking-levels.test.mjs` case for case. */
class ThinkingLevelsTest {

    private val luna = ModelKey("openai", "gpt-5.6-luna")

    private val liveLuna = ThinkingModelMeta(
        provider = "openai",
        modelId = "gpt-5.6-luna",
        reasoning = true,
        efforts = listOf("low", "medium", "high", "xhigh", "max"),
    )

    private val liveNonReasoning = ThinkingModelMeta(
        provider = "openai",
        modelId = "gpt-4",
        reasoning = false,
    )

    @Test
    fun `catalog ladder wins for a known model`() {
        assertEquals(
            listOf("off", "low", "medium", "high"),
            resolveAvailableThinkingLevels(listOf("off", "low", "medium", "high"), luna, liveLuna),
        )
    }

    @Test
    fun `catalog wins even when the live model differs (user just picked a model)`() {
        val picked = ModelKey("google-antigravity", "gemini-3-pro")
        assertEquals(
            listOf("off", "low", "high"),
            resolveAvailableThinkingLevels(listOf("off", "low", "high"), picked, liveLuna),
        )
    }

    @Test
    fun `live model ladder backs a non-catalog model`() {
        assertEquals(
            listOf("off", "low", "medium", "high", "xhigh", "max"),
            resolveAvailableThinkingLevels(null, luna, liveLuna),
        )
    }

    @Test
    fun `live non-reasoning model offers only off`() {
        assertEquals(
            listOf("off"),
            resolveAvailableThinkingLevels(null, ModelKey("openai", "gpt-4"), liveNonReasoning),
        )
    }

    @Test
    fun `live model with no efforts resolves to off only`() {
        val live = ThinkingModelMeta(provider = "custom", modelId = "m", reasoning = true, efforts = null)
        assertEquals(
            listOf("off"),
            resolveAvailableThinkingLevels(null, ModelKey("custom", "m"), live),
        )
    }

    @Test
    fun `null when the live model does not match the current model`() {
        assertNull(
            resolveAvailableThinkingLevels(
                null,
                ModelKey("openai-codex", "gpt-5.6-sol"),
                liveLuna,
            ),
        )
    }

    @Test
    fun `null when there is no live model`() {
        assertNull(resolveAvailableThinkingLevels(null, luna, null))
    }

    @Test
    fun `null when there is no model at all`() {
        assertNull(resolveAvailableThinkingLevels(null, null, liveLuna))
    }

    @Test
    fun `empty catalog array is treated as a miss (no levels)`() {
        assertEquals(
            listOf("off", "low", "medium", "high", "xhigh", "max"),
            resolveAvailableThinkingLevels(emptyList(), luna, liveLuna),
        )
    }

    @Test
    fun `thinkingLevelsForMeta mirrors the models route ladder`() {
        assertEquals(
            listOf("off", "minimal", "low"),
            thinkingLevelsForMeta(
                ThinkingModelMeta(
                    provider = "x",
                    modelId = "y",
                    reasoning = true,
                    efforts = listOf("minimal", "low"),
                ),
            ),
        )
        assertEquals(listOf("off"), thinkingLevelsForMeta(ThinkingModelMeta("x", "y", reasoning = false)))
        assertEquals(listOf("off"), thinkingLevelsForMeta(ThinkingModelMeta("x", "y")))
    }

    @Test
    fun `selectable levels preserve provider-defined efforts outside the built-in UI ladder`() {
        assertEquals(
            listOf("auto", "off", "low", "ultra", "provider-max"),
            selectableThinkingLevels(listOf("off", "low", "ultra", "provider-max", "ultra")),
        )
    }

    @Test
    fun `selectable levels fall back to the generic ladder`() {
        assertEquals(DEFAULT_THINKING_LEVELS, selectableThinkingLevels(null))
    }

    @Test
    fun `omp's inherit sentinel shows as auto`() {
        assertEquals("auto", normalizeThinkingLevel(null))
        assertEquals("auto", normalizeThinkingLevel(""))
        assertEquals("auto", normalizeThinkingLevel("inherit"))
        assertEquals("xhigh", normalizeThinkingLevel("xhigh"))
    }
}
