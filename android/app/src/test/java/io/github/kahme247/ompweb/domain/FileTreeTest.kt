package io.github.kahme247.ompweb.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The web's `lib/file-paths.ts` / `FileExplorer.tsx` helpers: path forms,
 * tree flattening, git dots and the `@`-mention text the composer receives.
 */
class FileTreeTest {

    @Test
    fun windowsSeparatorsAreNormalizedButPosixPathsAreLeftAlone() {
        assertEquals("C:/a/b", normalizeFilePath("C:\\a\\b"))
        assertEquals("\\\\host\\share\\a", normalizeFilePath("\\\\host\\share\\a").replace('/', '\\'))
        assertEquals("/a/b", normalizeFilePath("/a/b"))
    }

    @Test
    fun absolutePathsAreRecognizedInEveryForm() {
        assertTrue(isAbsoluteFilePath("/srv/app"))
        assertTrue(isAbsoluteFilePath("C:/Users/me"))
        assertTrue(isAbsoluteFilePath("~/notes"))
        assertFalse(isAbsoluteFilePath("src/main.kt"))
        assertFalse(isAbsoluteFilePath("./local.txt"))
    }

    @Test
    fun nameAndDirectorySplitLikeTheWeb() {
        assertEquals("c.txt", fileName("/a/b/c.txt"))
        assertEquals("b", fileName("/a/b/"))
        assertEquals("/a/b", fileDirectory("/a/b/c.txt"))
        assertEquals("/", fileDirectory("/a"))
        assertEquals("", fileDirectory("notes.txt"))
    }

    @Test
    fun joinKeepsExactlyOneSeparator() {
        assertEquals("/a/b", joinFilePath("/a/", "b"))
        assertEquals("/a/b", joinFilePath("/a", "/b"))
        assertEquals("/a/b", joinFilePath("/a", "b"))
        // The filesystem root keeps its slash: the tree would otherwise ask
        // for `["a"]` at the root and `["/a"]` elsewhere.
        assertEquals("/a", joinFilePath("/", "a"))
        assertEquals("/a", joinFilePath("", "/a"))
        assertEquals("C:/a", joinFilePath("C:", "a"))
    }

    @Test
    fun relativePathsFallBackToAbsoluteOutsideTheWorkspace() {
        assertEquals("src/a.kt", relativeFilePath("/repo/src/a.kt", "/repo"))
        assertEquals("/other/a.kt", relativeFilePath("/other/a.kt", "/repo"))
        assertEquals("/repo/src/a.kt", relativeFilePath("/repo/src/a.kt", null))
    }

    @Test
    fun insideDirectoryDoesNotMatchAPrefixOfAnotherName() {
        assertTrue(isInsideDirectory("/repo/src/a.kt", "/repo"))
        assertTrue(isInsideDirectory("/repo", "/repo"))
        assertFalse(isInsideDirectory("/repository/a.kt", "/repo"))
    }

    @Test
    fun aListingIsSortedDirectoriesFirstAndOtherDirectoriesAreKept() {
        val merged = mergeDirectoryListing(
            childrenByPath = mapOf("/repo/other" to listOf(FileEntry("keep.txt", false))),
            directory = "/repo",
            entries = listOf(
                FileEntry("z.txt", false),
                FileEntry("src", true),
                FileEntry("A.txt", false),
            ),
        )
        assertEquals(
            listOf("src", "A.txt", "z.txt"),
            merged.getValue("/repo").map { it.name },
        )
        assertEquals(listOf("keep.txt"), merged.getValue("/repo/other").map { it.name })
    }

    @Test
    fun flattenOnlyWalksExpandedDirectoriesAndMarksEmptyOnes() {
        val rows = flattenFileTree(
            root = "/repo",
            childrenByPath = mapOf(
                "/repo" to listOf(FileEntry("src", true), FileEntry("readme.md", false)),
                "/repo/src" to listOf(FileEntry("empty", true)),
                "/repo/src/empty" to emptyList(),
            ),
            expanded = setOf("/repo/src", "/repo/src/empty"),
        )
        assertEquals(
            listOf("src", "empty", "", "readme.md"),
            rows.map { it.name },
        )
        assertEquals(listOf(0, 1, 2, 0), rows.map { it.depth })
        assertTrue("an expanded directory without entries gets a placeholder row", rows[2].empty)
        assertFalse("a directory is only open when expanded", rows[3].isDir)
    }

    @Test
    fun revealExpandsTheAncestorsOfTheTargetButNotTheTarget() {
        assertEquals(
            listOf("/repo/a", "/repo/a/b"),
            revealAncestors("/repo", "/repo/a/b/c.txt"),
        )
        assertEquals(emptyList<String>(), revealAncestors("/repo", "/repo/top.txt"))
        assertEquals(emptyList<String>(), revealAncestors("/repo", "/elsewhere/a.txt"))
    }

    @Test
    fun changedFilesMarkEveryDirectoryUpToTheWorkspace() {
        assertEquals(
            setOf("/repo", "/repo/src", "/repo/src/ui"),
            changedDirectoryPaths("/repo", listOf("/repo/src/ui/Button.kt")),
        )
        assertEquals(
            setOf("/repo"),
            changedDirectoryPaths("/repo", listOf("/repo/readme.md")),
        )
        assertEquals(
            emptySet<String>(),
            changedDirectoryPaths("/repo", listOf("/elsewhere/a.txt")),
        )
    }

    @Test
    fun searchRowsDropEmptyAndDuplicatePaths() {
        val rows = fileSearchRows(listOf("src/a.kt", "src/a.kt", "", "README.md"))
        assertEquals(listOf("src/a.kt", "README.md"), rows.map { it.path })
        assertEquals(listOf("src", ""), rows.map { it.directory })
        assertEquals(listOf("a.kt", "README.md"), rows.map { it.name })
    }

    @Test
    fun mentionsQuoteSpacesAndMarkDirectories() {
        assertEquals("@src/ ", atMentionText("src", isDir = true))
        assertEquals("@src/a.kt ", atMentionText("src/a.kt", isDir = false))
        assertEquals("@\"src/my file.kt\" ", atMentionText("src/my file.kt", isDir = false))
    }

    @Test
    fun uploadedFilesBecomeOneMentionPerFile() {
        assertEquals(
            "@a.kt @dir/b.txt ",
            atMentionsText(listOf("a.kt", "dir/b.txt")),
        )
    }

    @Test
    fun theViewerMentionCarriesTheOpenedLine() {
        assertEquals("@src/a.kt ", fileMentionText("src/a.kt", null))
        assertEquals("@src/a.kt:7 ", fileMentionText("src/a.kt", 7))
        assertEquals("@\"my file.kt\":3 ", fileMentionText("my file.kt", 3))
    }

    @Test
    fun aLineMentionIsClosedAndSingleOrARange() {
        assertEquals("@a.kt:7 ", fileLineMentionText("a.kt", 7, 7))
        assertEquals("@a.kt:7-9 ", fileLineMentionText("a.kt", 9, 7))
        assertEquals("@\"my file.kt\":1-7 ", fileLineMentionText("my file.kt", 0, 7))
    }
}
