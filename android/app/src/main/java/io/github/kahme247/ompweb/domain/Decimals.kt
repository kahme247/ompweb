package io.github.kahme247.ompweb.domain

/**
 * [value] rounded half away from zero to [decimals] places, without a trailing
 * `.0` — the shape of the web's `toFixed(n).replace(/\.0$/, "")` in the file
 * size and token chips. One implementation for both, so their rounding cannot
 * drift apart.
 */
fun formatDecimal(value: Double, decimals: Int = 1): String {
    if (decimals <= 0) return Math.round(value).toString()
    var factor = 1.0
    repeat(decimals) { factor *= 10.0 }
    val rounded = Math.round(value * factor) / factor
    val text = rounded.toString()
    return if (text.endsWith(".0")) text.dropLast(2) else text
}
