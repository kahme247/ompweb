package io.github.kahme247.ompweb.domain

/**
 * Tool presets for a newly created session.
 *
 * Wire contract (`lib/tool-presets.ts` `getToolNamesForPreset`): `none` sends
 * an explicit empty array, `default` sends `read,bash,edit,write`, and `full`
 * omits `toolNames` entirely so the server keeps omp's complete toolset.
 */
enum class ToolPreset(val wireName: String) {
    NONE("none"),
    DEFAULT("default"),
    FULL("full");

    /** `null` means "omit the field", not "no tools". */
    fun toolNames(): List<String>? = when (this) {
        NONE -> emptyList()
        DEFAULT -> listOf("read", "bash", "edit", "write")
        FULL -> null
    }

    companion object {
        fun fromWire(value: String?): ToolPreset =
            entries.firstOrNull { it.wireName == value } ?: FULL
    }
}
