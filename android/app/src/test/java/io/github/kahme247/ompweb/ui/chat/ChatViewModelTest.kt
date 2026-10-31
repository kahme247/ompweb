package io.github.kahme247.ompweb.ui.chat

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewModelScope
import io.github.kahme247.ompweb.chat.ChatMessage
import io.github.kahme247.ompweb.chat.NoticeKind
import io.github.kahme247.ompweb.data.SettingsSnapshot
import io.github.kahme247.ompweb.data.TranscriptCache
import io.github.kahme247.ompweb.events.ConnectionState
import io.github.kahme247.ompweb.events.EventChannel
import io.github.kahme247.ompweb.events.EventMux
import io.github.kahme247.ompweb.net.EventPostResult
import io.github.kahme247.ompweb.events.EventStream
import io.github.kahme247.ompweb.events.EventTransport
import io.github.kahme247.ompweb.events.SessionEventSource
import io.github.kahme247.ompweb.net.ApiError
import io.github.kahme247.ompweb.net.BashOutputResult
import io.github.kahme247.ompweb.net.BtwApi
import io.github.kahme247.ompweb.net.ChatApi
import io.github.kahme247.ompweb.net.CwdValidation
import io.github.kahme247.ompweb.net.ElsewhereSession
import io.github.kahme247.ompweb.net.ExtensionApi
import io.github.kahme247.ompweb.net.QueuedMessageRemoval
import io.github.kahme247.ompweb.net.QueueRestore
import io.github.kahme247.ompweb.net.ServerAddress
import io.github.kahme247.ompweb.net.SkillsResponse
import io.github.kahme247.ompweb.domain.ComposerImage
import io.github.kahme247.ompweb.domain.AskAnswer
import io.github.kahme247.ompweb.domain.CLIPBOARD_READ_DENIED
import io.github.kahme247.ompweb.domain.DictationState
import io.github.kahme247.ompweb.domain.ExtensionResponse
import io.github.kahme247.ompweb.domain.chatShowsConnecting
import io.github.kahme247.ompweb.domain.SlashCommandItem
import io.github.kahme247.ompweb.domain.SttAfter
import io.github.kahme247.ompweb.domain.SubmitDuringRunBehavior
import io.github.kahme247.ompweb.testutil.FakeChatSettings
import io.github.kahme247.ompweb.testutil.FakeComposerApi
import io.github.kahme247.ompweb.testutil.FakeOnDeviceStt
import io.github.kahme247.ompweb.testutil.FakeSttApi
import io.github.kahme247.ompweb.testutil.MemoryDictationStore
import io.github.kahme247.ompweb.testutil.FakeFilesApi
import io.github.kahme247.ompweb.testutil.MemoryDrafts
import io.github.kahme247.ompweb.testutil.MemoryTranscriptCache
import io.github.kahme247.ompweb.ui.composer.ComposerStrings
import io.github.kahme247.ompweb.ui.composer.CompletionSound
import io.github.kahme247.ompweb.ui.composer.controls.ComposerControlsViewModel
import io.github.kahme247.ompweb.ui.composer.controls.WordPredictor
import io.github.kahme247.ompweb.ui.composer.dictation.DictationViewModel
import io.github.kahme247.ompweb.ui.hosttools.HostToolsController
import io.github.kahme247.ompweb.ui.panels.btw.BtwViewModel
import io.github.kahme247.ompweb.ui.panels.extension.ExtensionUiController
import io.github.kahme247.ompweb.net.ForkOutcome
import io.github.kahme247.ompweb.net.SessionDetail
import io.github.kahme247.ompweb.net.SubagentCompletion
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * JVM tests for the chat view model's transport seams: prompt settlement,
 * reconciliation after a missed `agent_end`, run fencing for stale frames,
 * send-failure rollback and the fork prefill.
 *
 * The fake API answers history pages and agent state; frames arrive through a
 * fake [SessionEventSource], exactly like the SSE stream. Virtual time drives
 * the settlement and reconcile timers, so no test waits on the clock.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ChatViewModelTest {

    private val dispatcher = StandardTestDispatcher()
    private val api = FakeApi()
    private val events = FakeEvents()
    private val settings = FakeChatSettings()
    private val speech = FakeSpeech()
    private val eventLog = mutableListOf<ChatEvent>()
    private val composerStrings = ComposerStrings(
        shellSessionFailed = SHELL_NO_SESSION,
        liveStateUnknown = LIVE_STATE_UNKNOWN,
        submitAbandoned = SUBMIT_ABANDONED,
        foreignSendBlocked = FOREIGN_BLOCKED,
        foreignCommandBlocked = FOREIGN_COMMAND_BLOCKED,
    )
    private var completionTones = 0
    private val completionSound = CompletionSound { completionTones++ }
    private val extensionApi = FakeExtensionApi()
    private lateinit var vm: ChatViewModel

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
    }

    @After
    fun tearDown() {
        if (::vm.isInitialized) vm.viewModelScope.cancel()
        Dispatchers.resetMain()
    }

    /** Construct the VM and start collecting its one-shot events. */
    private fun TestScope.createViewModel(
        submitDuringRun: SubmitDuringRunBehavior = SubmitDuringRunBehavior.DEFAULT,
        settingsOverride: FakeChatSettings? = null,
        dictationOverride: DictationViewModel? = null,
        transcripts: TranscriptCache? = null,
        sessionEpoch: StateFlow<Int>? = null,
        controlsApi: FakeComposerApi = FakeComposerApi(),
    ) {
        val activeSettings = settingsOverride ?: if (submitDuringRun == SubmitDuringRunBehavior.DEFAULT) {
            settings
        } else {
            FakeChatSettings(SettingsSnapshot(loaded = true, submitDuringRun = submitDuringRun))
        }
        vm = ChatViewModel(
            api = api,
            eventMux = events,
            settings = activeSettings,
            speech = speech,
            savedStateHandle = SavedStateHandle(),
            maybeStartedMessage = MAYBE_STARTED,
            stopUnconfirmedMessage = STOP_UNCONFIRMED,
            drafts = MemoryDrafts(),
            composerStrings = composerStrings,
            controls = ComposerControlsViewModel(controlsApi, activeSettings, backgroundScope),
            dictation = dictationOverride
                ?: DictationViewModel(FakeSttApi(), MemoryDictationStore(), backgroundScope),
            wordPredictor = WordPredictor(FakeComposerApi(), activeSettings, backgroundScope),
            completionSound = completionSound,
            btw = BtwViewModel(
                api = object : BtwApi {
                    override suspend fun send(sessionId: String, command: JsonObject): JsonElement? = null
                },
                scope = backgroundScope,
            ),
            extensionUi = ExtensionUiController(
                api = extensionApi,
                scope = backgroundScope,
            ),
            hostTools = HostToolsController(
                api = object : ExtensionApi {
                    override suspend fun command(sessionId: String, command: JsonObject): JsonElement? = null
                },
                events = EventMux(
                    transport = object : EventTransport {
                        override suspend fun open(): EventStream = kotlinx.coroutines.awaitCancellation()
                        override suspend fun subscribe(
                            connectionId: String,
                            id: String,
                            channel: EventChannel,
                        ): EventPostResult = EventPostResult.Ok
                        override suspend fun unsubscribe(connectionId: String, id: String) = Unit
                    },
                    scope = backgroundScope,
                ),
                settings = activeSettings,
                scope = backgroundScope,
            ),
            files = FakeFilesApi(),
            transcripts = transcripts,
            cacheDispatcher = dispatcher,
            sessionEpoch = sessionEpoch,
        )
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            vm.events.collect { eventLog += it }
        }
    }

    /**
     * `runTest` that cancels the view model before the test finishes. The
     * VM's periodic reconcile loop reschedules itself forever, so the idle
     * drain of `runTest` would never complete while it is alive.
     */
    private fun chatTest(block: TestScope.() -> Unit) = runTest(dispatcher) {
        try {
            block()
        } finally {
            if (::vm.isInitialized) vm.viewModelScope.cancel()
        }
    }

    private fun TestScope.emit(json: String) {
        events.frames.tryEmit(parse(json))
        runCurrent()
    }

    // ------------------------------------------------------------ settlement

    @Test
    fun terminalAgentEndSettlesPromptAndCommitsHistory() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()
        assertTrue(vm.ui.value.engine.historyLoaded)

        vm.send("hello")
        runCurrent()
        assertTrue("the optimistic row is pending", vm.ui.value.busy)
        assertEquals("hello", vm.ui.value.engine.pendingUser?.text)
        assertEquals(listOf("s1" to "hello"), api.prompts)

        api.contextPage = page(
            "s1",
            listOf(USER_HELLO, ASSISTANT_HI),
        )
        emit("""{"type":"agent_start","web":{"streamId":"A","sequence":8}}""")
        emit(
            """{"type":"message_start","message":{"role":"assistant",""" +
                """"content":[{"type":"text","text":"hi"}],"timestamp":1001},""" +
                """"web":{"streamId":"A","sequence":12}}""",
        )
        // The answer is visible, so the terminal end is not treated as empty.
        emit("""{"type":"agent_end","isTerminal":true,"web":{"streamId":"A","sequence":20}}""")

        val state = vm.ui.value.engine
        assertFalse("the terminal agent_end ends the run", vm.ui.value.busy)
        assertNull("history confirmed the optimistic row", state.pendingUser)
        assertNull(state.streaming)
        assertEquals(2, state.messages.size)
        assertEquals("hello", (state.messages[0] as ChatMessage.User).text)
        assertEquals(
            "hi",
            (state.messages[1] as ChatMessage.Assistant).blocks
                .filterIsInstance<io.github.kahme247.ompweb.chat.AssistantBlock.Text>()
                .single().text,
        )
        assertTrue(vm.ui.value.rows.isNotEmpty())
        assertTrue("no error notice for a clean run", vm.ui.value.notices.isEmpty())
    }

    @Test
    fun openingASessionIssuesExactlyOneContextRequest() = chatTest {
        api.contextPage = page("s1", listOf(USER_HELLO, ASSISTANT_HI))
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        assertEquals("one request paints the whole transcript", 1, api.contextFullCalls)
        assertEquals("opening never pages through history windows", 0, api.contextSyncCalls)
        assertEquals(2, vm.ui.value.engine.messages.size)
        assertTrue(vm.ui.value.engine.historyLoaded)
    }

    // --------------------------------------------------------- cache-first

    private val origin = ServerAddress("http", "omp.local", 30177)

    private fun originSettings() = FakeChatSettings(SettingsSnapshot(loaded = true, origin = origin))

    private fun cachedBody(): String = page("s1", listOf(USER_HELLO, ASSISTANT_HI, USER_HELLO)).toString()

    @Test
    fun cachedTranscriptPaintsBeforeTheServerAnswerAndIsReplacedByIt() = chatTest {
        val cache = MemoryTranscriptCache()
        cache.write(origin.origin, "s1", null, false, cachedBody())
        api.contextPage = page("s1", listOf(USER_HELLO))
        api.contextGate = CompletableDeferred()
        createViewModel(settingsOverride = originSettings(), transcripts = cache)

        vm.open("s1", null)
        runCurrent()

        assertEquals("the cached transcript is on screen while the request runs", 3, vm.ui.value.engine.messages.size)
        assertTrue("the cached view says it is updating", vm.ui.value.engine.historyStale)
        assertFalse("the cache is not a completed load", vm.ui.value.engine.historyLoaded)
        assertTrue(vm.ui.value.rows.isNotEmpty())

        api.contextGate?.complete(Unit)
        runCurrent()

        val state = vm.ui.value.engine
        assertEquals("the server answer replaces the disk copy", 1, state.messages.size)
        assertFalse(state.historyStale)
        assertTrue(state.historyLoaded)
        assertEquals("the pre-filled entry plus the fresh write", 2, cache.writes.size)
        assertEquals("the fresh answer is written back", "s1", cache.writes.last().sessionId)
    }

    @Test
    fun aCachedTranscriptReportsConnectingUntilTheLiveStateArrives() = chatTest {
        val cache = MemoryTranscriptCache()
        cache.write(origin.origin, "s1", null, false, cachedBody())
        api.contextPage = page("s1", listOf(USER_HELLO))
        api.contextGate = CompletableDeferred()
        // The live-state read cannot answer (offline): the cached rows stay on
        // screen and nothing may claim the agent is idle.
        api.agentStateFailure = ApiError.Network(java.io.IOException("offline"))
        createViewModel(settingsOverride = originSettings(), transcripts = cache)

        vm.open("s1", null)
        runCurrent()

        val state = vm.ui.value.engine
        assertTrue("the cached transcript is on screen", state.historyStale)
        assertFalse("no live word from the server yet", state.liveStateKnown)
        assertTrue(
            "the footer says Connecting… instead of looking idle",
            chatShowsConnecting(state.liveStateKnown, state.historyStale || state.messages.isNotEmpty()),
        )
    }

    @Test
    fun openingASessionAsksForTheLiveStateAndSettlesIt() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        assertTrue("opening reads GET /api/agent", api.agentStateCalls >= 1)
        assertTrue("an idle answer settles the live state", vm.ui.value.engine.liveStateKnown)
        assertFalse(
            "the Connecting… hint is gone once the state is known",
            chatShowsConnecting(vm.ui.value.engine.liveStateKnown, hasTranscript = true),
        )
    }

    // ------------------------------------------------------- extension UI

    /**
     * The reported bug: the user left the chat for the list, the agent asked
     * there, and opening the chat again (the list row, or the notification the
     * ask produced) showed the running ask tool with no question panel. The
     * hidden chat's subscription never stopped, so that dialog was the only
     * copy the client had — and the re-bind used to throw it away.
     */
    @Test
    fun anAskThatArrivesWhileTheChatIsHiddenIsShownWhenTheChatComesBack() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        // Back to the list: the surface is gone, the subscription is not.
        vm.onChatHidden()
        emit(ASK_FRAME)
        assertNotNull(
            "the hidden chat's stream keeps delivering the request",
            vm.extensionUi.dialog.value,
        )

        // The list row or the notification tap re-opens the same chat.
        vm.open("s1", null)
        runCurrent()

        assertEquals("the pending ask is on screen again", "ask-1", vm.extensionUi.dialog.value?.id)
        vm.extensionUi.respond(
            ExtensionResponse.Answers("ask-1", listOf(AskAnswer("color", listOf("Green"), null))),
        )
        runCurrent()
        val (answeredSession, command) = extensionApi.commands.single()
        assertEquals("the answer goes to the session that asked", "s1", answeredSession)
        assertEquals("extension_ui_response", command["type"]?.jsonPrimitive?.content)
        assertEquals("ask-1", command["id"]?.jsonPrimitive?.content)
    }

    @Test
    fun aPendingAskReplayedOnTheFreshSubscriptionIsShown() = chatTest {
        createViewModel()
        // Issued while no chat was open: the server keeps it until a listener
        // attaches (notification tap, cold start, the session list).
        events.pending += parse(ASK_FRAME)
        vm.open("s1", null)
        runCurrent()
        assertEquals("ask-1", vm.extensionUi.dialog.value?.id)
    }

    @Test
    fun aHostUriThatArrivesWhileTheChatIsHiddenIsStillAnswered() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        // The user is back on the list; the session stream keeps running.
        vm.onChatHidden()
        emit(HOST_READ_FRAME)
        runCurrent()

        // omp waits for the result: the answer goes to the session that asked
        // even though nothing renders the clipboard consent.
        val (answeredSession, command) = extensionApi.commands.single()
        assertEquals("s1", answeredSession)
        assertEquals("host_uri_result", command["type"]?.jsonPrimitive?.content)
        assertEquals("clip-1", command["id"]?.jsonPrimitive?.content)
        assertEquals(CLIPBOARD_READ_DENIED, command["error"]?.jsonPrimitive?.content)
        assertNull(vm.extensionUi.clipboardPrompt.value)
    }

    @Test
    fun anOpenUrlThatArrivesWhileTheChatIsHiddenWaitsForTheChat() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        vm.onChatHidden()
        emit(OPEN_URL_FRAME)
        assertNotNull("kept, never opened on its own", vm.extensionUi.openUrlPrompt.value)

        vm.open("s1", null)
        runCurrent()
        assertEquals(
            "the notice is on screen again with the chat",
            "https://example.com/page",
            vm.extensionUi.openUrlPrompt.value?.url,
        )
    }

    /**
     * R5: the sign-out/server-switch path must leave no panel behind — the
     * panels belong to the dropped installation, not to the next sign-in.
     */
    @Test
    fun droppingTheSignedInUserDropsTheExtensionPanels() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()
        emit(ASK_FRAME)
        assertNotNull(vm.extensionUi.dialog.value)

        vm.clearSessionData()
        runCurrent()

        assertNull("no panel of the dropped user survives", vm.extensionUi.dialog.value)
        assertTrue(vm.extensionUi.statusItems.value.isEmpty())
        assertTrue(vm.extensionUi.widgets.value.isEmpty())
        assertNull(vm.extensionUi.terminal.value)
        assertNull(vm.extensionUi.openUrlPrompt.value)
    }

    /**
     * R4: the panel controller is app-scoped while this view model is not. An
     * activity that dies with the process alive must not leave a panel that
     * comes back with the next chat and can only be answered into the void.
     */
    @Test
    fun clearingTheChatViewModelDropsTheExtensionPanels() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()
        vm.onChatHidden()
        emit(ASK_FRAME)
        assertNotNull("the hidden chat's stream delivers it", vm.extensionUi.dialog.value)

        // The activity goes away: the ViewModelStore calls onCleared, exactly
        // like it does when the surface is destroyed for good.
        ViewModelStore().apply { put("chat", vm) }.clear()

        assertNull("a cleared chat leaves no panel behind", vm.extensionUi.dialog.value)
    }

    @Test
    fun aFailedRefreshKeepsTheCachedTranscriptVisible() = chatTest {
        val cache = MemoryTranscriptCache()
        cache.write(origin.origin, "s1", null, false, cachedBody())
        api.contextFullFailure = ApiError.Network(java.io.IOException("offline"))
        createViewModel(settingsOverride = originSettings(), transcripts = cache)

        vm.open("s1", null)
        runCurrent()

        val state = vm.ui.value.engine
        assertEquals("cached rows survive the failed refresh", 3, state.messages.size)
        assertFalse(state.historyStale)
        assertTrue("the cached rows count as loaded", state.historyLoaded)
        assertNotNull("the failure offers a retry", state.historyError)
    }

    @Test
    fun aCachedTranscriptOfAnotherLeafIsNotPainted() = chatTest {
        val cache = MemoryTranscriptCache()
        cache.write(origin.origin, "s1", "other-leaf", false, cachedBody())
        api.contextPage = page("s1", listOf(USER_HELLO))
        createViewModel(settingsOverride = originSettings(), transcripts = cache)

        vm.open("s1", null)
        runCurrent()

        assertEquals("a branch's transcript never seeds another view", 1, vm.ui.value.engine.messages.size)
        assertFalse(vm.ui.value.engine.historyStale)
    }

    @Test
    fun aCachedTranscriptIsNotPaintedWithoutAConfiguredOrigin() = chatTest {
        val cache = MemoryTranscriptCache()
        cache.write(origin.origin, "s1", null, false, cachedBody())
        api.contextPage = page("s1", listOf(USER_HELLO))
        createViewModel(transcripts = cache)

        vm.open("s1", null)
        runCurrent()

        assertEquals(1, vm.ui.value.engine.messages.size)
        assertFalse("no origin means no cache read", vm.ui.value.engine.historyStale)
    }

    @Test
    fun aTranscriptAnsweredForAnotherServerIsNeverCached() = chatTest {
        val cache = MemoryTranscriptCache()
        val first = ServerAddress("http", "first.example", 30177)
        val second = ServerAddress("http", "second.example", 30177)
        val originSettings = FakeChatSettings(SettingsSnapshot(loaded = true, origin = first))
        api.contextPage = page("s1", listOf(USER_HELLO, ASSISTANT_HI))
        api.contextGate = CompletableDeferred()
        createViewModel(settingsOverride = originSettings, transcripts = cache)

        vm.open("s1", null)
        runCurrent()
        assertEquals("the request is on the wire", 1, api.contextFullCalls)

        // The server changes while the body is still travelling. The container
        // clears the cache for the old origin; the late answer must neither be
        // filed under the new origin nor undo the wipe.
        api.contextGate?.complete(Unit)
        originSettings.setOrigin(second)
        runCurrent()

        assertTrue("another installation's transcript is never stored", cache.writes.isEmpty())
        assertTrue(
            "a late answer never paints the next server's chat",
            vm.ui.value.engine.messages.isEmpty(),
        )
    }

    @Test
    fun clearingTheSignedInUserDropsTheTranscriptFromTheHeap() = chatTest {
        val epoch = MutableStateFlow(0)
        api.contextPage = page("s1", listOf(USER_HELLO, ASSISTANT_HI))
        createViewModel(settingsOverride = originSettings(), sessionEpoch = epoch)

        vm.open("s1", null)
        runCurrent()
        assertEquals(2, vm.ui.value.engine.messages.size)
        assertTrue(vm.ui.value.rows.isNotEmpty())

        // Sign-out, a server switch and a 401 all wipe the disk cache and bump
        // the epoch; the transcript must not survive in the heap either.
        epoch.value = 1
        runCurrent()

        assertTrue("the engine's messages are gone", vm.ui.value.engine.messages.isEmpty())
        assertTrue("no rendered row survives", vm.ui.value.rows.isEmpty())
        assertNull("the chat holds no session", vm.ui.value.sessionId)
    }

    @Test
    fun theSystemPromptSheetLoadsTheComposedPrompt() = chatTest {
        api.agentState = parse("""{"state":{"systemPrompt":"You are omp"}}""")
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        vm.openSystemPrompt()
        runCurrent()

        assertEquals(SystemPromptState.Loaded("You are omp"), vm.ui.value.systemPrompt)
    }

    @Test
    fun switchingSessionsDropsAnInFlightSystemPromptLoad() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        // The get_state answer for s1 is still pending when the screen moves
        // to s2; it must neither overwrite nor re-open the sheet.
        val s1Answer = CompletableDeferred<JsonObject>()
        api.agentStateGate = s1Answer
        vm.openSystemPrompt()
        runCurrent()
        assertEquals(SystemPromptState.Loading, vm.ui.value.systemPrompt)

        vm.open("s2", null)
        runCurrent()
        assertEquals("the new session starts with a closed sheet", SystemPromptState.Idle, vm.ui.value.systemPrompt)

        s1Answer.complete(parse("""{"state":{"systemPrompt":"You are omp (s1)"}}"""))
        runCurrent()

        assertEquals(
            "the late answer of the previous session never surfaces",
            SystemPromptState.Idle,
            vm.ui.value.systemPrompt,
        )
    }

    @Test
    fun freshLiveSessionWithoutTranscriptOpensEmptyInsteadOfFailing() = chatTest {
        api.contextFullFailure = ApiError.Http(404, """{"error":"Session not found","code":"session_not_found"}""")
        api.agentState = parse("""{"running":true,"state":{"isStreaming":false,"isPromptRunning":false}}""")
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        val engine = vm.ui.value.engine
        assertTrue("a live session without a file is an empty transcript", engine.historyLoaded)
        assertNull("a missing file is not a load error", engine.historyError)
        assertTrue(engine.messages.isEmpty())
        assertEquals(1, api.contextFullCalls)
    }

    @Test
    fun missingTranscriptForADeadSessionKeepsTheLoadError() = chatTest {
        api.contextFullFailure = ApiError.Http(404, """{"error":"Session not found","code":"session_not_found"}""")
        api.agentState = parse("""{"running":false}""")
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        val engine = vm.ui.value.engine
        assertFalse(engine.historyLoaded)
        assertEquals("HTTP 404", engine.historyError)
    }

    @Test
    fun promptResultWithoutAgentInvocationSettlesPrompt() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        vm.send("hello")
        runCurrent()
        assertTrue(vm.ui.value.busy)

        emit("""{"type":"agent_start","web":{"streamId":"A","sequence":8}}""")
        emit("""{"type":"prompt_result","agentInvoked":false,"web":{"streamId":"A","sequence":9}}""")

        assertFalse(vm.ui.value.busy)
    }

    @Test
    fun reconcileTreatsSessionSlowAsStillRunningAndRetriesLater() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        vm.send("hello")
        runCurrent()
        assertTrue(vm.ui.value.busy)

        // omp blocks its event loop for tens of seconds on a large session, so
        // the state poll answers 503 session_slow — busy, not ended.
        api.agentStateFailure = ApiError.SessionSlow(
            "omp is busy and did not answer in time; the session keeps running.",
        )
        val callsBefore = api.agentStateCalls
        advanceTimeBy(801)
        runCurrent()

        assertTrue("session_slow polled GET /api/agent", api.agentStateCalls > callsBefore)
        assertTrue("a slow poll must not end the run", vm.ui.value.busy)
        assertTrue("a slow background poll shows no error", vm.ui.value.notices.isEmpty())
        assertNull(vm.ui.value.engine.error)

        // The next *periodic* poll answers: the run settles normally. The
        // post-send settlement loop deliberately stopped on the slow read (a
        // blocked child is alive, not a missed start, and polling it every
        // 600 ms buys nothing) — the 15 s reconcile poll is what retries.
        api.agentStateFailure = null
        api.contextPage = page("s1", listOf(USER_HELLO))
        advanceTimeBy(RECONCILE_MILLIS + 1)
        runCurrent()

        assertFalse("the run ends once omp answers again", vm.ui.value.busy)
        assertNull(vm.ui.value.engine.pendingUser)
        assertTrue(vm.ui.value.notices.isEmpty())
    }

    @Test
    fun reconcileAdoptsAgentStateWhenAgentEndWasMissed() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        vm.send("hello")
        runCurrent()
        assertTrue(vm.ui.value.busy)
        // The run frame was lost: no agent_end ever arrives.
        val callsBeforeSettlement = api.agentStateCalls
        api.contextPage = page("s1", listOf(USER_HELLO))

        advanceTimeBy(801)
        runCurrent()

        assertTrue("settlement polled GET /api/agent", api.agentStateCalls > callsBeforeSettlement)
        assertFalse("the idle agent state ends the run", vm.ui.value.busy)
        assertNull(vm.ui.value.engine.pendingUser)
        assertNull(vm.ui.value.engine.error)
        assertEquals(1, vm.ui.value.engine.messages.size)
    }

    @Test
    fun aFailedLiveStateReadIsRetriedUntilTheServerAnswers() = chatTest {
        createViewModel()
        api.agentStateFailure = ApiError.Network(java.io.IOException("offline"))
        vm.open("s1", null)
        runCurrent()
        assertFalse("no answer settled the live state", vm.ui.value.engine.liveStateKnown)
        val callsAfterOpen = api.agentStateCalls

        // An unknown live state has no stream to correct it; the periodic loop
        // must ask again even though nothing is busy.
        advanceTimeBy(3_001)
        runCurrent()
        assertTrue("the unknown live state is asked again", api.agentStateCalls > callsAfterOpen)
        assertFalse("this retry failed as well", vm.ui.value.engine.liveStateKnown)

        api.agentStateFailure = null
        advanceTimeBy(6_001)
        runCurrent()
        assertTrue("a late answer still settles the live state", vm.ui.value.engine.liveStateKnown)
        assertFalse(
            "the footer stops saying Connecting…",
            chatShowsConnecting(vm.ui.value.engine.liveStateKnown, hasTranscript = true),
        )
    }

    /**
     * Opening a chat whose omp child is blocked by a large session answers 503
     * `session_slow` for the state read (web `loadSession`'s bug): the disk
     * transcript must stay, the session must read as running instead of
     * "Connecting…", and no error may be painted. The next poll settles it.
     *
     * Opening fires several state reads at once (the open itself, the
     * connection becoming live, the first history page). They are one
     * observation of the same answer, so they must not advance the bounded
     * "unknown" window — otherwise the burst would exhaust it before the first
     * timer tick and the chat would settle while the run it showed is real.
     */
    @Test
    fun openingASlowSessionKeepsTheTranscriptAndShowsItRunning() = chatTest {
        api.contextPage = page("s1", listOf(USER_HELLO, ASSISTANT_HI))
        api.agentStateFailure = ApiError.SessionSlow(
            "omp is busy and did not answer in time; the session keeps running.",
        )
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        val state = vm.ui.value.engine
        assertEquals("the transcript on disk is kept", 2, state.messages.size)
        assertTrue("the history load completed", state.historyLoaded)
        assertNull("a busy child is not a failed load", state.error)
        assertTrue("a busy child paints no error notice", vm.ui.value.notices.isEmpty())
        assertTrue("the live run stays marked (state unknown, not ended)", state.busy)
        assertTrue("the live state is settled enough to show it", state.liveStateKnown)
        assertFalse(
            "the footer no longer claims Connecting… over a running turn",
            chatShowsConnecting(state.liveStateKnown, hasTranscript = true),
        )

        // omp drains its event loop: the periodic poll settles the run silently.
        api.agentStateFailure = null
        advanceTimeBy(15_001)
        runCurrent()
        assertFalse("the poll settles the run once omp answers", vm.ui.value.engine.busy)
        assertTrue(vm.ui.value.engine.liveStateKnown)
        assertTrue("settling a slow session is not an error", vm.ui.value.notices.isEmpty())
        assertNull(vm.ui.value.engine.error)
    }

    @Test
    fun aSlowAnswerThatReportsNoRunSettlesTheTurn() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        vm.send("hello")
        runCurrent()
        assertTrue(vm.ui.value.busy)

        // The fresh-spawn case from the report: omp is alive but still loading a
        // large session, so `get_state` answers too late while nothing runs.
        // `running:false` is the server's run registry saying "no turn", so the
        // run the screen shows must not stay "working".
        api.agentStateFailure = ApiError.SessionSlow(
            "omp is busy and did not answer in time; the session keeps running.",
            running = false,
        )
        api.contextPage = page("s1", listOf(USER_HELLO))
        advanceTimeBy(801)
        runCurrent()

        assertFalse("no run in flight ends the run", vm.ui.value.busy)
        assertNull("an idle child is not a failure", vm.ui.value.engine.error)
        assertTrue("settling an idle child paints no error", vm.ui.value.notices.isEmpty())
    }

    @Test
    fun aSlowAnswerThatReportsARunKeepsItMarked() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        vm.send("hello")
        runCurrent()
        assertTrue(vm.ui.value.busy)

        // A blocked child that DOES own a turn: the answer is authoritative the
        // other way round, so the run keeps its state until it ends by a frame.
        api.agentStateFailure = ApiError.SessionSlow(
            "omp is busy and did not answer in time; the session keeps running.",
            running = true,
        )
        advanceTimeBy(801)
        runCurrent()

        assertTrue("a run the server still reports stays marked", vm.ui.value.busy)
        assertEquals("the registry is never consulted when the answer reports it", 0, api.runningIdsCalls)
    }

    @Test
    fun anUnknownSlowAnswerIsBoundedByTheRunningList() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        vm.send("hello")
        runCurrent()
        assertTrue(vm.ui.value.busy)

        // An older server answers without the run state, so "unknown" is all the
        // client gets; the registry says nothing runs.
        api.agentStateFailure = ApiError.SessionSlow(
            "omp is busy and did not answer in time; the session keeps running.",
        )
        api.contextPage = page("s1", listOf(USER_HELLO))
        api.runningIds = emptyList()

        advanceTimeBy(801)
        runCurrent()
        assertTrue("under the bound the run stays marked", vm.ui.value.busy)
        assertEquals("the settlement read is not a poll", 0, api.runningIdsCalls)

        // Three *periodic* polls reach the bound. The one-shot settlement read
        // right after the send does not count, or "three consecutive polls"
        // would be two real polls (web `waitForPromptSettlement` counts none).
        repeat(2) {
            advanceTimeBy(RECONCILE_MILLIS + 1)
            runCurrent()
        }
        assertTrue("two polls are still under the bound", vm.ui.value.busy)
        assertEquals("the registry is not consulted before the bound", 0, api.runningIdsCalls)

        advanceTimeBy(RECONCILE_MILLIS + 1)
        runCurrent()

        assertEquals("the registry answers at the bound", 1, api.runningIdsCalls)
        assertFalse("a session the registry does not run is not kept as working", vm.ui.value.busy)
    }

    @Test
    fun theSlowAnswerBoundKeepsARunTheRunningListStillNames() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        vm.send("hello")
        runCurrent()
        assertTrue(vm.ui.value.busy)

        api.agentStateFailure = ApiError.SessionSlow(
            "omp is busy and did not answer in time; the session keeps running.",
        )
        api.runningIds = listOf("s1")

        advanceTimeBy(801)
        runCurrent()
        // The settlement read is not a poll; three periodic polls reach the bound.
        repeat(3) {
            advanceTimeBy(RECONCILE_MILLIS + 1)
            runCurrent()
        }

        assertEquals("the registry answered", 1, api.runningIdsCalls)
        assertTrue("a run the registry still reports keeps its working state", vm.ui.value.busy)

        // The window restarted when the registry kept the run (web clears its
        // counter before deciding): the next poll alone must not re-ask, a fresh
        // three do.
        advanceTimeBy(RECONCILE_MILLIS + 1)
        runCurrent()
        assertEquals("a restarted window does not query on every poll", 1, api.runningIdsCalls)
        repeat(2) {
            advanceTimeBy(RECONCILE_MILLIS + 1)
            runCurrent()
        }
        assertEquals("the next window reaches the registry again", 2, api.runningIdsCalls)
        assertTrue("the run the registry names stays marked", vm.ui.value.busy)
    }

    @Test
    fun aHungLiveStateReadForTheOldSessionDoesNotSwallowTheNewSessionsRead() = chatTest {
        createViewModel()
        val oldRead = CompletableDeferred<JsonObject>()
        api.agentStateGates["s1"] = oldRead
        vm.open("s1", null)
        runCurrent()
        assertFalse("s1's answer is still on the wire", vm.ui.value.engine.liveStateKnown)

        vm.open("s2", null)
        runCurrent()
        assertTrue("the new session asked for its own state", api.agentStateSessions.contains("s2"))
        assertTrue("its answer settles the new session", vm.ui.value.engine.liveStateKnown)

        oldRead.complete(parse("""{"running":true,"state":{"isPromptRunning":true}}"""))
        runCurrent()
        assertFalse("the late s1 snapshot is discarded, not applied to s2", vm.ui.value.busy)
        assertTrue(vm.ui.value.engine.liveStateKnown)
    }

    // ------------------------------------------------------------ run fencing

    @Test
    fun staleAgentStateOfThePreviousRunCannotEndTheNextOne() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        // The reconcile answer is held until after the second prompt starts.
        val gate = CompletableDeferred<JsonObject>()
        api.agentStateGate = gate

        vm.send("first")
        runCurrent()
        assertEquals(1L, vm.ui.value.engine.runId)

        vm.onForeground()
        runCurrent()

        emit("""{"type":"agent_end","isTerminal":true}""")
        assertFalse("the first run ended", vm.ui.value.busy)

        vm.send("second")
        runCurrent()
        assertEquals(2L, vm.ui.value.engine.runId)
        assertTrue("the second run is pending", vm.ui.value.busy)

        gate.complete(parse("""{"running":false,"state":{"isStreaming":false,"isPromptRunning":false}}"""))
        runCurrent()

        assertTrue("the stale snapshot must not end run 2", vm.ui.value.busy)
        assertEquals(2L, vm.ui.value.engine.runId)
    }

    @Test
    fun aSnapshotRequestedBeforeTheRunEndedCannotResurrectIt() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()
        vm.send("hello")
        runCurrent()
        assertTrue("the run is live", vm.ui.value.busy)

        // The GET freezes `isPromptRunning`/`isStreaming` while the run is
        // live and answers only after it has ended. The run id stays the same.
        val gate = CompletableDeferred<JsonObject>()
        api.agentStateGate = gate
        vm.onForeground()
        runCurrent()

        emit("""{"type":"agent_end","isTerminal":true}""")
        assertFalse("the run ended meanwhile", vm.ui.value.busy)

        api.agentStateGate = null
        gate.complete(parse("""{"running":true,"state":{"isStreaming":true,"isPromptRunning":true}}"""))
        runCurrent()

        val state = vm.ui.value.engine
        assertFalse("the same-run snapshot must not revive the finished run", state.busy)
        assertFalse(state.promptRunning)
        assertFalse(state.streamingActive)
    }

    @Test
    fun staleFramesOfOldRunAreIgnoredAfterNewPrompt() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        // First run, fully sequenced.
        vm.send("first")
        runCurrent()
        emit("""{"type":"agent_start","web":{"streamId":"A","sequence":8}}""")
        emit(
            """{"type":"message_start","message":{"role":"assistant",""" +
                """"content":[{"type":"text","text":"first answer"}],"timestamp":1001},""" +
                """"web":{"streamId":"A","sequence":12}}""",
        )
        emit(
            """{"type":"message_end","message":{"role":"assistant",""" +
                """"content":[{"type":"text","text":"first answer"}],"timestamp":1001,""" +
                """"stopReason":"stop"},"web":{"streamId":"A","sequence":16}}""",
        )
        api.contextPage = page("s1", listOf(USER_FIRST, ASSISTANT_FIRST))
        emit("""{"type":"agent_end","isTerminal":true,"web":{"streamId":"A","sequence":20}}""")
        assertFalse(vm.ui.value.busy)

        // A second prompt starts run 2.
        vm.send("second")
        runCurrent()
        assertTrue(vm.ui.value.busy)
        assertEquals(2L, vm.ui.value.engine.runId)

        // Late frames from the finished run: below the stream's last sequence.
        emit(
            """{"type":"message_update","message":{"role":"assistant",""" +
                """"content":[{"type":"text","text":"old answer"}],"timestamp":1002},""" +
                """"web":{"streamId":"A","sequence":14}}""",
        )
        emit("""{"type":"agent_end","isTerminal":true,"web":{"streamId":"A","sequence":19}}""")

        assertTrue("the stale agent_end must not end run 2", vm.ui.value.busy)
        assertNull("the stale message must not stream", vm.ui.value.engine.streaming)
        assertFalse(
            "the stale text never enters the transcript",
            vm.ui.value.engine.messages.any { message ->
                message is ChatMessage.Assistant && message.blocks.any {
                    it is io.github.kahme247.ompweb.chat.AssistantBlock.Text && it.text == "old answer"
                }
            },
        )
    }

    // ------------------------------------------------------------ send failure

    @Test
    fun promptAckTimeoutKeepsTheRunUntilTheNextReconcile() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        // The prompt frame may already sit in omp's stdin: a 400
        // `session_slow` with maybeStarted must not roll the turn back.
        api.promptFailure = ApiError.SessionSlow(
            "omp is busy and did not acknowledge the message in time; it may still be running.",
            maybeStarted = true,
        )
        vm.send("hello")
        runCurrent()

        val state = vm.ui.value.engine
        assertTrue("the maybe-started turn keeps reporting as running", vm.ui.value.busy)
        assertEquals("the optimistic row is not rolled back", "hello", state.pendingUser?.text)
        assertEquals(
            listOf(MAYBE_STARTED),
            vm.ui.value.notices.filter { it.kind == NoticeKind.Warning }.map { it.message },
        )
        assertTrue(
            "no rollback error",
            vm.ui.value.notices.none { it.kind == NoticeKind.Error },
        )

        // Sending stays locked while the run may still be alive.
        vm.send("second")
        runCurrent()
        assertEquals(listOf("s1" to "hello"), api.prompts)

        // The next successful reconcile reports an idle session: the run
        // settles and the send lock clears.
        api.promptFailure = null
        api.contextPage = page("s1", listOf(USER_HELLO))
        advanceTimeBy(RECONCILE_MILLIS + 1)
        runCurrent()

        assertFalse("an answered reconcile unlocks sending", vm.ui.value.busy)
        assertNull(vm.ui.value.engine.pendingUser)
        vm.send("second")
        runCurrent()
        assertEquals(listOf("s1" to "hello", "s1" to "second"), api.prompts)
    }

    @Test
    fun stopReportsAnUnconfirmedAbortInsteadOfTheGenericBusyText() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        vm.send("hello")
        runCurrent()
        assertTrue(vm.ui.value.busy)

        // omp was too busy to answer the abort: the stop is not confirmed and
        // the run may still be going, so the user gets that wording instead of
        // only the generic busy text.
        api.abortFailure = ApiError.SessionSlow(
            "omp is busy and did not answer the abort in time; the abort is not confirmed and the session keeps running.",
            abortUnconfirmed = true,
        )
        vm.stop()
        runCurrent()

        assertEquals(
            listOf(STOP_UNCONFIRMED),
            eventLog.filterIsInstance<ChatEvent.Toast>().map { it.message },
        )
        assertTrue("an unconfirmed stop never ends the run locally", vm.ui.value.busy)
    }

    @Test
    fun sendFailureRollsBackTheOptimisticRow() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        api.promptFailure = ApiError.ServerResponse(500, "agent_busy", "The agent is already running")
        vm.send("doomed")
        runCurrent()

        val state = vm.ui.value.engine
        assertFalse("a failed send is not running", vm.ui.value.busy)
        assertNull("the optimistic row is rolled back", state.pendingUser)
        assertTrue("nothing was committed", state.messages.isEmpty())
        assertTrue("no transcript row survives", vm.ui.value.rows.isEmpty())
        assertEquals(
            listOf("The agent is already running"),
            vm.ui.value.notices.filter { it.kind == NoticeKind.Error }.map { it.message },
        )
        assertEquals(1, api.prompts.size)
    }

    // ------------------------------------------------- shell command drafting

    @Test
    fun aShellCommandDuringARunIsQueuedInsteadOfExecuted() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        vm.send("hello")
        runCurrent()
        assertTrue(vm.ui.value.busy)

        vm.composer.setText("!ls -la")
        vm.submit()
        runCurrent()

        assertTrue("the agent run keeps the session: ${api.bashCalls}", api.bashCalls.isEmpty())
        assertEquals("the command becomes a queued follow-up", listOf("s1" to "!ls -la"), api.followUps)
        assertEquals("the queued command leaves the field", "", vm.composer.state.value.text)
    }

    @Test
    fun hardwareEnterDuringARunHonoursTheSteerPreference() = chatTest {
        createViewModel(submitDuringRun = SubmitDuringRunBehavior.STEER)
        vm.open("s1", null)
        runCurrent()

        vm.send("hello")
        runCurrent()
        assertTrue(vm.ui.value.busy)

        vm.composer.setText("change course")
        // What `ComposerBar` does for hardware Enter; only the Send/Queue
        // button forces a follow-up (web `ChatInput`: Enter reads the setting).
        vm.submit()
        runCurrent()

        assertEquals(listOf("s1" to "change course"), api.steers)
        assertTrue("Enter never forces a queued follow-up", api.followUps.isEmpty())
        assertEquals("the steered text leaves the field", "", vm.composer.state.value.text)
    }

    @Test
    fun hardwareEnterDuringARunQueuesWhenTheSettingSaysSo() = chatTest {
        createViewModel(submitDuringRun = SubmitDuringRunBehavior.QUEUE)
        vm.open("s1", null)
        runCurrent()

        vm.send("hello")
        runCurrent()
        assertTrue(vm.ui.value.busy)

        vm.composer.setText("next question")
        vm.submit()
        runCurrent()

        assertEquals(listOf("s1" to "next question"), api.followUps)
        assertTrue("the default never steers", api.steers.isEmpty())
    }

    // ------------------------------------- submits before the live state arrives

    /**
     * A cold start from cache has a transcript but no live view yet. A submit
     * must not guess "idle": omp refuses a plain `prompt` while a turn runs
     * ("Agent is already processing"), so the steer preference would be lost.
     */
    @Test
    fun aSubmitWithUnknownLiveStateWaitsForItAndSteersTheRunningTurn() = chatTest {
        createViewModel(submitDuringRun = SubmitDuringRunBehavior.STEER)
        // The live-state read is on the wire but has not answered yet.
        val gate = CompletableDeferred<JsonObject>()
        api.agentStateGate = gate
        vm.open("s1", null)
        runCurrent()
        assertFalse("no live word from the server yet", vm.ui.value.engine.liveStateKnown)

        vm.composer.setText("change course")
        vm.submit()
        runCurrent()

        assertTrue("the submit waits for the live state", vm.ui.value.submitPending)
        assertTrue("nothing is sent on a guess", api.prompts.isEmpty())
        assertTrue("no steer is sent on a guess either", api.steers.isEmpty())
        assertEquals("the draft stays in the field", "change course", vm.composer.state.value.text)

        gate.complete(parse("""{"running":true,"state":{"isPromptRunning":true,"isStreaming":true}}"""))
        runCurrent()
        advanceTimeBy(200)
        runCurrent()

        assertEquals("the running turn receives the text as a steer", listOf("s1" to "change course"), api.steers)
        assertTrue("no plain prompt reaches omp", api.prompts.isEmpty())
        assertEquals("the steered text leaves the field", "", vm.composer.state.value.text)
        assertFalse("the pending state ends", vm.ui.value.submitPending)
    }

    @Test
    fun aSubmitWithUnknownLiveStateSendsAPromptWhenTheServerSaysIdle() = chatTest {
        createViewModel(submitDuringRun = SubmitDuringRunBehavior.STEER)
        val gate = CompletableDeferred<JsonObject>()
        api.agentStateGate = gate
        vm.open("s1", null)
        runCurrent()
        assertFalse(vm.ui.value.engine.liveStateKnown)

        vm.composer.setText("new topic")
        vm.submit()
        runCurrent()
        assertTrue("the submit waits for the live state", vm.ui.value.submitPending)

        gate.complete(parse("""{"running":false}"""))
        runCurrent()
        advanceTimeBy(200)
        runCurrent()

        assertEquals("an idle session gets a normal prompt", listOf("s1" to "new topic"), api.prompts)
        assertTrue("an idle session is never steered", api.steers.isEmpty())
        assertFalse(vm.ui.value.submitPending)
        assertEquals("", vm.composer.state.value.text)
    }

    @Test
    fun aFailedLiveStateReadKeepsTheDraftAndSaysSo() = chatTest {
        createViewModel(submitDuringRun = SubmitDuringRunBehavior.STEER)
        api.agentStateFailure = ApiError.Network(java.io.IOException("offline"))
        vm.open("s1", null)
        runCurrent()
        assertFalse("the state stays unknown", vm.ui.value.engine.liveStateKnown)

        vm.composer.setText("keep me")
        vm.submit()
        runCurrent()
        assertTrue("the submit waits for the bounded read", vm.ui.value.submitPending)

        advanceTimeBy(LIVE_STATE_SUBMIT_TIMEOUT + 1)
        runCurrent()

        assertFalse("the wait ends at the bound", vm.ui.value.submitPending)
        assertEquals("the draft is kept", "keep me", vm.composer.state.value.text)
        assertTrue("no prompt was guessed", api.prompts.isEmpty())
        assertTrue("nothing was steered", api.steers.isEmpty())
        assertTrue("nothing was queued", api.followUps.isEmpty())
        assertEquals(
            "the user is told why nothing was sent",
            listOf(LIVE_STATE_UNKNOWN),
            eventLog.filterIsInstance<ChatEvent.Toast>().map { it.message },
        )
    }

    /**
     * Finding 2 of the 1.0.9 review: the waiting submit belongs to the chat it
     * was typed in. Switching chats used to leave the new composer locked on
     * "Sending…" until the old read (up to the socket timeout) answered.
     */
    @Test
    fun switchingChatsCancelsTheWaitingSubmitAndFreesTheNewComposer() = chatTest {
        createViewModel(submitDuringRun = SubmitDuringRunBehavior.STEER)
        val oldRead = CompletableDeferred<JsonObject>()
        api.agentStateGates["s1"] = oldRead
        vm.open("s1", null)
        runCurrent()
        assertFalse("s1's live state is still unknown", vm.ui.value.engine.liveStateKnown)

        vm.composer.setText("send to s1")
        vm.submit()
        runCurrent()
        assertTrue("the submit waits for s1's live state", vm.ui.value.submitPending)

        vm.open("s2", null)
        runCurrent()

        assertEquals("s2 is open", "s2", vm.ui.value.sessionId)
        assertTrue("s2 answers its own live state", vm.ui.value.engine.liveStateKnown)
        assertFalse("the new chat's composer is not locked", vm.ui.value.submitPending)
        assertEquals(
            "the user learns that nothing was sent",
            listOf(SUBMIT_ABANDONED),
            eventLog.filterIsInstance<ChatEvent.Toast>().map { it.message },
        )
        assertTrue("nothing is routed on a guess", api.prompts.isEmpty())
        assertTrue(api.steers.isEmpty())
        assertTrue(api.followUps.isEmpty())

        // The late answer of the abandoned wait reaches nobody: the cancelled
        // submit is gone, so s2 neither steers nor adopts s1's run.
        oldRead.complete(parse("""{"running":true,"state":{"isPromptRunning":true,"isStreaming":true}}"""))
        runCurrent()
        assertTrue("the abandoned submit is dropped, not steered", api.steers.isEmpty())
        assertFalse("no phantom run is adopted by the new chat", vm.ui.value.busy)
        assertTrue("s2's live state is untouched", vm.ui.value.engine.liveStateKnown)

        // The draft of the abandoned chat survived the switch.
        vm.open("s1", null)
        runCurrent()
        assertEquals("the draft stays in the chat it was typed in", "send to s1", vm.composer.state.value.text)
    }

    /**
     * Finding 2, second half: a sign-out/server switch drops every piece of
     * the user's data, so the submit that still holds a draft must not survive
     * it either.
     */
    @Test
    fun droppingTheSignedInUserCancelsTheWaitingSubmit() = chatTest {
        createViewModel(submitDuringRun = SubmitDuringRunBehavior.STEER)
        val gate = CompletableDeferred<JsonObject>()
        api.agentStateGate = gate
        vm.open("s1", null)
        runCurrent()
        assertFalse(vm.ui.value.engine.liveStateKnown)

        vm.composer.setText("private text")
        vm.submit()
        runCurrent()
        assertTrue(vm.ui.value.submitPending)

        vm.clearSessionData()
        runCurrent()

        assertFalse("the wait ends with the data", vm.ui.value.submitPending)
        assertNull("the chat is gone", vm.ui.value.sessionId)

        gate.complete(parse("""{"running":true,"state":{"isPromptRunning":true}}"""))
        runCurrent()
        assertTrue("the dropped draft is never routed", api.prompts.isEmpty())
        assertTrue(api.steers.isEmpty())
        assertTrue(api.followUps.isEmpty())
    }

    /**
     * Finding 1 of the 1.0.9 review: at the ten-second bound the wait must
     * abandon the read that is on the wire (the ApiClient closes that call),
     * not sit there until the read answers by itself.
     */
    @Test
    fun theSubmitBoundCancelsTheLiveStateReadOnTheWire() = chatTest {
        createViewModel(submitDuringRun = SubmitDuringRunBehavior.STEER)
        // The open's read fails at once, so no read is in flight and the
        // submit starts its own.
        api.agentStateFailure = ApiError.Network(java.io.IOException("offline"))
        vm.open("s1", null)
        runCurrent()
        assertFalse(vm.ui.value.engine.liveStateKnown)

        // From now on the read hangs; only the submit's bound can end it.
        api.agentStateFailure = null
        val gate = CompletableDeferred<JsonObject>()
        api.agentStateGate = gate
        vm.composer.setText("keep me")
        vm.submit()
        runCurrent()
        assertTrue("the submit waits for the live state", vm.ui.value.submitPending)
        assertEquals("the read is on the wire", 0, api.agentStateCancelled)

        advanceTimeBy(LIVE_STATE_SUBMIT_TIMEOUT + 1)
        runCurrent()

        assertEquals("the bound cancels the request instead of waiting for it", 1, api.agentStateCancelled)
        assertFalse("the wait ends at the bound", vm.ui.value.submitPending)
        assertEquals("the draft is kept", "keep me", vm.composer.state.value.text)
        assertTrue("nothing was guessed", api.prompts.isEmpty() && api.steers.isEmpty() && api.followUps.isEmpty())
        assertEquals(
            listOf(LIVE_STATE_UNKNOWN),
            eventLog.filterIsInstance<ChatEvent.Toast>().map { it.message },
        )
    }

    @Test
    fun aShellCommandWithoutASessionKeepsTheDraft() = chatTest {
        createViewModel()
        vm.composer.setText("!ls")
        vm.submit()
        runCurrent()

        assertTrue(api.bashCalls.isEmpty())
        assertEquals("the draft survives the refusal", "!ls", vm.composer.state.value.text)
        assertEquals(
            listOf(SHELL_NO_SESSION),
            eventLog.filterIsInstance<ChatEvent.Toast>().map { it.message },
        )
    }

    @Test
    fun aSecondShellCommandWhileOneRunsKeepsTheDraft() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        vm.composer.setText("!!ls")
        vm.submit()
        assertEquals("a started command clears the field", "", vm.composer.state.value.text)

        vm.composer.setText("!pwd")
        vm.submit()
        assertEquals("a refused command keeps its text", "!pwd", vm.composer.state.value.text)
        runCurrent()
        assertEquals(
            "the running command is never replaced",
            listOf(Triple("s1", "ls", true)),
            api.bashCalls,
        )
        assertEquals("!pwd", vm.composer.state.value.text)
    }

    @Test
    fun aDictationSubmissionCarriesTheComposerAttachments() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        // Exactly what the dictation path resolves: the transcript replaces the
        // text, but attached images and files stay in the submission.
        vm.composer.addImages(listOf(ComposerImage("iVBORw0KGgo=", "image/png")))
        vm.composer.addTextFiles(
            listOf(
                io.github.kahme247.ompweb.domain.AttachedTextFile(
                    name = "notes.txt",
                    mimeType = "text/plain",
                    content = "context",
                    size = 7,
                ),
            ),
        )
        val submission = vm.composer.resolve(overrideText = "dictated text")

        assertEquals("dictated text", submission?.raw)
        assertEquals(1, submission?.images?.size)
        assertTrue("the prompt keeps the transcript", submission?.prompt?.startsWith("dictated text") == true)
        assertTrue(
            "the prompt still inlines the text attachment: ${submission?.prompt}",
            submission?.prompt?.contains("Attached file: notes.txt") == true,
        )
    }

    @Test
    fun leavingTheChatDuringLiveDictationCommitsAndReleasesTheRecognizer() = chatTest {
        val speech = FakeOnDeviceStt()
        val dictation = DictationViewModel(
            api = FakeSttApi(),
            store = MemoryDictationStore(),
            scope = backgroundScope,
            settings = MutableStateFlow(SettingsSnapshot(loaded = true, dictationEngine = "on_device")),
            onDevice = speech,
            // JVM tests: SystemClock is not mocked.
            clock = { 0L },
            deviceLocale = java.util.Locale.GERMANY,
        )
        createViewModel(dictationOverride = dictation)
        vm.open("s1", null)
        runCurrent()

        vm.dictation.start(SttAfter.Insert)
        assertTrue("the recognizer is live", vm.dictation.state.value is DictationState.Live)
        speech.listener!!.onPartial("hallo")

        // Back to the list: the composer shell (and its ReportVisibility) is
        // gone, so the chat view model must end the capture itself.
        vm.onChatHidden()

        assertEquals("what was said becomes draft text", "hallo", vm.composer.state.value.text)
        assertTrue("the live state ends", vm.dictation.state.value is DictationState.Idle)
        assertTrue("the recognizer is destroyed", speech.released)
    }

    // --------------------------------------------------------- foreign owner

    /**
     * `GET /api/agent/{id}` answer of a session another omp process runs, in the
     * server's exact shape: the single-session report is `SessionElsewhere` and
     * carries no `id`/`cwd` (only the list's `elsewhereSessions` entries do).
     */
    private fun elsewhereState(
        source: String = "instance-list",
        kind: String = "omp-web",
        running: Boolean = true,
        active: Boolean = true,
    ): JsonObject = parse(
        """{"running":false,"state":{"isStreaming":false,"isPromptRunning":false},""" +
            """"elsewhere":{"kind":"$kind","source":"$source",""" +
            """"running":$running,"active":$active,"lastActivityAt":1800000000000}}""",
    )

    @Test
    fun aProvenForeignOwnerBlocksTheSendAndKeepsTheDraft() = chatTest {
        createViewModel()
        api.agentState = elsewhereState(source = "instance-list")
        vm.open("s1", null)
        runCurrent()
        assertNotNull("the owner report reaches the chat", vm.ui.value.engine.foreignRun)

        vm.composer.setText("keep me")
        vm.submit()
        runCurrent()
        advanceTimeBy(200)
        runCurrent()

        assertTrue("nothing was sent", api.prompts.isEmpty())
        assertEquals("the draft stays in the field", "keep me", vm.composer.state.value.text)
        assertNull("a proven owner does not open a dialog by itself", vm.ui.value.foreignSend)
        assertEquals(
            "the refusal is explained",
            listOf(FOREIGN_BLOCKED),
            vm.ui.value.engine.notices.filter { it.kind == NoticeKind.Warning }.map { it.message },
        )
    }

    @Test
    fun theWeakTranscriptSignalAsksBeforeSending() = chatTest {
        createViewModel()
        api.agentState = elsewhereState(source = "transcript", kind = "terminal", running = false)
        vm.open("s1", null)
        runCurrent()

        vm.composer.setText("into a copy")
        vm.submit()
        runCurrent()

        assertTrue("nothing was sent yet", api.prompts.isEmpty())
        assertEquals("the dialog holds the submission", "into a copy", vm.ui.value.foreignSend?.prompt)
        assertEquals("the draft is untouched", "into a copy", vm.composer.state.value.text)
    }

    @Test
    fun confirmingTheCopySendsWithForceAndClearsTheDraft() = chatTest {
        createViewModel()
        api.agentState = elsewhereState(source = "transcript", kind = "terminal")
        vm.open("s1", null)
        runCurrent()

        vm.composer.setText("into a copy")
        vm.submit()
        runCurrent()
        vm.confirmForeignSend()
        runCurrent()

        assertEquals("exactly one prompt left", listOf("s1" to "into a copy"), api.prompts)
        assertEquals("the server's gate is skipped on purpose", listOf(true), api.promptForces)
        assertNull("the dialog is closed", vm.ui.value.foreignSend)
        assertEquals("the sent text left the field", "", vm.composer.state.value.text)
    }

    @Test
    fun cancellingTheDialogSendsNothingAndKeepsTheDraft() = chatTest {
        createViewModel()
        api.agentState = elsewhereState(source = "transcript", kind = "terminal")
        vm.open("s1", null)
        runCurrent()

        vm.composer.setText("not yet")
        vm.submit()
        runCurrent()
        vm.cancelForeignSend()
        runCurrent()

        assertNull("the dialog closes", vm.ui.value.foreignSend)
        assertTrue("nothing was sent", api.prompts.isEmpty())
        assertEquals("the draft is still there", "not yet", vm.composer.state.value.text)
    }

    @Test
    fun theServerRefusalOpensTheCopyDialogAndKeepsTheText() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()
        // The client knew nothing; the owner appeared between the state read
        // and the send, so the server answers 409.
        api.promptFailure = ApiError.SessionRunningElsewhere(
            io.github.kahme247.ompweb.net.ElsewhereSession(
                id = "s1",
                kind = "terminal",
                source = "process",
                running = true,
                active = true,
            ),
        )

        vm.composer.setText("keep me")
        vm.submit()
        runCurrent()

        assertEquals("the attempt is not retried", 1, api.prompts.size)
        assertEquals("no error banner for a foreign owner", null, vm.ui.value.engine.error)
        assertNotNull("the owner is now known", vm.ui.value.engine.foreignRun)
        assertEquals("the text is handed back", "keep me", vm.composer.state.value.text)
        assertEquals("the dialog offers the copy", "keep me", vm.ui.value.foreignSend?.prompt)
    }

    @Test
    fun theSessionListOwnerPaintsTheBannerBeforeTheStateReadAnswers() = chatTest {
        createViewModel()
        // This chat's own read is still on the wire when the chat opens: the
        // list already knows the owner (`elsewhereSessions`), so the banner must
        // not wait for the answer.
        val read = CompletableDeferred<JsonObject>()
        api.agentStateGate = read
        vm.open(
            "s1",
            null,
            ElsewhereSession(
                id = "s1",
                kind = "terminal",
                source = "process",
                running = true,
                active = true,
            ),
        )
        runCurrent()

        assertNotNull("the list's owner report reaches the banner", vm.ui.value.engine.foreignRun)

        // The authoritative answer says the same; the send is then held with the
        // usual notice and the draft stays in the field.
        read.complete(elsewhereState(source = "process", kind = "terminal"))
        runCurrent()

        vm.composer.setText("keep me")
        vm.submit()
        runCurrent()

        assertTrue("nothing was sent", api.prompts.isEmpty())
        assertEquals("the draft stays in the field", "keep me", vm.composer.state.value.text)
        assertEquals(
            "the refusal is explained",
            listOf(FOREIGN_BLOCKED),
            vm.ui.value.engine.notices.filter { it.kind == NoticeKind.Warning }.map { it.message },
        )
    }

    @Test
    fun theBannerClearsOnceTheOwnerHasEnded() = chatTest {
        createViewModel()
        api.agentState = elsewhereState(source = "instance-list")
        vm.open("s1", null)
        runCurrent()
        assertNotNull("the chat knows the owner", vm.ui.value.engine.foreignRun)

        // Let the periodic loop settle on the foreign run (its first decision
        // was still "live state unknown").
        advanceTimeBy(3_001)
        runCurrent()
        assertNotNull("a refreshed report keeps the owner", vm.ui.value.engine.foreignRun)

        // The other process is gone: the next owner poll answers idle. No frame
        // of the (refused) session channel would ever say so.
        api.agentState = parse("""{"running":false,"elsewhere":null}""")
        advanceTimeBy(2_001)
        runCurrent()

        assertNull("the banner and the send gate go with the owner", vm.ui.value.engine.foreignRun)
    }

    @Test
    fun theContentionForkKeepsTheOriginalOneTapAway() = chatTest {
        createViewModel()
        api.agentState = elsewhereState(source = "instance-list")
        vm.open("s1", null)
        runCurrent()
        assertNotNull("the chat knew the other owner", vm.ui.value.engine.foreignRun)

        // omp moved the conversation to a copy after the forced send: the copy
        // is this app's, and the original must stay reachable from here.
        emit("""{"type":"session_contention_fork","fromId":"s1","toId":"copy-1"}""")

        assertEquals("the banner links the original", "s1", vm.ui.value.contentionCopy?.originalId)
        assertEquals("and the copy", "copy-1", vm.ui.value.contentionCopy?.copyId)
        assertNull("the copy is ours, not foreign", vm.ui.value.engine.foreignRun)

        vm.dismissContentionFork()
        assertNull("dismissing drops the links", vm.ui.value.contentionCopy)

        emit("""{"type":"session_contention_fork","fromId":"s1","toId":"copy-1"}""")
        vm.open("s2", null)
        runCurrent()
        assertNull("the links belong to the copied chat", vm.ui.value.contentionCopy)
    }

    @Test
    fun aForcedSendThatIsStillRefusedReportsWithoutADialog() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()
        api.promptFailure = ApiError.SessionRunningElsewhere(null)

        vm.composer.setText("forced")
        vm.submit()
        runCurrent()
        // The dialog opened for the first attempt; confirm it, and the forced
        // send is refused again (the session file vanished under the gate).
        vm.confirmForeignSend()
        runCurrent()

        assertEquals("both attempts ran", listOf(false, true), api.promptForces)
        assertNull("the dialog does not reopen", vm.ui.value.foreignSend)
        assertEquals("the text is back in the field", "forced", vm.composer.state.value.text)
        assertEquals(
            "the refusal is explained",
            listOf(FOREIGN_BLOCKED),
            vm.ui.value.engine.notices.filter { it.kind == NoticeKind.Warning }.map { it.message },
        )
    }

    // --------------------------------------------- foreign command refusals

    /**
     * N7: a non-send command refused by the ownership gate must show the banner
     * and a command-specific message — the prompt wording ("your message was not
     * sent", with the "Send anyway" hint) is wrong for `/compact`, a fork or a
     * settings change, and the banner used to stay absent.
     */
    @Test
    fun aCommandRefusedByAForeignOwnerShowsTheBannerAndTheCommandMessage() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()
        api.compactFailure = ApiError.SessionRunningElsewhere(
            io.github.kahme247.ompweb.net.ElsewhereSession(
                kind = "terminal",
                source = "process",
                running = false,
                active = true,
            ),
        )

        vm.composer.setText("/compact")
        vm.submit()
        runCurrent()

        assertEquals("the command reached the server", 1, api.compactCalls)
        assertNotNull("the ownership banner goes up", vm.ui.value.engine.foreignRun)
        assertNull("the chat is not busy", vm.ui.value.engine.error)
        assertEquals(
            "the command wording is used",
            listOf(FOREIGN_COMMAND_BLOCKED),
            eventLog.filterIsInstance<ChatEvent.Toast>().map { it.message },
        )
    }

    @Test
    fun aForkRefusedByAForeignOwnerShowsTheBannerAndTheCommandMessage() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()
        api.forkFailure = ApiError.SessionRunningElsewhere(
            io.github.kahme247.ompweb.net.ElsewhereSession(
                kind = "omp-web",
                source = "instance-list",
                running = true,
                active = true,
            ),
        )

        vm.fork("entry-1", editPrompt = false)
        runCurrent()

        assertEquals("the fork was attempted", listOf("s1" to "entry-1"), api.forkCalls)
        assertTrue("no fork was opened", eventLog.filterIsInstance<ChatEvent.Forked>().isEmpty())
        assertNotNull("the ownership banner goes up", vm.ui.value.engine.foreignRun)
        assertEquals(
            "the command wording is used",
            listOf(FOREIGN_COMMAND_BLOCKED),
            eventLog.filterIsInstance<ChatEvent.Toast>().map { it.message },
        )
        assertNull("the fork spinner is cleared", vm.ui.value.forkingEntryId)
    }

    @Test
    fun aSettingsChangeRefusedByAForeignOwnerShowsTheBannerAndTheCommandMessage() = chatTest {
        // The composer's settings commands live in a separate view model; the
        // chat turns its refusal into the banner and the command message.
        val controlsApi = FakeComposerApi().apply {
            commandFailure = ApiError.SessionRunningElsewhere(
                io.github.kahme247.ompweb.net.ElsewhereSession(
                    kind = "terminal",
                    source = "process",
                    running = false,
                    active = true,
                ),
            )
        }
        createViewModel(controlsApi = controlsApi)
        vm.open("s1", null)
        runCurrent()

        vm.controls.onFastModeChange(true)
        runCurrent()

        assertNotNull("the ownership banner goes up", vm.ui.value.engine.foreignRun)
        assertEquals(
            "the command wording is used",
            listOf(FOREIGN_COMMAND_BLOCKED),
            eventLog.filterIsInstance<ChatEvent.Toast>().map { it.message },
        )
        assertNull("the refusal was consumed", vm.controls.state.value.foreignRefusal)
    }

    // ------------------------------------------------------------------ fork

    @Test
    fun forkPrefillIsConsumedByTheNewSessionOnly() = chatTest {
        createViewModel()
        vm.open("A", null)
        runCurrent()

        api.forkOutcome = ForkOutcome(newSessionId = "B", text = "edited prompt")
        vm.fork("entry-1", editPrompt = true)
        runCurrent()

        val forked = eventLog.filterIsInstance<ChatEvent.Forked>().single()
        assertEquals("B", forked.sessionId)
        assertNull("the old session never shows the prefill", vm.ui.value.prefill)

        vm.open("B", null)
        runCurrent()
        assertEquals("the new session receives the prefill", "edited prompt", vm.ui.value.prefill)

        vm.adoptPrefill()
        runCurrent()
        assertEquals("the prefill lands in the composer", "edited prompt", vm.composer.state.value.text)
        assertNull(vm.ui.value.prefill)

        vm.open("A", null)
        runCurrent()
        assertNull(vm.ui.value.prefill)

        vm.open("B", null)
        runCurrent()
        assertNull("the prefill is consumed once", vm.ui.value.prefill)
    }

    @Test
    fun aSearchHitInAnotherSessionSurvivesTheSessionSwitch() = chatTest {
        createViewModel()
        api.contextPage = page("A", listOf(USER_HELLO))
        vm.open("A", null)
        runCurrent()

        // The session list taps a hit of another session before the detail
        // surface switches; the switch resets the in-chat search state.
        vm.scrollToEntry("B", "e1")
        assertNull("the hit must not leak into the open transcript", vm.search.value.revealEntryId)

        api.contextPage = page("B", listOf(USER_HELLO, ASSISTANT_HI))
        vm.open("B", null)
        runCurrent()

        assertEquals("B", vm.ui.value.sessionId)
        assertEquals(
            "the queued hit is applied once its session is open",
            "e1",
            vm.search.value.revealEntryId,
        )

        vm.consumeRevealEntry()
        assertNull("the transcript consumed the request", vm.search.value.revealEntryId)
    }

    @Test
    fun aQueuedSearchHitIsDroppedWhenTheServerChanges() = chatTest {
        val first = ServerAddress("http", "first.example", 30177)
        val second = ServerAddress("http", "second.example", 30177)
        val originSettings = FakeChatSettings(SettingsSnapshot(loaded = true, origin = first))
        createViewModel(settingsOverride = originSettings)
        vm.open("A", null)
        runCurrent()

        vm.scrollToEntry("B", "e1")
        originSettings.setOrigin(second)
        runCurrent()

        // The queued id belongs to the first installation's session file; on
        // the new server it is either unknown or points at unrelated text.
        api.contextPage = page("B", listOf(USER_HELLO, ASSISTANT_HI))
        vm.open("B", null)
        runCurrent()
        assertNull("a reveal never survives a server change", vm.search.value.revealEntryId)
    }

    @Test
    fun aSearchHitForTheOpenSessionIsAppliedImmediately() = chatTest {
        createViewModel()
        api.contextPage = page("s1", listOf(USER_HELLO))
        vm.open("s1", null)
        runCurrent()

        vm.scrollToEntry("s1", "e0")
        assertEquals("e0", vm.search.value.revealEntryId)
    }

    @Test
    fun aCancelledForkIsReportedAndNeverSwallowed() = chatTest {
        createViewModel()
        vm.open("A", null)
        runCurrent()

        // omp answers {cancelled:true} when it refuses to branch (run in
        // flight). That is not a new session, and before the fix it produced
        // no event at all: the button looked dead.
        api.forkOutcome = ForkOutcome(cancelled = true)
        vm.fork("entry-1", editPrompt = true)
        runCurrent()

        assertTrue(eventLog.filterIsInstance<ChatEvent.Forked>().isEmpty())
        assertEquals(listOf<ChatEvent>(ChatEvent.ForkCancelled), eventLog)
        assertNull("the row leaves its forking state", vm.ui.value.forkingEntryId)
    }

    @Test
    fun aForkWithoutASessionIsReported() = chatTest {
        createViewModel()
        vm.open("A", null)
        runCurrent()

        api.forkOutcome = ForkOutcome(cancelled = false, newSessionId = null)
        vm.fork("entry-1", editPrompt = true)
        runCurrent()

        assertTrue(eventLog.filterIsInstance<ChatEvent.Forked>().isEmpty())
        assertEquals(listOf<ChatEvent>(ChatEvent.ForkFailed), eventLog)
        assertNull(vm.ui.value.forkingEntryId)
    }

    @Test
    fun aFailedForkReportsTheServerMessageAndClearsTheRow() = chatTest {
        createViewModel()
        vm.open("A", null)
        runCurrent()

        api.forkFailure = ApiError.ServerResponse(400, "session_busy", "Wait for the current run to finish")
        vm.fork("entry-1", editPrompt = true)
        runCurrent()

        assertEquals(
            listOf("Wait for the current run to finish"),
            eventLog.filterIsInstance<ChatEvent.Toast>().map { it.message },
        )
        assertNull("the row is clickable again after the failure", vm.ui.value.forkingEntryId)
    }

    // --------------------------------------------------------- phase-7 seams

    @Test
    fun anInvalidSubagentHandleNeverOpensADialog() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        vm.openSubagent("agent://bad id")
        runCurrent()

        assertNull("a handle the transcript route rejects opens nothing", vm.ui.value.subagent)
        assertEquals("no completion fetch for an invalid id", 0, api.subagentCompletionCalls)
        assertEquals("no transcript fetch for an invalid id", 0, api.subagentTranscriptCalls)
    }

    // ----------------------------------------------------- branch / history

    @Test
    fun selectLeafRequestsContextWithLeafId() = chatTest {
        api.contextPage = page("s1", listOf(USER_HELLO, ASSISTANT_HI))
        createViewModel()
        vm.open("s1", null)
        runCurrent()
        assertEquals(listOf(null), api.contextFullLeafIds)

        vm.selectLeaf("e1")
        runCurrent()

        assertEquals("the branch leaf travels with the reload", "e1", api.contextFullLeafIds.last())
        assertEquals(2, api.contextFullCalls)
        assertEquals("e1", vm.ui.value.engine.leafId)
        assertTrue(vm.ui.value.engine.historyLoaded)
    }

    @Test
    fun togglingPreCompactionRefetchesWithTheFlag() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()
        assertEquals(listOf(false), api.contextPreCompaction)

        vm.togglePreCompactionHistory()
        runCurrent()

        assertTrue(vm.ui.value.engine.includePreCompaction)
        assertEquals("the reload asks for the pre-compaction view", true, api.contextPreCompaction.last())
        assertEquals(2, api.contextFullCalls)

        vm.togglePreCompactionHistory()
        runCurrent()

        assertFalse(vm.ui.value.engine.includePreCompaction)
        assertEquals(false, api.contextPreCompaction.last())
    }

    @Test
    fun editFromHereSelectsTheLeafAndPrefillsWithoutForking() = chatTest {
        api.contextPage = page("s1", listOf(USER_HELLO, ASSISTANT_HI))
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        vm.editFromHere("entry-assistant-1", "hello, edited")
        runCurrent()

        assertEquals("the view branches back in place", "entry-assistant-1", vm.ui.value.engine.leafId)
        assertEquals("entry-assistant-1", api.contextFullLeafIds.last())
        assertEquals("the prompt lands in the composer", "hello, edited", vm.composer.state.value.text)
        assertTrue("no new session is forked", api.forkCalls.isEmpty())
        assertTrue(eventLog.filterIsInstance<ChatEvent.Forked>().isEmpty())
    }

    @Test
    fun editFromHereNeverOverwritesAnExistingDraft() = chatTest {
        api.contextPage = page("s1", listOf(USER_HELLO, ASSISTANT_HI))
        createViewModel()
        vm.open("s1", null)
        runCurrent()
        vm.composer.setText("a draft I typed")

        vm.editFromHere("entry-assistant-1", "hello, edited")
        runCurrent()

        assertEquals(
            "web `insertIfEmpty`: an existing draft stays",
            "a draft I typed",
            vm.composer.state.value.text,
        )
        assertEquals("the view still branches back", "entry-assistant-1", vm.ui.value.engine.leafId)
    }

    @Test
    fun editFromHereAbortsWhenTheViewCannotBranch() = chatTest {
        api.contextPage = page("s1", listOf(USER_HELLO, ASSISTANT_HI))
        createViewModel()
        vm.open("s1", null)
        runCurrent()
        val leafBefore = vm.ui.value.engine.leafId
        vm.send("hello")
        runCurrent()
        assertTrue("the turn is running", vm.ui.value.busy)

        vm.editFromHere("entry-assistant-1", "hello, edited")
        runCurrent()

        assertEquals("the failed navigation aborts", leafBefore, vm.ui.value.engine.leafId)
        assertTrue(
            "and nothing is prefilled",
            vm.composer.state.value.text.isBlank(),
        )
    }

    // ----------------------------------------------------------- completion

    @Test
    fun completionTonePlaysOnceWhenTheSoundPreferenceIsOn() = chatTest {
        val toneSettings = FakeChatSettings(SettingsSnapshot(loaded = true, soundEnabled = true))
        createViewModel(settingsOverride = toneSettings)
        vm.open("s1", null)
        runCurrent()

        // The history reload reconciles against get_state; a live run answers busy.
        api.agentState = parse("""{"running":true,"state":{"isPromptRunning":true}}""")
        api.contextPage = page("s1", listOf(USER_HELLO, ASSISTANT_HI))
        vm.send("hello")
        runCurrent()
        emit("""{"type":"agent_start","web":{"streamId":"A","sequence":8}}""")
        emit(
            """{"type":"message_start","message":{"role":"assistant",""" +
                """"content":[{"type":"text","text":"hi"}],"timestamp":1001},""" +
                """"web":{"streamId":"A","sequence":12}}""",
        )
        emit(
            """{"type":"message_end","message":{"role":"assistant",""" +
                """"content":[{"type":"text","text":"hi"}],"timestamp":1001,"stopReason":"stop"},""" +
                """"web":{"streamId":"A","sequence":16}}""",
        )
        emit("""{"type":"agent_end","isTerminal":true,"web":{"streamId":"A","sequence":20}}""")

        assertEquals("one tone per finished run", 1, completionTones)
    }

    @Test
    fun completionToneStaysSilentWhenTheSoundPreferenceIsOff() = chatTest {
        createViewModel(settingsOverride = FakeChatSettings(SettingsSnapshot(loaded = true, soundEnabled = false)))
        vm.open("s1", null)
        runCurrent()

        api.agentState = parse("""{"running":true,"state":{"isPromptRunning":true}}""")
        api.contextPage = page("s1", listOf(USER_HELLO, ASSISTANT_HI))
        vm.send("hello")
        runCurrent()
        emit("""{"type":"agent_start","web":{"streamId":"A","sequence":8}}""")
        emit(
            """{"type":"message_end","message":{"role":"assistant",""" +
                """"content":[{"type":"text","text":"hi"}],"timestamp":1001,"stopReason":"stop"},""" +
                """"web":{"streamId":"A","sequence":16}}""",
        )
        emit("""{"type":"agent_end","isTerminal":true,"web":{"streamId":"A","sequence":20}}""")

        assertEquals("the preference gates the tone", 0, completionTones)
    }
    // --------------------------------------------------------------- speech

    @Test
    fun speechAutoplayReadsTheNewestReplyOnce() = chatTest {
        val autoplaySettings = FakeChatSettings(SettingsSnapshot(loaded = true, ttsAutoplay = true))
        createViewModel(settingsOverride = autoplaySettings)
        vm.open("s1", null)
        runCurrent()

        api.agentState = parse("""{"running":true,"state":{"isPromptRunning":true}}""")
        api.contextPage = page("s1", listOf(USER_HELLO))
        vm.send("hello")
        runCurrent()
        emit("""{"type":"agent_start","web":{"streamId":"A","sequence":8}}""")
        emit(
            """{"type":"message_end","message":{"role":"assistant",""" +
                """"content":[{"type":"text","text":"the newest answer"}],"timestamp":1001,""" +
                """"stopReason":"stop"},"web":{"streamId":"A","sequence":16}}""",
        )
        emit("""{"type":"agent_end","isTerminal":true,"web":{"streamId":"A","sequence":20}}""")
        runCurrent()

        assertEquals("autoplay reads the reply once", 1, speech.spoken.size)
        assertTrue(
            "it reads the finished assistant text: ${speech.spoken}",
            speech.spoken.single().second == "the newest answer",
        )
    }

    @Test
    fun speechAutoplayStaysSilentWhenThePreferenceIsOff() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        api.agentState = parse("""{"running":true,"state":{"isPromptRunning":true}}""")
        api.contextPage = page("s1", listOf(USER_HELLO))
        vm.send("hello")
        runCurrent()
        emit("""{"type":"agent_start","web":{"streamId":"A","sequence":8}}""")
        emit(
            """{"type":"message_end","message":{"role":"assistant",""" +
                """"content":[{"type":"text","text":"quiet"}],"timestamp":1001,"stopReason":"stop"},""" +
                """"web":{"streamId":"A","sequence":16}}""",
        )
        emit("""{"type":"agent_end","isTerminal":true,"web":{"streamId":"A","sequence":20}}""")
        runCurrent()

        assertTrue("no preference, no speech", speech.spoken.isEmpty())
    }

    @Test
    fun theReadAloudButtonTogglesAndStopsThroughTheSpeechSeam() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        vm.toggleSpeech("e1", "e1", "read me")
        runCurrent()
        assertEquals("the speaker marks the entry", "e1", speech.state.value.speakingId)
        assertEquals(listOf("e1" to "read me"), speech.spoken)

        vm.stopSpeech()
        runCurrent()
        assertNull("stopping clears the speaker", speech.state.value.speakingId)
    }

    // ------------------------------------------------------------ chat search

    @Test
    fun openingAnotherSessionWithoutAHitClearsTheOldReveal() = chatTest {
        api.contextPage = page("s1", listOf(USER_HELLO, ASSISTANT_HI))
        createViewModel()
        vm.open("s1", null)
        runCurrent()
        vm.scrollToEntry("s1", "e1")
        assertEquals("e1", vm.search.value.revealEntryId)

        vm.open("s2", null)
        runCurrent()

        assertNull("a plain session switch must not replay the old jump", vm.search.value.revealEntryId)
    }

    @Test
    fun consumingTheRevealKeepsTheInChatSearchState() = chatTest {
        api.contextPage = page("s1", listOf(USER_HELLO, ASSISTANT_HI))
        createViewModel()
        vm.open("s1", null)
        runCurrent()
        vm.scrollToEntry("s1", "e1")
        vm.openSearch()
        vm.setSearchQuery("hi")
        runCurrent()
        assertEquals(1, vm.search.value.hits.size)

        vm.consumeRevealEntry()

        assertNull(vm.search.value.revealEntryId)
        assertEquals("hi", vm.search.value.query)
        assertEquals("the hits the field shows stay", 1, vm.search.value.hits.size)
    }

    @Test
    fun hiddenThinkingNeverBecomesASearchHit() = chatTest {
        api.contextPage = page("s1", listOf(USER_HELLO, ASSISTANT_THINKING))
        createViewModel(
            settingsOverride = FakeChatSettings(SettingsSnapshot(loaded = true, hideThinking = true)),
        )
        vm.open("s1", null)
        runCurrent()

        vm.openSearch()
        vm.setSearchQuery("haystack")
        runCurrent()
        assertTrue(
            "the thinking block is not rendered, so it must not be counted",
            vm.search.value.hits.isEmpty(),
        )

        vm.setSearchQuery("done")
        runCurrent()
        assertEquals("the rendered answer is still searchable", 1, vm.search.value.hits.size)
    }

    @Test
    fun foldedTurnIsOneSearchHitEvenWhenSeveralOfItsMessagesMatch() = chatTest {
        api.contextPage = page("s1", listOf(USER_HELLO, ASSISTANT_FOLDED_MATCH, ASSISTANT_FOLDED_MATCH))
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        vm.openSearch()
        vm.setSearchQuery("needle")
        runCurrent()

        assertEquals(
            "the counter counts rows, not messages",
            1,
            vm.search.value.total,
        )
        assertEquals(
            "stepping wraps back onto the same row instead of a phantom second hit",
            vm.search.value.hits.single().rowKey,
            vm.search.value.hits[ChatSearch.step(0, vm.search.value.total, 1)].rowKey,
        )
    }

    // --------------------------------------------------------------- bash

    @Test
    fun bashOutputLoadsAPageAndReportsTooLargeOutput() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        api.bashOutputResults["/tmp/full.txt"] = BashOutputResult.Text("line one\nline two")
        vm.loadBashOutput("/tmp/full.txt")
        runCurrent()
        assertEquals(
            BashOutputUi.Ready("line one\nline two"),
            vm.ui.value.bashOutputs["/tmp/full.txt"],
        )
        assertEquals(listOf("/tmp/full.txt"), api.bashOutputPaths)

        // A second request for a loaded path is not refetched.
        vm.loadBashOutput("/tmp/full.txt")
        runCurrent()
        assertEquals(1, api.bashOutputPaths.size)

        api.bashOutputResults["/tmp/huge.log"] = BashOutputResult.TooLarge(5_000_000, 1_000_000)
        vm.loadBashOutput("/tmp/huge.log")
        runCurrent()
        val error = vm.ui.value.bashOutputs["/tmp/huge.log"] as BashOutputUi.Error
        assertTrue("the size is named: ${error.message}", error.message.contains("too large"))
        assertTrue("the size is named: ${error.message}", error.message.contains("4.8 MB"))
    }

    @Test
    fun bashOutputBytesAreReturnedForTheSafeDownload() = chatTest {
        createViewModel()
        vm.open("s1", null)
        runCurrent()

        val payload = ByteArray(2048) { (it % 251).toByte() }
        api.bashOutputBytesPayload = payload
        var bytes: ByteArray? = null
        launch { bytes = vm.bashOutputBytes("/tmp/raw.log") }
        runCurrent()

        assertTrue("the download returns the raw bytes", bytes!!.contentEquals(payload))
        assertEquals("/tmp/raw.log", api.bashOutputBytesPath)
    }

    // ----------------------------------------------------------------- fakes

    private class FakeApi : ChatApi {
        var contextPage: JsonObject = page("s1", emptyList())
        var promptFailure: Exception? = null
        var abortFailure: Exception? = null
        var forkOutcome: ForkOutcome = ForkOutcome(cancelled = true)
        var forkFailure: Exception? = null
        var agentState: JsonObject = parse("""{"running":false,"state":{"isStreaming":false,"isPromptRunning":false}}""")
        var agentStateGate: CompletableDeferred<JsonObject>? = null
        /** Holds only the named session's answer; other sessions answer at once. */
        val agentStateGates = mutableMapOf<String, CompletableDeferred<JsonObject>>()
        /** Session of every `GET /api/agent/{id}`, in order. */
        val agentStateSessions = mutableListOf<String>()
        var agentStateFailure: Exception? = null
        /** Reads that ended with a [kotlinx.coroutines.CancellationException]. */
        var agentStateCancelled = 0
        /** Failure for every `contextFull` call; the response is [contextPage] otherwise. */
        var contextFullFailure: Exception? = null

        /** Holds the history answer until the test releases it (cache-first ordering). */
        var contextGate: CompletableDeferred<Unit>? = null
        val prompts = mutableListOf<Pair<String, String>>()
        /** `?force=1` of every prompt, in order (the copy override). */
        val promptForces = mutableListOf<Boolean>()
        val steers = mutableListOf<Pair<String, String>>()
        val followUps = mutableListOf<Pair<String, String>>()
        /** `(session, command, excludeFromContext)` for every `bash` RPC. */
        val bashCalls = mutableListOf<Triple<String, String, Boolean>>()
        var agentStateCalls = 0
        var contextFullCalls = 0
        var contextSyncCalls = 0
        var subagentCompletionCalls = 0
        var subagentTranscriptCalls = 0
        /** `leafId` of every `contextFull`/`contextSync` request, in order. */
        val contextFullLeafIds = mutableListOf<String?>()
        val contextSyncLeafIds = mutableListOf<String?>()
        /** `includePreCompaction` of every `contextFull`/`contextSync` request. */
        val contextPreCompaction = mutableListOf<Boolean>()
        val forkCalls = mutableListOf<Pair<String, String>>()
        /** Failure for the `/compact` builtin (the ownership gate's 409). */
        var compactFailure: Exception? = null
        var compactCalls = 0
        val bashOutputPaths = mutableListOf<String>()
        val bashOutputResults = mutableMapOf<String, BashOutputResult>()
        var bashOutputBytesPath: String? = null
        var bashOutputBytesPayload: ByteArray = ByteArray(0)

        override suspend fun prompt(
            sessionId: String,
            message: String,
            images: List<ComposerImage>,
            streamingBehavior: String?,
            force: Boolean,
        ): JsonElement? {
            prompts += sessionId to message
            promptForces += force
            promptFailure?.let { throw it }
            return null
        }

        override suspend fun agentState(sessionId: String): JsonObject {
            agentStateCalls++
            agentStateSessions += sessionId
            try {
                agentStateGates[sessionId]?.let { return it.await() }
                agentStateGate?.let { return it.await() }
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                agentStateCancelled++
                throw cancelled
            }
            agentStateFailure?.let { throw it }
            return agentState
        }

        /** `runningSessionIds` of the slow-answer fallback: empty = idle. */
        var runningIds: List<String> = emptyList()
        var runningIdsCalls = 0

        override suspend fun runningSessionIds(): List<String> {
            runningIdsCalls++
            return runningIds
        }

        override suspend fun abort(sessionId: String): JsonElement? {
            abortFailure?.let { throw it }
            return null
        }

        override suspend fun contextSync(
            sessionId: String,
            cursor: String?,
            leafId: String?,
            includePreCompaction: Boolean,
            deferThinking: Boolean,
            deferMedia: Boolean,
        ): JsonObject {
            contextSyncCalls++
            contextSyncLeafIds += leafId
            contextPreCompaction += includePreCompaction
            return contextPage
        }

        override suspend fun contextFull(
            sessionId: String,
            leafId: String?,
            includePreCompaction: Boolean,
            deferThinking: Boolean,
            deferMedia: Boolean,
        ): JsonObject {
            contextFullCalls++
            contextFullLeafIds += leafId
            contextPreCompaction += includePreCompaction
            contextGate?.await()
            contextFullFailure?.let { throw it }
            return contextPage
        }

        override suspend fun sessionDetail(id: String): SessionDetail = SessionDetail(sessionId = id)

        override suspend fun githubRepo(cwd: String): String? = null

        override suspend fun forkSession(sessionId: String, entryId: String): ForkOutcome {
            forkCalls += sessionId to entryId
            forkFailure?.let { throw it }
            return forkOutcome
        }

        override suspend fun thinking(sessionId: String, entryId: String, blockIndex: Int): String = ""

        override suspend fun bashOutput(sessionId: String, path: String): BashOutputResult {
            bashOutputPaths += path
            return bashOutputResults[path] ?: BashOutputResult.Text("")
        }

        override suspend fun bashOutputBytes(sessionId: String, path: String): ByteArray {
            bashOutputBytesPath = path
            return bashOutputBytesPayload
        }

        override suspend fun subagentCompletion(sessionId: String, subagentId: String): SubagentCompletion {
            subagentCompletionCalls++
            return SubagentCompletion()
        }

        override suspend fun abortRetry(sessionId: String): JsonElement? = null

        override suspend fun steer(
            sessionId: String,
            message: String,
            images: List<ComposerImage>,
        ): JsonElement? {
            steers += sessionId to message
            return null
        }

        override suspend fun followUp(
            sessionId: String,
            message: String,
            images: List<ComposerImage>,
        ): JsonElement? {
            followUps += sessionId to message
            return null
        }

        override suspend fun bash(
            sessionId: String,
            command: String,
            excludeFromContext: Boolean,
        ): JsonElement? {
            bashCalls += Triple(sessionId, command, excludeFromContext)
            return null
        }

        override suspend fun abortBash(sessionId: String): JsonElement? = null

        override suspend fun abortAndRestoreQueue(sessionId: String): QueueRestore {
            abortFailure?.let { throw it }
            return QueueRestore()
        }

        override suspend fun removeQueuedMessage(
            sessionId: String,
            message: String,
            queue: String,
        ): QueuedMessageRemoval = QueuedMessageRemoval(removed = false)

        override suspend fun promoteQueuedMessage(sessionId: String, message: String): Boolean = false

        override suspend fun commands(sessionId: String): List<SlashCommandItem> = emptyList()

        override suspend fun compact(sessionId: String, customInstructions: String?): JsonElement? {
            compactCalls += 1
            compactFailure?.let { throw it }
            return null
        }

        override suspend fun reload(sessionId: String): JsonElement? = null

        override suspend fun setSessionName(sessionId: String, name: String): JsonElement? = null

        override suspend fun lastAssistantText(sessionId: String): String? = null

        override suspend fun skills(cwd: String): SkillsResponse = SkillsResponse()

        override suspend fun subagents(sessionId: String): JsonElement? = null

        override suspend fun subagentHistory(sessionId: String): JsonElement? = null

        override suspend fun subagentTranscript(
            sessionId: String,
            subagentId: String,
            sessionFile: String?,
            fromByte: Long,
        ): JsonElement? {
            subagentTranscriptCalls++
            return null
        }

        override suspend fun subagentTranscriptDisk(
            sessionId: String,
            subagentId: String,
            fromByte: Long,
        ): JsonElement? {
            subagentTranscriptCalls++
            return null
        }

        override suspend fun validateCwd(cwd: String): CwdValidation = CwdValidation.Valid(cwd, null)
    }

    /**
     * One process-wide stream like [EventMux]: a new collector starts a new
     * server subscription, and the server replays its pending UI requests to it
     * (`rpc-manager.onEvent`) before the live frames continue.
     */
    private class FakeEvents : SessionEventSource {
        override val state = MutableStateFlow(ConnectionState.Connected)
        val frames = MutableSharedFlow<JsonObject>(extraBufferCapacity = 64)

        /** What the server still holds as open `extension_ui_request`s. */
        val pending = mutableListOf<JsonObject>()

        override fun subscribe(channel: EventChannel): Flow<JsonObject> = flow {
            for (frame in pending) emit(frame)
            emitAll(frames)
        }
    }

    private class FakeExtensionApi : ExtensionApi {
        val commands = mutableListOf<Pair<String, JsonObject>>()

        /** When set, the send waits for it; a completed failure throws after it. */
        var gate: CompletableDeferred<Unit>? = null
        var failure: Exception? = null

        override suspend fun command(sessionId: String, command: JsonObject): JsonElement? {
            gate?.await()
            failure?.let { throw it }
            commands += sessionId to command
            return null
        }
    }

    private class FakeSpeech : Speech {
        private val mutableState = MutableStateFlow(SpeechState())
        override val state: StateFlow<SpeechState> = mutableState
        val spoken = mutableListOf<Pair<String, String>>()

        override fun prepare() = Unit

        override fun setVoice(name: String?) = Unit

        override fun speak(id: String, text: String) {
            spoken += id to text
            mutableState.value = SpeechState(speakingId = id)
        }

        override fun toggle(id: String, text: String) {
            if (mutableState.value.speakingId == id) {
                mutableState.value = SpeechState()
            } else {
                speak(id, text)
            }
        }

        override fun stop() {
            mutableState.value = SpeechState()
        }

        override fun shutdown() {
            mutableState.value = SpeechState()
        }
    }

    private companion object {
        const val MAYBE_STARTED = "omp is busy — your message may still be running."
        const val SHELL_NO_SESSION = "No session to run that command in."
        const val LIVE_STATE_UNKNOWN =
            "Could not check whether the agent is running — your message stays in the composer."
        const val SUBMIT_ABANDONED =
            "The chat was left before the agent's state arrived — nothing was sent, the draft stays."
        const val FOREIGN_BLOCKED =
            "Another omp process is running this chat — the message was not sent."
        const val FOREIGN_COMMAND_BLOCKED =
            "Another omp process is running this chat — the command was not applied."
        const val LIVE_STATE_SUBMIT_TIMEOUT = 10_000L
        const val STOP_UNCONFIRMED = "Stop not confirmed yet — omp is busy."
        const val RECONCILE_MILLIS = 15_000L
        const val USER_HELLO =
            """{"role":"user","content":[{"type":"text","text":"hello"}],"timestamp":1000,"attribution":"user"}"""
        const val USER_FIRST =
            """{"role":"user","content":[{"type":"text","text":"first"}],"timestamp":1000,"attribution":"user"}"""
        const val ASSISTANT_HI =
            """{"role":"assistant","content":[{"type":"text","text":"hi"}],"timestamp":1001,"stopReason":"stop"}"""
        const val ASSISTANT_THINKING =
            """{"role":"assistant","content":[{"type":"thinking","thinking":"secret haystack reasoning"},""" +
                """{"type":"text","text":"done"}],"timestamp":1001,"stopReason":"stop"}"""
        // Text + tool call: the turn folds into one group row, so both
        // messages of the turn share the row the search marks.
        const val ASSISTANT_FOLDED_MATCH =
            """{"role":"assistant","content":[{"type":"text","text":"needle in the answer"},""" +
                """{"type":"toolCall","toolCallId":"c1","toolName":"read","input":{"path":"x"}}],""" +
                """"timestamp":1001,"stopReason":"toolUse"}"""
        const val ASSISTANT_FIRST =
            """{"role":"assistant","content":[{"type":"text","text":"first answer"}],"timestamp":1001,""" +
                """"stopReason":"stop"}"""

        /** One `ask` question, exactly as omp sends it (web `ExtensionDialog`). */
        const val ASK_FRAME =
            """{"type":"extension_ui_request","id":"ask-1","method":"ask","questions":[{""" +
                """"id":"color","question":"Which colour?","multi":false,""" +
                """"options":[{"label":"Red"},{"label":"Green"}]}]}"""

        const val HOST_READ_FRAME =
            """{"type":"host_uri_request","id":"clip-1","operation":"read","url":"pi-web://clipboard"}"""

        const val OPEN_URL_FRAME =
            """{"type":"extension_ui_request","method":"open_url","url":"https://example.com/page"}"""

        private val json = Json { ignoreUnknownKeys = true }

        fun parse(text: String): JsonObject = json.parseToJsonElement(text).jsonObject

        /** A replace-mode context page whose entry ids align with [messages]. */
        private fun page(sessionId: String, messages: List<String>): JsonObject {
            val ids = messages.indices.joinToString(",") { "\"e$it\"" }
            return parse(
                """{"sessionId":"$sessionId","mode":"replace","hasMore":false,""" +
                    """"context":{"entryIds":[$ids],"messages":[${messages.joinToString(",")}]}}""",
            )
        }
    }
}
