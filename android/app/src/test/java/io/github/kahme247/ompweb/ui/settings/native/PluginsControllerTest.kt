package io.github.kahme247.ompweb.ui.settings.native

import io.github.kahme247.ompweb.net.PluginAction
import io.github.kahme247.ompweb.net.PluginDiagnostic
import io.github.kahme247.ompweb.net.PluginPackageInfo
import io.github.kahme247.ompweb.net.PluginResourceCounts
import io.github.kahme247.ompweb.net.PluginsApi
import io.github.kahme247.ompweb.net.PluginsSnapshot
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * B26: every plugin card action goes to `/api/plugins` with the package's own
 * source and scope, and the page always shows the server's refreshed list.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class PluginsControllerTest {

    private fun pkg(
        source: String,
        scope: String = "project",
        disabled: Boolean = false,
        status: String = "installed",
    ) = PluginPackageInfo(
        source = source,
        scope = scope,
        filtered = false,
        disabled = disabled,
        installedPath = "/plugins/$source",
        packageName = source.substringAfterLast('/'),
        version = "1.0.0",
        configuredVersion = "1.0.0",
        counts = PluginResourceCounts(extensions = 1),
        resources = emptyList(),
        status = status,
    )

    private fun snapshot(vararg packages: PluginPackageInfo) = PluginsSnapshot(
        packages = packages.toList(),
        totals = PluginResourceCounts(extensions = packages.size),
        diagnostics = emptyList<PluginDiagnostic>(),
    )

    private class FakePluginsApi(private val fallback: PluginsSnapshot) : PluginsApi {
        val actions = mutableListOf<Triple<PluginAction, String?, String>>()
        val reloaded = mutableListOf<String>()
        var loads = 0
        var answer: PluginsSnapshot = fallback

        override suspend fun load(cwd: String): PluginsSnapshot {
            loads += 1
            return answer
        }

        override suspend fun action(
            action: PluginAction,
            source: String?,
            scope: String,
            cwd: String,
        ): PluginsSnapshot {
            actions += Triple(action, source, scope)
            return answer
        }

        override suspend fun reload(sessionId: String) {
            reloaded += sessionId
        }
    }

    @Test
    fun `install sends the typed source with the chosen scope`() = runTest(UnconfinedTestDispatcher()) {
        val api = FakePluginsApi(snapshot(pkg("npm:omp-plugin-a")))
        val controller = PluginsController(api, this)

        controller.load("/repo")
        runCurrent()
        controller.openAdd()
        controller.setSource("  npx:omp-plugin-a  ")
        controller.setScope("project")
        controller.install("/repo")
        runCurrent()

        assertEquals(listOf(Triple(PluginAction.INSTALL, "npx:omp-plugin-a", "project")), api.actions)
        val state = controller.state.value
        assertEquals("Package installed.", state.notice)
        assertFalse("the add panel closes after installing", state.adding)
        assertEquals("", state.source)
        assertEquals("/repo", state.loadedFor)
        assertNull(state.busy)
    }

    @Test
    fun `enable and disable use the package's own source and scope`() = runTest(UnconfinedTestDispatcher()) {
        val global = pkg("npm:omp-plugin-a", scope = "global", disabled = true)
        val api = FakePluginsApi(snapshot(global))
        val controller = PluginsController(api, this)

        controller.load("/repo")
        runCurrent()
        controller.action(PluginAction.ENABLE, global, "/repo")
        runCurrent()
        controller.action(PluginAction.DISABLE, global, "/repo")
        runCurrent()

        assertEquals(
            listOf(
                Triple(PluginAction.ENABLE, "npm:omp-plugin-a", "global"),
                Triple(PluginAction.DISABLE, "npm:omp-plugin-a", "global"),
            ),
            api.actions,
        )
        assertEquals("Package disabled.", controller.state.value.notice)
    }

    @Test
    fun `update replaces the snapshot with the server answer`() = runTest(UnconfinedTestDispatcher()) {
        val api = FakePluginsApi(snapshot(pkg("npm:omp-plugin-a", status = "update-available")))
        val controller = PluginsController(api, this)

        controller.load("/repo")
        runCurrent()
        val selected = controller.state.value.snapshot!!.packages.single()
        controller.select(selected.source)
        api.answer = snapshot(pkg("npm:omp-plugin-a", status = "installed"))

        controller.action(PluginAction.UPDATE, selected, "/repo")
        runCurrent()

        assertEquals(Triple(PluginAction.UPDATE, "npm:omp-plugin-a", "project"), api.actions.single())
        assertEquals("installed", controller.state.value.snapshot!!.packages.single().status)
        assertEquals("Package updated.", controller.state.value.notice)
        // The selection survives an update.
        assertEquals("npm:omp-plugin-a", controller.state.value.selected)
    }

    @Test
    fun `remove clears the selection and keeps the refreshed list`() = runTest(UnconfinedTestDispatcher()) {
        val api = FakePluginsApi(snapshot(pkg("npm:omp-plugin-a")))
        val controller = PluginsController(api, this)

        controller.load("/repo")
        runCurrent()
        val selected = controller.state.value.snapshot!!.packages.single()
        controller.select(selected.source)
        api.answer = snapshot()

        controller.action(PluginAction.REMOVE, selected, "/repo")
        runCurrent()

        assertEquals("Package removed.", controller.state.value.notice)
        assertNull(controller.state.value.selected)
        assertTrue(controller.state.value.snapshot!!.packages.isEmpty())
    }

    @Test
    fun `reload tells the open session to pick up the change`() = runTest(UnconfinedTestDispatcher()) {
        val api = FakePluginsApi(snapshot())
        val controller = PluginsController(api, this)

        controller.reload("session-1")
        runCurrent()

        assertEquals(listOf("session-1"), api.reloaded)
        assertFalse(controller.state.value.reloading)
        assertEquals("Session reloaded.", controller.state.value.notice)
    }

    @Test
    fun `an action failure keeps the list and shows the error`() = runTest(UnconfinedTestDispatcher()) {
        val failing = object : PluginsApi by FakePluginsApi(snapshot(pkg("npm:omp-plugin-a"))) {
            override suspend fun action(
                action: PluginAction,
                source: String?,
                scope: String,
                cwd: String,
            ): PluginsSnapshot = throw IllegalStateException("omp: plugin not found")
        }
        val controller = PluginsController(failing, this)

        controller.load("/repo")
        runCurrent()
        val before = controller.state.value.snapshot
        controller.action(PluginAction.ENABLE, before!!.packages.single(), "/repo")
        runCurrent()

        assertEquals(before, controller.state.value.snapshot)
        assertTrue(controller.state.value.noticeError)
        assertEquals("omp: plugin not found", controller.state.value.notice)
        assertNull(controller.state.value.busy)
    }
}
