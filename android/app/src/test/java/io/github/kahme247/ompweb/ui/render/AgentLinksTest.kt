package io.github.kahme247.ompweb.ui.render

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentLinksTest {

    @Test
    fun `prose handles are found but broadcast is never linked`() {
        val text = "Output at agent://Review.Child, then agent://all and xagent://Scout."
        val ranges = findAgentHandles(text)
        assertEquals(1, ranges.size)
        assertEquals("agent://Review.Child", text.substring(ranges[0].first, ranges[0].last + 1))
    }

    @Test
    fun `exact handles are only whole inline code spans`() {
        assertTrue(isExactAgentHandle("agent://Scout"))
        assertTrue(isExactAgentHandle("agent://Parent.Child"))
        assertFalse(isExactAgentHandle("write agent://Scout"))
        assertFalse(isExactAgentHandle("agent://all"))
        assertFalse(isExactAgentHandle("agent://Scout."))
    }

    @Test
    fun `href detection rejects non-subagent urls`() {
        assertTrue(isAgentHref("agent://Scout"))
        assertTrue(isAgentHref("agent://Parent/Child?x=1"))
        assertFalse(isAgentHref("agent:Foo"))
        assertFalse(isAgentHref("https://example.com"))
        assertFalse(isAgentHref(null))
        assertEquals("agent://all", BROADCAST_AGENT_URL)
    }

    @Test
    fun `link ids prefer nested ids then fall back to the base id`() {
        assertEquals(listOf("Parent.Child", "Parent"), agentLinkIds("agent://Parent/Child"))
        assertEquals(listOf("Parent.items.0", "Parent"), agentLinkIds("agent://Parent/items/0?x"))
        assertEquals(listOf("Parent"), agentLinkIds("agent://Parent/a.b"))
        assertEquals(listOf("Parent"), agentLinkIds("agent://Parent?q=.x"))
        assertEquals(emptyList<String>(), agentLinkIds("agent://all"))
        assertEquals(emptyList<String>(), agentLinkIds("https://example.com"))
    }

    @Test
    fun `target excludes broadcast and invalid hrefs`() {
        assertEquals(LinkTarget.Agent("agent://Scout"), agentLinkTarget("agent://Scout"))
        assertNull(agentLinkTarget("agent://all"))
        assertNull(agentLinkTarget("agent:Foo"))
    }
}
