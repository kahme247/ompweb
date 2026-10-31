package io.github.kahme247.ompweb.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Mirrors `ModelsConfig.test.mjs` / the web's OAuth panel rules plus the
 * Android-only loopback handling of `domain/OAuthLogin.kt`.
 */
class OAuthLoginTest {

    @Test
    fun `parses every login frame of the route`() {
        assertEquals(
            OAuthFrame.Auth("https://x.test/auth", "Approve in the browser", "tok"),
            parseOAuthFrame("""{"type":"auth","url":"https://x.test/auth","instructions":"Approve in the browser","token":"tok"}"""),
        )
        assertEquals(
            OAuthFrame.DeviceCode("ABCD-1234", "https://x.test/device", 5, 600),
            parseOAuthFrame("""{"type":"device_code","userCode":"ABCD-1234","verificationUri":"https://x.test/device","intervalSeconds":5,"expiresInSeconds":600}"""),
        )
        assertEquals(
            OAuthFrame.PromptRequest("Paste the code", "code", "tok"),
            parseOAuthFrame("""{"type":"prompt_request","message":"Paste the code","placeholder":"code","token":"tok"}"""),
        )
        assertEquals(
            OAuthFrame.SelectRequest(
                "Pick an account",
                listOf(OAuthSelectOption("1", "Work"), OAuthSelectOption("2", "2")),
                "tok",
            ),
            parseOAuthFrame(
                """{"type":"select_request","message":"Pick an account","token":"tok","options":[{"id":"1","label":"Work"},{"id":"2"}]}""",
            ),
        )
        assertEquals(OAuthFrame.Progress("Waiting"), parseOAuthFrame("""{"type":"progress","message":"Waiting"}"""))
        assertEquals(OAuthFrame.Success, parseOAuthFrame("""{"type":"success"}"""))
        assertEquals(OAuthFrame.Failed("nope"), parseOAuthFrame("""{"type":"error","message":"nope"}"""))
        assertEquals(OAuthFrame.Cancelled, parseOAuthFrame("""{"type":"cancelled"}"""))
    }

    @Test
    fun `drops malformed, unknown and incomplete frames`() {
        assertNull(parseOAuthFrame("not json"))
        assertNull(parseOAuthFrame("[]"))
        assertNull(parseOAuthFrame("""{"type":"mystery"}"""))
        assertNull(parseOAuthFrame("""{"type":"auth","token":"tok"}"""))
        assertNull(parseOAuthFrame("""{"type":"auth","url":"   ","token":"tok"}"""))
        assertNull(parseOAuthFrame("""{"type":"prompt_request","placeholder":"x"}"""))
        assertNull(parseOAuthFrame("""{"type":"device_code","userCode":"A"}"""))
    }

    @Test
    fun `terminal states ignore later frames and success always wins`() {
        val success = OAuthLoginMachine().start()
            .onFrame(OAuthFrame.Success)
            .onFrame(OAuthFrame.Auth("https://x.test", null, "tok"))
            .onFrame(OAuthFrame.Progress("late"))
        assertEquals(OAuthLoginState.Success, success.state)
        assertEquals(OAuthLoginState.Success, success.streamEnded().state)

        val failed = OAuthLoginMachine().start()
            .onFrame(OAuthFrame.Failed("denied"))
            .onFrame(OAuthFrame.PromptRequest("ask", null, "tok"))
        assertEquals(OAuthLoginState.Error("denied"), failed.state)
        assertTrue(failed.streamEnded().state is OAuthLoginState.Error)

        val lost = OAuthLoginMachine().start().streamEnded()
        assertEquals(OAuthLoginState.TransportLost, lost.state)
        assertEquals(OAuthLoginState.TransportLost, lost.onFrame(OAuthFrame.Auth("https://x", null, "t")).state)
    }

