package io.github.kahme247.ompweb.domain

import java.text.Collator
import java.util.Locale

/**
 * Model-picker options and ordering, ported from
 * `components/ChatInput-model-options.ts` and the grouping helpers of
 * `components/ChatInput-model-picker.tsx`.
 */

/** One row of the picker (`ModelOption`). */
data class ModelOption(val provider: String, val modelId: String, val name: String = "") {
    /** `provider:modelId` — the key `omp-composer-models` stores. */
    val key: String get() = "$provider:$modelId"

    /** The name the picker paints, falling back to the id like the web. */
    val displayName: String get() = name.ifBlank { modelId }
}

/**
 * `Intl.Collator(locale, {numeric: true, sensitivity: "base"})`: case- and
 * accent-insensitive, but digit runs compare by value (`gpt-5.2` before `gpt-5.10`).
 */
class ModelNameComparator(locale: Locale = Locale.getDefault()) : Comparator<String> {
    private val collator: Collator = Collator.getInstance(locale).apply {
        strength = Collator.PRIMARY
    }

    override fun compare(a: String, b: String): Int {
        var i = 0
        var j = 0
        while (i < a.length && j < b.length) {
            val digitRun = a[i].isDigit() && b[j].isDigit()
            val startA = i
            val startB = j
            if (digitRun) {
                while (i < a.length && a[i].isDigit()) i++
                while (j < b.length && b[j].isDigit()) j++
                val numberA = a.substring(startA, i).trimStart('0')
                val numberB = b.substring(startB, j).trimStart('0')
                if (numberA.length != numberB.length) return numberA.length - numberB.length
                val numeric = numberA.compareTo(numberB)
                if (numeric != 0) return numeric
            } else {
                while (i < a.length && !a[i].isDigit()) i++
                while (j < b.length && !b[j].isDigit()) j++
                val textual = collator.compare(a.substring(startA, i), b.substring(startB, j))
                if (textual != 0) return textual
            }
        }
        return (a.length - i) - (b.length - j)
    }
}

/** `compareModelOptions`: display name, then provider, then id. */
fun compareModelOptions(a: ModelOption, b: ModelOption, comparator: Comparator<String>): Int {
    val byName = comparator.compare(a.displayName, b.displayName)
    if (byName != 0) return byName
    val byProvider = comparator.compare(a.provider, b.provider)
    if (byProvider != 0) return byProvider
    return comparator.compare(a.modelId, b.modelId)
}

/** The catalog rows the picker offers: allow-list filtered, then name-sorted. */
fun buildModelOptions(
    models: List<ModelOption>,
    visibleKeys: Set<String>?,
    comparator: Comparator<String> = ModelNameComparator(),
): List<ModelOption> = models
    .filter { visibleKeys == null || visibleKeys.contains(it.key) }
    .sortedWith { a, b -> compareModelOptions(a, b, comparator) }

/** `filterModelOptions`: case-insensitive substring over name, id and provider. */
fun filterModelOptions(
    options: List<ModelOption>,
    query: String,
    locale: Locale = Locale.getDefault(),
): List<ModelOption> {
    val normalizedQuery = query.trim().lowercase(locale)
    if (normalizedQuery.isEmpty()) return options
    return options.filter { option ->
        option.name.lowercase(locale).contains(normalizedQuery) ||
            option.modelId.lowercase(locale).contains(normalizedQuery) ||
            option.provider.lowercase(locale).contains(normalizedQuery)
    }
}

/** One provider rail entry with that provider's models. */
data class ProviderModelGroup(val provider: String, val options: List<ModelOption>)

/** `groupModelOptionsByProvider`: provider first-seen order from the sorted list. */
fun groupModelOptionsByProvider(options: List<ModelOption>): List<ProviderModelGroup> {
    val order = ArrayList<String>()
    val byProvider = LinkedHashMap<String, MutableList<ModelOption>>()
    for (option in options) {
        val bucket = byProvider.getOrPut(option.provider) {
            order += option.provider
            mutableListOf()
        }
        bucket += option
    }
    return order.map { provider -> ProviderModelGroup(provider, byProvider.getValue(provider)) }
}

/** `orderProviderGroups`: the current model's provider first so the picker opens on what you use. */
fun orderProviderGroups(
    groups: List<ProviderModelGroup>,
    currentProvider: String?,
): List<ProviderModelGroup> {
    if (currentProvider == null) return groups
    val index = groups.indexOfFirst { it.provider == currentProvider }
    if (index <= 0) return groups
    return buildList(groups.size) {
        add(groups[index])
        groups.forEachIndexed { at, group -> if (at != index) add(group) }
    }
}

/** `providerInitials`: the first letter of up to two `-`/`_` separated parts. */
fun providerInitials(id: String): String {
    val parts = id.split('-', '_').filter { it.isNotEmpty() }.take(2)
    val initials = parts.mapNotNull { it.firstOrNull() }.joinToString("").uppercase()
    return initials.ifEmpty { "?" }
}
