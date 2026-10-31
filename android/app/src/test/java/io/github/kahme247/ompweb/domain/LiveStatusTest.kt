package io.github.kahme247.ompweb.domain

import io.github.kahme247.ompweb.net.ElsewhereSession
import io.github.kahme247.ompweb.net.elsewhereFrom
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Sending into a chat another omp process owns: omp moves the chat to a copy
 * on the first write, so the decision must never be "just send". These are the
 * rules the composer and the chat screen branch on.
 */
class LiveStatusTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun elsewhere(
        source: String = "instance-list",
        kind: String = "omp-web",
        running: Boolean = true,
        active: Boolean = true,
    ) = ElsewhereSession(
        id = "s1",
        kind = kind,
        source = source,
        running = running,
        active = active,
        lastActivityAt = 1_800_000_000_000,
    )

    @Test
    fun `nobody else owns the chat so the send goes through`() {
        assertEquals(ForeignSubmitDecision.Allow, foreignSubmitDecision(null, confirmed = false))
    }

    @Test
    fun `a live instance or process proves the owner and blocks the send`() {
        assertEquals(
            ForeignSubmitDecision.Block,
            foreignSubmitDecision(elsewhere(source = "instance-list"), confirmed = false),
        )
        assertEquals(
            ForeignSubmitDecision.Block,
            foreignSubmitDecision(elsewhere(source = "process", kind = "terminal"), confirmed = false),
        )
    }

    @Test
    fun `a source this app does not know is treated as proven`() {
        assertEquals(
            ForeignSubmitDecision.Block,
            foreignSubmitDecision(elsewhere(source = "future-signal"), confirmed = false),
        )
    }

    @Test
    fun `the transcript signal alone only asks`() {
        assertEquals(
            ForeignSubmitDecision.Confirm,
            foreignSubmitDecision(elsewhere(source = "transcript", running = false), confirmed = false),
        )
    }

    @Test
    fun `a confirmed send is allowed and never remembered`() {
        val owner = elsewhere(source = "instance-list")
        assertEquals(ForeignSubmitDecision.Allow, foreignSubmitDecision(owner, confirmed = true))
        assertEquals(
            "the next send asks again",
            ForeignSubmitDecision.Block,
            foreignSubmitDecision(owner, confirmed = false),
        )
    }

    @Test
    fun `the kind names the owner and unknown kinds stay generic`() {
        assertEquals(ElsewhereKind.OmpWeb, elsewhereKind("omp-web"))
        assertEquals(ElsewhereKind.Terminal, elsewhereKind("terminal"))
        assertEquals(ElsewhereKind.Unknown, elsewhereKind("harness"))
        assertEquals(ElsewhereKind.Unknown, elsewhereKind(null))
    }

    @Test
    fun `the source ranks the evidence and unknown sources are not weak`() {
        assertEquals(ElsewhereSource.InstanceList, elsewhereSource("instance-list"))
        assertEquals(ElsewhereSource.Process, elsewhereSource("process"))
        assertEquals(ElsewhereSource.Transcript, elsewhereSource("transcript"))
        assertEquals(ElsewhereSource.Unknown, elsewhereSource("future-signal"))
    }

    @Test
    fun `a malformed owner report is dropped instead of failing the answer`() {
        assertNull(elsewhereFrom(null))
        assertNull(elsewhereFrom(json.parseToJsonElement("null")))
        assertNull(elsewhereFrom(json.parseToJsonElement("\"terminal\"")))
        assertNull(elsewhereFrom(json.parseToJsonElement("""{"kind":7}""")))
    }

    @Test
    fun `a full owner report decodes`() {
        val parsed = elsewhereFrom(
            json.parseToJsonElement(
                """
                {"id":"s1","kind":"terminal","source":"process",
                 "running":true,"active":true,"lastActivityAt":1800000000000,
                 "unexpected":"ignored"}
                """.trimIndent(),
            ).jsonObject,
        )
        assertEquals(
            ElsewhereSession(
                id = "s1",
                kind = "terminal",
                source = "process",
                running = true,
                active = true,
                lastActivityAt = 1_800_000_000_000,
            ),
            parsed,
        )
    }
}
