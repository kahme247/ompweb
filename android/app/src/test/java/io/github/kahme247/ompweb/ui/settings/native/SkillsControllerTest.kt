package io.github.kahme247.ompweb.ui.settings.native

import io.github.kahme247.ompweb.net.NativeSkillInfo
import io.github.kahme247.ompweb.net.SkillInstallInfo
import io.github.kahme247.ompweb.net.SkillSearchResult
import io.github.kahme247.ompweb.net.SkillSourceInfo
import io.github.kahme247.ompweb.net.SkillUpdateResult
import io.github.kahme247.ompweb.net.SkillsApi
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Update checks must be keyed by install (scope *and* package), not package alone. */
@OptIn(ExperimentalCoroutinesApi::class)
class SkillsControllerTest {

    private fun skill(scope: String, filePath: String) = NativeSkillInfo(
        name = "shared",
        description = "Shared package installed twice",
        filePath = filePath,
        baseDir = filePath.substringBeforeLast('/'),
        disableModelInvocation = false,
        sourceInfo = SkillSourceInfo(source = "skills.sh", scope = scope),
        install = SkillInstallInfo(
            packageName = "shared-package",
            scope = scope,
            source = "skills.sh",
            skillsShUrl = null,
            versionHash = null,
            canCheckForUpdates = true,
        ),
        togglable = true,
    )

    private fun update(scope: String, current: String, latest: String) = SkillUpdateResult(
        packageName = "shared-package",
        scope = scope,
        state = "update-available",
        currentVersion = current,
        latestVersion = latest,
        message = null,
    )

    private class FakeSkillsApi(
        private val skills: List<NativeSkillInfo>,
        private val updates: List<SkillUpdateResult> = emptyList(),
        private val results: List<SkillSearchResult> = emptyList(),
    ) : SkillsApi {
        val toggled = mutableListOf<Triple<String, Boolean, String?>>()
        val installed = mutableListOf<Pair<String, String>>()
        val searched = mutableListOf<String>()

        override suspend fun list(cwd: String): List<NativeSkillInfo> = skills

        override suspend fun setModelInvocationDisabled(filePath: String, disabled: Boolean, cwd: String?): Boolean {
            toggled += Triple(filePath, disabled, cwd)
            return disabled
        }

        override suspend fun search(query: String, limit: Int): List<SkillSearchResult> {
            searched += query
            return results
        }

        override suspend fun install(packageName: String, scope: String, cwd: String?) {
            installed += packageName to scope
        }

        override suspend fun checkUpdates(cwd: String, packageName: String?, scope: String?): List<SkillUpdateResult> =
            updates

        override suspend fun update(cwd: String, packageName: String, scope: String) = Unit
    }

    @Test
    fun `toggle enables and disables model invocation through the server`() = runTest(UnconfinedTestDispatcher()) {
        val disabled = skill("global", "/skills/global/shared/SKILL.md").copy(disableModelInvocation = true)
        val api = FakeSkillsApi(skills = listOf(disabled))
        val controller = SkillsController(api, this)

        controller.load("/project")
        runCurrent()
        controller.toggle(disabled, "/project")
        runCurrent()

        // Enabling sends `disabled = false`; the state takes the server's answer.
        assertEquals(listOf(Triple(disabled.filePath, false, "/project")), api.toggled)
        assertFalse(controller.state.value.skills.single().disableModelInvocation)
        assertTrue(controller.state.value.busy.isEmpty())

        val enabled = controller.state.value.skills.single()
        controller.toggle(enabled, "/project")
        runCurrent()

        assertEquals(true, api.toggled.last().second)
        assertTrue(controller.state.value.skills.single().disableModelInvocation)
    }

    @Test
    fun `a non-togglable skill is left alone`() = runTest(UnconfinedTestDispatcher()) {
        val fixed = skill("global", "/skills/global/shared/SKILL.md").copy(togglable = false)
        val api = FakeSkillsApi(skills = listOf(fixed))
        val controller = SkillsController(api, this)

        controller.load("/project")
        runCurrent()
        controller.toggle(fixed, "/project")
        runCurrent()

        assertTrue(api.toggled.isEmpty())
    }

    @Test
    fun `install uses the selected scope and reports the package`() = runTest(UnconfinedTestDispatcher()) {
        val api = FakeSkillsApi(skills = listOf(skill("global", "/skills/global/shared/SKILL.md")))
        val controller = SkillsController(api, this)

        controller.load("/project")
        runCurrent()
        controller.setInstallScope("project")
        controller.install("skills.sh/vercel-labs/skills@find-skills", "/project")
        runCurrent()

        assertEquals(listOf("skills.sh/vercel-labs/skills@find-skills" to "project"), api.installed)
        assertTrue(controller.state.value.installed.contains("skills.sh/vercel-labs/skills@find-skills"))
        assertEquals("Installed skills.sh/vercel-labs/skills@find-skills", controller.state.value.notice)

        // Without a workspace a project install is refused instead of hitting the server.
        val controller2 = SkillsController(api, this)
        controller2.load("/project")
        runCurrent()
        controller2.setInstallScope("project")
        controller2.install("pkg", null)
        runCurrent()

        assertEquals(1, api.installed.size)
        assertTrue(controller2.state.value.noticeError)
        assertEquals("Select a workspace to install project skills", controller2.state.value.notice)
    }

    @Test
    fun `search lists skills-sh results for the query`() = runTest(UnconfinedTestDispatcher()) {
        val results = listOf(
            SkillSearchResult(
                packageName = "skills.sh/vercel-labs/skills@find-skills",
                installs = "12",
                url = "https://skills.sh/vercel-labs/skills/find-skills",
            ),
        )
        val api = FakeSkillsApi(skills = emptyList(), results = results)
        val controller = SkillsController(api, this)

        controller.openAdd()
        controller.setSearchQuery("  find  ")
        controller.search()
        runCurrent()

        assertEquals(listOf("find"), api.searched)
        assertEquals(results, controller.state.value.results)
        assertFalse(controller.state.value.searching)
    }

    @Test
    fun `checkAll keeps same-package installs of different scopes apart`() = runTest(UnconfinedTestDispatcher()) {
        val globalPath = "/skills/global/shared/SKILL.md"
        val projectPath = "/skills/project/shared/SKILL.md"
        val api = FakeSkillsApi(
            skills = listOf(skill("global", globalPath), skill("project", projectPath)),
            updates = listOf(
                update("project", current = "2.0.0", latest = "2.1.0"),
                update("global", current = "1.0.0", latest = "1.1.0"),
            ),
        )
        val controller = SkillsController(api, this)

        controller.load("/project")
        runCurrent()
        controller.checkAll("/project")
        runCurrent()

        val checks = controller.state.value.checks
        assertEquals("1.0.0", checks[globalPath]?.currentVersion)
        assertEquals("global", checks[globalPath]?.scope)
        assertEquals("2.0.0", checks[projectPath]?.currentVersion)
        assertEquals("project", checks[projectPath]?.scope)
    }
}
