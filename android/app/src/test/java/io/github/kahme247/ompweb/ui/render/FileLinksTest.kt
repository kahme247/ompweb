package io.github.kahme247.ompweb.ui.render

import io.github.kahme247.ompweb.domain.isSafeOpenUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FileLinksTest {

    private val cwd = "/home/me/project"

    @Test
    fun `resolves absolute links and strips line suffixes`() {
        assertEquals(
            "/home/me/project/components/MarkdownBody.tsx",
            resolveLocalFileHref("/home/me/project/components/MarkdownBody.tsx:36", cwd),
        )
        assertEquals(
            LocalFileTarget("/home/me/project/components/MarkdownBody.tsx", 36),
            resolveLocalFileTarget("/home/me/project/components/MarkdownBody.tsx:36", cwd),
        )
    }

    @Test
    fun `resolves absolute links outside cwd`() {
        assertEquals(
            "/home/me/.codex/config.toml",
            resolveLocalFileHref("/home/me/.codex/config.toml:12", cwd),
        )
    }

    @Test
    fun `resolves relative links against cwd`() {
        assertEquals(
            "/home/me/project/components/AppShell.tsx",
            resolveLocalFileHref("components/AppShell.tsx#L42", cwd),
        )
        assertEquals(42, resolveLocalFileTarget("components/AppShell.tsx:42", cwd)?.line)
        assertEquals(
            LocalFileTarget("/home/me/project/components/AppShell.tsx", null),
            resolveLocalFileTarget("components/AppShell.tsx#L42", cwd),
        )
    }

    @Test
    fun `does not let relative links escape cwd`() {
        assertNull(resolveLocalFileHref("../outside.md", cwd))
        assertNull(resolveLocalFileTarget("../../etc/passwd", cwd))
    }

    @Test
    fun `resolves preview links within the project root`() {
        assertEquals(
            "/home/me/project/docs/file.js",
            resolveLocalFileHref("../file.js", "/home/me/project/docs/nested", cwd),
        )
        assertNull(
            resolveLocalFileHref("../../../outside.js", "/home/me/project/docs/nested", cwd),
        )
    }

    @Test
    fun `external and app urls are not file links`() {
        assertNull(resolveLocalFileHref("/api/files/home/me/project/a.ts", cwd))
        assertNull(resolveLocalFileHref("https://example.com/a.ts", cwd))
        assertNull(resolveLocalFileHref("ftp://example.com/a.ts", cwd))
        assertNull(resolveLocalFileHref("//example.com/a.ts", cwd))
        assertTrue(classifyLink("https://example.com/a.ts", cwd) is LinkTarget.External)
        assertTrue(classifyLink("mailto:me@example.com", cwd) is LinkTarget.External)
    }

    @Test
    fun `resolves windows file urls without a synthetic leading slash`() {
        assertEquals(
            "C:/Users/me/project/file.txt",
            resolveLocalFileHref("file:///C:/Users/me/project/file.txt:10", "C:/Users/me/project"),
        )
    }

    @Test
    fun `resolves unc file urls and backslash unc paths`() {
        assertEquals(
            "//server/share/project/file.txt",
            resolveLocalFileHref("file://server/share/project/file.txt", cwd),
        )
        assertEquals(
            "//server/share/project/file.txt",
            resolveLocalFileHref("\\\\server\\share\\project\\file.txt", cwd),
        )
    }

    @Test
    fun `keeps home paths expandable and never escapes home`() {
        assertEquals("~/shots/a.png", resolveLocalFileHref("~/shots/a.png:3", cwd))
        assertNull(resolveLocalFileHref("~/../other/a.png", cwd))
    }

    @Test
    fun `inline code paths are conservative`() {
        assertTrue(isInlineCodeFilePath("/home/me/project/a.ts"))
        assertTrue(isInlineCodeFilePath("src/main/Main.kt:12"))
        assertTrue(isInlineCodeFilePath("~/shots/a.png"))
        assertTrue(isInlineCodeFilePath("C:\\Users\\me\\a.txt"))
        assertFalse(isInlineCodeFilePath("agent://Scout"))
        assertFalse(isInlineCodeFilePath("npm test"))
        assertFalse(isInlineCodeFilePath("a/b"))
    }

    @Test
    fun `classifies agent file github and external targets`() {
        assertEquals(LinkTarget.Agent("agent://Scout"), classifyLink("agent://Scout", cwd))
        assertEquals(
            LinkTarget.File("/home/me/project/a.ts", 4),
            classifyLink("a.ts:4", cwd),
        )
        assertEquals(
            LinkTarget.GithubIssue("o", "r", 12),
            classifyLink("https://github.com/o/r/pull/12", cwd),
        )
        assertEquals(
            LinkTarget.External("https://example.com"),
            classifyLink("https://example.com", cwd),
        )
    }

    @Test
    fun `only browser and mail schemes become external targets`() {
        assertTrue(classifyLink("http://example.com", cwd) is LinkTarget.External)
        assertTrue(classifyLink("HTTPS://example.com", cwd) is LinkTarget.External)
        assertTrue(classifyLink("mailto:me@example.com", cwd) is LinkTarget.External)

        assertEquals(LinkTarget.Inert, classifyLink("javascript:alert(1)", cwd))
        assertEquals(LinkTarget.Inert, classifyLink("intent://scan/#Intent;scheme=zxing;end", cwd))
        assertEquals(LinkTarget.Inert, classifyLink("content://media/external/images/1", cwd))
        assertEquals(LinkTarget.Inert, classifyLink("tel:+123", cwd))
        assertEquals(LinkTarget.Inert, classifyLink("#section", cwd))
        assertEquals(LinkTarget.Inert, classifyLink("//example.com/a.png", cwd))
        assertEquals(LinkTarget.Inert, classifyLink("", cwd))
    }

    @Test
    fun `external urls are re-checked before the system opens them`() {
        assertTrue(isSafeOpenUrl("https://example.com/a"))
        assertTrue(isSafeOpenUrl("  mailto:me@example.com "))
        assertFalse(isSafeOpenUrl("file:///etc/passwd"))
        assertFalse(isSafeOpenUrl("android-app://com.example"))
        assertFalse(isSafeOpenUrl("/relative/path"))
        assertFalse(isSafeOpenUrl(""))
    }
}