    @Test
    fun `answers are only accepted while a frame carries a token`() {
        val idle = OAuthLoginMachine().start()
        assertNull(idle.state.submitToken)
        assertEquals(OAuthLoginState.Connecting, idle.submitting().state)

        val auth = idle.onFrame(OAuthFrame.Auth("https://x.test", null, "tok"))
        assertEquals("tok", auth.state.submitToken)
        val submitting = auth.submitting()
        assertEquals(OAuthLoginState.Submitting, submitting.state)
        assertFalse(submitting.state.isWorking.not())
        assertEquals(OAuthLoginState.Success, submitting.onFrame(OAuthFrame.Success).state)

        assertEquals(OAuthLoginState.Idle, OAuthLoginMachine().start().cancel().state)
        assertEquals(OAuthLoginState.Idle, auth.onFrame(OAuthFrame.Cancelled).state)
    }

    @Test
    fun `submit failure and stream failure surface their messages`() {
        assertEquals(
            OAuthLoginState.Error("expired"),
            OAuthLoginMachine().start().submitFailed("expired").state,
        )
        assertEquals(
            OAuthLoginState.Error("Not allowed"),
            OAuthLoginMachine().start().streamFailed("Not allowed").state,
        )
        // A settled success is not downgraded by a late transport error.
        assertEquals(
            OAuthLoginState.Success,
            OAuthLoginMachine().start().onFrame(OAuthFrame.Success).streamFailed("Not allowed").state,
        )
    }

    @Test
    fun `only real loopback hosts count`() {
        assertTrue(isLoopbackHost("localhost"))
        assertTrue(isLoopbackHost("LOCALHOST"))
        assertTrue(isLoopbackHost("auth.localhost"))
        assertTrue(isLoopbackHost("127.0.0.1"))
        assertTrue(isLoopbackHost("127.1.2.3"))
        assertTrue(isLoopbackHost("0.0.0.0"))
        assertTrue(isLoopbackHost("::1"))
        assertTrue(isLoopbackHost("[::1]"))
        assertTrue(isLoopbackHost("::"))

        assertFalse(isLoopbackHost("127.evil.com"))
        assertFalse(isLoopbackHost("127.0.0.256"))
        assertFalse(isLoopbackHost("128.0.0.1"))
        assertFalse(isLoopbackHost("10.0.0.1"))
        assertFalse(isLoopbackHost("localhost.evil.com"))
        assertFalse(isLoopbackHost(""))
    }

    @Test
    fun `finds the loopback target of an authorization url`() {
        assertEquals(
            LoopbackCallback("127.0.0.1", 1455),
            loopbackCallbackTarget("http://127.0.0.1:1455/auth/callback?code=x"),
        )
        assertEquals(
            LoopbackCallback("localhost", 1455),
            loopbackCallbackTarget("http://localhost:1455/auth/callback?state=y"),
        )
        assertEquals(
            LoopbackCallback("::1", 1455),
            loopbackCallbackTarget("http://[::1]:1455/auth/callback"),
        )
        // The provider will redirect to a callback server on the PC.
        assertEquals(
            LoopbackCallback("127.0.0.1", 1455),
            loopbackCallbackTarget(
                "https://claude.ai/oauth/authorize?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fcallback&state=z",
            ),
        )
        assertNull(loopbackCallbackTarget("https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fexample.com%2Fcb"))
        assertNull(loopbackCallbackTarget("https://example.com/auth"))
        assertNull(loopbackCallbackTarget("not a url"))
    }

    @Test
    fun `the panel asks for a desktop flow only for loopback phases`() {
        val auth = OAuthLoginState.Auth("http://localhost:1455/cb", null, "tok")
        assertEquals(LoopbackCallback("localhost", 1455), auth.loopbackTarget())
        assertNull(OAuthLoginState.Auth("https://x.test/auth", null, "tok").loopbackTarget())
        assertNull(OAuthLoginState.Progress("waiting").loopbackTarget())
    }
}
