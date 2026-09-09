import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// useAgentSession.ts owns the chat state machine. These are source-contract
// tests pinning the two navigation-sensitive advisor/new-chat behaviors.

test("abandoned new-chat send delivers the prompt without promoting", async () => {
  const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
  // Spawning takes seconds; navigating away mid-spawn unmounts the sender.
  // Promoting then would yank the fresh chat into the old session's history.
  assert.match(source, /const ownerGone = !hookAliveRef\.current/);
  assert.match(source, /if \(!ownerGone\) promoteNewSession\(1, message\)/);
  // Attaching an EventSource on a dead instance leaks it: unmount cleanup
  // already ran, so nothing would ever close the stream.
  assert.match(source, /if \(!ownerGone\) \{\s*\n\s*await ensureEventsConnected\(sid\);/);
});

test("fork carries the advisor choice to the new session id", async () => {
  const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
  // The forked child keeps its spawn flags; without propagation the toggle
  // flips off on switch and the next prompt respawns without --advisor.
  assert.match(source, /setSessionAdvisorSpawn\(newSessionId, true\)/);
  assert.match(source, /omp-advisor-enabled:\$\{newSessionId\}/);
});

test("a CLOSED event stream retries with backoff even while the agent is idle", async () => {
  const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
  // EventSource gives up on fatal errors; without a manual retry an idle
  // session whose stream died (server hiccup, wrapper respawn) stays dead
  // silently until a full page reload. The retry must not be gated on
  // agentRunningRef — only on the session still being selected.
  assert.match(source, /reconnectTimerRef\.current = setTimeout\(\(\) => \{\s*\n\s*reconnectTimerRef\.current = undefined;\s*\n\s*if \(sessionIdRef\.current === sid\) \{\s*\n\s*void connectEvents\(sid\);/);
  // Backoff doubles per failure and caps, so a persistently failing endpoint
  // (e.g. a 409 wrapper-less session) cannot tight-loop.
  assert.match(source, /eventStreamRetryMsRef\.current = Math\.min\(delay \* 2, EVENT_STREAM_RETRY_MAX_MS\)/);
  // A successful open resets the backoff to the floor.
  assert.match(source, /es\.onopen = \(\) => \{\s*\n\s*eventStreamRetryMsRef\.current = EVENT_STREAM_RETRY_MIN_MS;/);
});
