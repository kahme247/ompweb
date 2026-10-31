package io.github.kahme247.ompweb.domain

import io.github.kahme247.ompweb.net.ProviderUsageReport
import io.github.kahme247.ompweb.net.ProviderUsageWindow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The sessions list shows its warning row exactly when a limit is tight. These
 * tests pin that decision (and only that): the row must stay absent while every
 * window has room, and must name the account/window with the least room once a
 * window reaches 80 %.
 */
class ProviderUsageWarningTest {

    @Test
    fun noReportOrNoWindowNeverWarns() {
        assertNull(providerUsageWarning(emptyList()))
        assertNull(
            "an account that reports no limits has nothing to warn about",
            providerUsageWarning(
                listOf(ProviderUsageReport(provider = "anthropic", accountLabel = "work", noLimits = true)),
            ),
        )
    }

    @Test
    fun belowTheThresholdThereIsNoRow() {
        assertNull(
            providerUsageWarning(
                listOf(
                    ProviderUsageReport(
                        provider = "anthropic",
                        accountLabel = "work",
                        fiveHour = ProviderUsageWindow(percent = 79.9),
                        sevenDay = ProviderUsageWindow(percent = 42.0),
                    ),
                ),
            ),
        )
    }

    @Test
    fun exactlyEightyPercentWarns() {
        val warning = providerUsageWarning(
            listOf(
                ProviderUsageReport(
                    provider = "anthropic",
                    accountLabel = "work",
                    plan = "Max",
                    sevenDay = ProviderUsageWindow(percent = 80.0),
                ),
            ),
        )
        assertEquals(
            ProviderUsageWarning(account = "work · Max", window = "7D", percent = 80),
            warning,
        )
    }

    @Test
    fun theHighestWindowAcrossAllAccountsWins() {
        val warning = providerUsageWarning(
            listOf(
                ProviderUsageReport(
                    provider = "anthropic",
                    accountLabel = "work",
                    fiveHour = ProviderUsageWindow(percent = 82.0),
                    sevenDay = ProviderUsageWindow(percent = 85.0),
                ),
                ProviderUsageReport(
                    provider = "openai",
                    accountLabel = "personal",
                    monthly = ProviderUsageWindow(percent = 92.0),
                ),
                ProviderUsageReport(
                    provider = "groq",
                    accountLabel = "spare",
                    fiveHour = ProviderUsageWindow(percent = 88.0),
                ),
            ),
        )
        assertEquals(ProviderUsageWarning(account = "personal", window = "30D", percent = 92), warning)
    }

    @Test
    fun aTieKeepsTheFirstAccountAndWindow() {
        val warning = providerUsageWarning(
            listOf(
                ProviderUsageReport(
                    provider = "anthropic",
                    accountLabel = "first",
                    fiveHour = ProviderUsageWindow(percent = 85.0),
                    sevenDay = ProviderUsageWindow(percent = 85.0),
                ),
                ProviderUsageReport(
                    provider = "openai",
                    accountLabel = "second",
                    fiveHour = ProviderUsageWindow(percent = 85.0),
                ),
            ),
        )
        assertEquals(ProviderUsageWarning(account = "first", window = "5H", percent = 85), warning)
    }

    @Test
    fun thePercentIsRoundedForTheRow() {
        val warning = providerUsageWarning(
            listOf(
                ProviderUsageReport(
                    provider = "anthropic",
                    fiveHour = ProviderUsageWindow(percent = 85.6),
                ),
            ),
        )
        assertEquals("anthropic", warning?.account)
        assertEquals("5H", warning?.window)
        assertEquals(86, warning?.percent)
    }

    @Test
    fun theAccountLineMatchesTheFullBlock() {
        assertEquals(
            "work · Max #2",
            providerUsageAccountLabel(
                ProviderUsageReport(
                    provider = "anthropic",
                    accountLabel = "work",
                    plan = "Max",
                    accountIndex = 2,
                ),
            ),
        )
        assertEquals(
            "anthropic",
            providerUsageAccountLabel(ProviderUsageReport(provider = "anthropic")),
        )
    }

    @Test
    fun windowsKeepTheBlocksShortNames() {
        val windows = providerUsageWindows(
            ProviderUsageReport(
                provider = "anthropic",
                fiveHour = ProviderUsageWindow(percent = 1.0),
                sevenDay = ProviderUsageWindow(percent = 2.0),
                monthly = ProviderUsageWindow(percent = 3.0),
            ),
        )
        assertEquals(listOf("5H", "7D", "30D"), windows.map { it.first })
        assertEquals(3.0, windows.last().second.percent, 0.0)
        assertNull(providerUsageWorstWindow(ProviderUsageReport(provider = "anthropic")))
    }

    @Test
    fun theThresholdIsAdjustable() {
        val reports = listOf(
            ProviderUsageReport(provider = "anthropic", fiveHour = ProviderUsageWindow(percent = 55.0)),
        )
        assertNull(providerUsageWarning(reports))
        assertEquals(
            ProviderUsageWarning(account = "anthropic", window = "5H", percent = 55),
            providerUsageWarning(reports, threshold = 50.0),
        )
    }
}
