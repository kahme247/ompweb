import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { act, cleanup, renderHook } from "@testing-library/react/pure.js";

// These tests execute the dictation state machine against fake
// getUserMedia/MediaRecorder/AudioContext implementations. They assert the
// observable hook state a consumer renders from (isRecording/isPaused/
// isReviewing, live analyser, active-time accounting, blob-URL lifetime) —
// the states the composer and RecordingDeck actually read.

const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const { useDictation } = await jiti.import("../hooks/useDictation.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Settles until `condition` holds; fails after `timeoutMs` instead of racing a fixed sleep. */
async function waitUntil(condition, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await settle(20);
  }
}

async function settle(ms = 20) {
  await act(async () => {
    await sleep(ms);
  });
}

let world;

class FakeTrack {
  constructor() {
    this.stopped = false;
  }
  stop() {
    this.stopped = true;
  }
}

class FakeMediaRecorder {
  constructor(stream) {
    this.stream = stream;
    this.state = "inactive";
    this.mimeType = "audio/webm";
    this.timeslice = null;
    this.ondataavailable = null;
    this.onstop = null;
    world.recorders.push(this);
  }
  start(timeslice) {
    this.state = "recording";
    this.timeslice = timeslice ?? null;
  }
  requestData() {
    this.ondataavailable?.({ data: new Blob(["chunk"], { type: this.mimeType }) });
  }
  pause() {
    this.state = "paused";
  }
  resume() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["chunk"], { type: this.mimeType }) });
    this.onstop?.();
  }
}

class FakeAudioContext {
  constructor() {
    this.state = "running";
    this.closed = false;
  }
  createMediaStreamSource() {
    return { connect: () => {} };
  }
  createAnalyser() {
    return {
      fftSize: 2048,
      frequencyBinCount: 128,
      getByteFrequencyData: () => {},
      connect: () => {},
    };
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

class FakePreviewAudio {
  constructor(src) {
    this.src = src;
    world.audioUrls.push(src);
    this.currentTime = 0;
    this.duration = 1;
    this.ended = false;
    this.paused = true;
  }
  play() {
    this.paused = false;
    this.onplay?.();
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.onpause?.();
  }
}

const overrides = [];
function override(target, key, replacement) {
  overrides.push({ target, key, original: Object.getOwnPropertyDescriptor(target, key) });
  Object.defineProperty(target, key, { configurable: true, writable: true, value: replacement });
}

beforeEach(() => {
  world = { recorders: [], createdUrls: [], revokedUrls: [], tracks: [] };
  const track = new FakeTrack();
  world.tracks.push(track);
  override(navigator, "mediaDevices", {
    getUserMedia: async () => ({ getTracks: () => [track] }),
  });
  override(window, "MediaRecorder", FakeMediaRecorder);
  override(globalThis, "MediaRecorder", FakeMediaRecorder);
  override(window, "AudioContext", FakeAudioContext);
  override(globalThis, "AudioContext", FakeAudioContext);
  override(window, "Audio", FakePreviewAudio);
  override(globalThis, "Audio", FakePreviewAudio);
  override(URL, "createObjectURL", (blob) => {
    const url = `blob:fake/${world.createdUrls.length}`;
    world.createdUrls.push({ url, blob });
    return url;
  });
  override(URL, "revokeObjectURL", (url) => {
    world.revokedUrls.push(url);
  });
  // Fake job API. POST /api/stt starts job-1 and keeps its `after` intent and
  // `owner` token, as the server does; each GET poll answers with the next
  // scripted response (the last one repeating); a claiming DELETE takes the
  // last polled body plus the kept intent; POST /api/stt/job-1 is a retry.
  world.pollResponses = [{ ok: true, status: 200, json: async () => ({ status: "done", text: "transcribed words" }) }];
  world.polls = 0;
  world.lastPoll = null;
  world.postedFiles = [];
  world.deletes = [];
  world.retries = 0;
  world.retryResponse = { ok: true, status: 200, json: async () => ({ status: "pending" }) };
  world.scopeJobs = [];
  world.audioUrls = [];
  world.uploadGate = null;
  world.postedAfter = null;
  world.postedOwner = null;
  world.claims = [];
  // Optional scripted claim answers (shifted per claim) before the default.
  world.claimResponses = [];
  override(globalThis, "fetch", async (url, init) => {
    if (url.startsWith("/api/stt?scope=")) return { ok: true, status: 200, json: async () => ({ jobs: world.scopeJobs }) };
    if (init?.method === "POST" && url === "/api/stt") {
      world.postedFiles.push(init.body.get("file"));
      world.postedAfter = init.body.get("after");
      world.postedOwner = init.body.get("owner");
      await world.uploadGate;
      return { ok: true, status: 202, json: async () => ({ jobId: "job-1" }) };
    }
    if (init?.method === "POST") {
      world.retries++;
      return world.retryResponse;
    }
    if (init?.method === "DELETE") {
      world.deletes.push(url);
      const query = new URL(url, "http://localhost").searchParams;
      const claim = query.get("claim");
      if (claim) world.claims.push({ claim, owner: query.get("owner") });
      // As the server: only the job's owner gets the send/queue choice back.
      const after = query.get("owner") === world.postedOwner ? world.postedAfter ?? undefined : undefined;
      const scripted = claim ? world.claimResponses.shift() : undefined;
      const claimed = claim ? scripted ?? { ...(await world.lastPoll?.json()), after } : null;
      return { ok: true, status: 200, json: async () => claimed ?? { status: "gone" } };
    }
    assert.equal(url, "/api/stt/job-1");
    world.lastPoll = world.pollResponses[Math.min(world.polls++, world.pollResponses.length - 1)];
    return world.lastPoll;
  });
});

afterEach(() => {
  try {
    cleanup();
  } finally {
    while (overrides.length) {
      const { target, key, original } = overrides.pop();
      if (original) Object.defineProperty(target, key, original);
      else delete target[key];
    }
  }
});

function mountDictation(scope) {
  const transcripts = [];
  const errors = [];
  const view = renderHook(() =>
    useDictation({
      scope,
      onTranscript: (text) => transcripts.push(text),
      onError: (message) => errors.push(message),
    }),
  );
  return { view, transcripts, errors };
}

test("starting capture puts the hook in the recording state with a live analyser", async () => {
  const { view, errors } = mountDictation();

  await act(async () => {
    view.result.current.toggle();
  });
  await settle();

  assert.equal(errors.length, 0, `unexpected dictation errors: ${errors.join(" | ")}`);
  assert.equal(view.result.current.isRecording, true, "consumer must see isRecording after start");
  assert.equal(view.result.current.isPaused, false);
  assert.equal(view.result.current.isReviewing, false);
  assert.equal(world.recorders.length, 1);
  assert.equal(world.recorders[0].state, "recording");
  assert.equal(world.recorders[0].timeslice, 100, "timeslice keeps chunks flowing for preview");
  assert.notEqual(view.result.current.captureRef.current.analyser, null, "waveform needs a live analyser");
  assert.ok(view.result.current.captureRef.current.startedAt > 0, "timer needs a start stamp");
});

test("pause then resume keeps the timer base and analyser while accumulating paused time", async () => {
  const { view } = mountDictation();

  await act(async () => {
    view.result.current.toggle();
  });
  await settle();

  const { startedAt, analyser } = view.result.current.captureRef.current;

  await act(async () => {
    view.result.current.togglePause();
  });
  await settle(40);

  assert.equal(view.result.current.isPaused, true);
  assert.ok(view.result.current.captureRef.current.pausedAt !== null);

  await act(async () => {
    view.result.current.togglePause();
  });
  await settle();

  const capture = view.result.current.captureRef.current;
  assert.equal(view.result.current.isPaused, false);
  assert.equal(capture.startedAt, startedAt, "resume must not reset the elapsed base");
  assert.equal(capture.analyser, analyser, "resume must not drop the live analyser");
  assert.equal(capture.pausedAt, null);
  assert.ok(capture.pausedAccum > 0, "paused time must be subtracted from active elapsed time");
  assert.equal(world.recorders[0].state, "recording");
});

test("stopping capture enters review with a playable preview, and confirming releases it", async () => {
  const { view, transcripts } = mountDictation();

  await act(async () => {
    view.result.current.toggle();
  });
  await settle();

  await act(async () => {
    view.result.current.stop();
  });
  await settle();

  assert.equal(view.result.current.isReviewing, true);
  assert.equal(view.result.current.isRecording, false);
  assert.equal(world.createdUrls.length, 1, "review mode needs a preview blob URL");
  assert.ok(world.tracks[0].stopped, "microphone tracks must be released on stop");

  await act(async () => {
    view.result.current.playPreview();
  });
  await settle();
  assert.equal(view.result.current.isPlayingPreview, true);

  await act(async () => {
    view.result.current.confirmTranscribe();
  });
  await waitUntil(() => transcripts.length === 1);

  assert.deepEqual(world.revokedUrls, [world.createdUrls[0].url], "confirming must revoke the preview URL");
  assert.equal(view.result.current.isReviewing, false);
  assert.deepEqual(transcripts, ["transcribed words"]);
});

test("transcription keeps polling through pending and proxy error pages until the job is done", async () => {
  const { view, transcripts, errors } = mountDictation();
  world.pollResponses = [
    { ok: true, status: 200, json: async () => ({ status: "pending" }) },
    { ok: false, status: 504, json: async () => JSON.parse("<!DOCTYPE html>") },
    { ok: true, status: 200, json: async () => ({ status: "done", text: "slow words" }) },
  ];

  await act(async () => {
    view.result.current.toggle();
  });
  await settle();
  await act(async () => {
    view.result.current.stop();
  });
  await settle();
  await act(async () => {
    view.result.current.confirmTranscribe();
  });
  await waitUntil(() => transcripts.length === 1);

  assert.deepEqual(errors, []);
  assert.deepEqual(transcripts, ["slow words"]);
  assert.equal(world.polls, 3);
  assert.equal(view.result.current.isTranscribing, false);
});

async function recordAndTranscribe(view) {
  await act(async () => {
    view.result.current.toggle();
  });
  await settle();
  await act(async () => {
    view.result.current.stop();
  });
  await settle();
  await act(async () => {
    view.result.current.confirmTranscribe();
  });
  await waitUntil(() => world.polls >= 1);
  await settle(50);
}

test("retry reruns a failed job on the server with the audio it kept", async () => {
  const { view, transcripts, errors } = mountDictation();
  world.pollResponses = [{ ok: true, status: 200, json: async () => ({ status: "error", error: "Transcription timed out" }) }];

  await recordAndTranscribe(view);

  assert.deepEqual(transcripts, []);
  assert.deepEqual(errors, ["Transcription timed out"]);
  assert.equal(view.result.current.transcribeError, "Transcription timed out");

  world.pollResponses = [{ ok: true, status: 200, json: async () => ({ status: "done", text: "second try" }) }];
  await act(async () => {
    view.result.current.retry();
  });
  await waitUntil(() => transcripts.length === 1);

  assert.equal(world.retries, 1);
  assert.equal(world.postedFiles.length, 1, "the server's copy is retried, not a re-upload");
  assert.deepEqual(transcripts, ["second try"]);
});

test("retry re-uploads the local recording when the server lost the job", async () => {
  const { view, transcripts } = mountDictation();
  world.pollResponses = [{ ok: true, status: 200, json: async () => ({ status: "error", error: "boom" }) }];
  await recordAndTranscribe(view);

  world.retryResponse = { ok: false, status: 404, json: async () => ({ error: "Transcription job not found" }) };
  world.pollResponses = [{ ok: true, status: 200, json: async () => ({ status: "done", text: "re-uploaded" }) }];
  await act(async () => {
    view.result.current.retry();
  });
  await waitUntil(() => transcripts.length === 1);

  assert.equal(world.postedFiles.length, 2);
  assert.equal(await world.postedFiles[1].text(), await world.postedFiles[0].text());
  assert.deepEqual(transcripts, ["re-uploaded"]);
});

test("another browser's job for the same scope shows up with server audio, and a claim lost to it stands down", async () => {
  world.scopeJobs = [{ id: "job-1", status: "error", error: "model loading" }];
  const { view, transcripts, errors } = mountDictation("session-1");
  await settle(50);

  assert.equal(view.result.current.transcribeError, "model loading");
  await act(async () => {
    view.result.current.playPreview();
  });
  assert.deepEqual(world.audioUrls, ["/api/stt/job-1/audio"]);

  // Retry here; meanwhile the recording browser claims the transcript first.
  world.pollResponses = [{ ok: true, status: 200, json: async () => ({ status: "gone" }) }];
  await act(async () => {
    view.result.current.retry();
  });
  await waitUntil(() => world.polls >= 1 && !view.result.current.isTranscribing);

  assert.equal(world.retries, 1);
  assert.deepEqual(transcripts, []);
  assert.deepEqual(errors, [], "losing the claim to another browser is not an error");
  assert.equal(view.result.current.transcribeError, null);
  assert.equal(view.result.current.isTranscribing, false);
});

test("a finished job is claimed without newer browser APIs, and only the claimed text is inserted", async () => {
  override(AbortSignal, "timeout", undefined);
  override(AbortSignal, "any", undefined);
  override(Promise, "withResolvers", undefined);
  world.scopeJobs = [{ id: "job-1", status: "pending" }];
  world.pollResponses = [{ ok: true, status: 200, json: async () => ({ status: "done", text: "from the phone" }) }];
  const { view, transcripts } = mountDictation("session-1");
  await waitUntil(() => transcripts.length === 1);

  assert.deepEqual(transcripts, ["from the phone"]);
  assert.equal(world.deletes.length, 1);
  assert.match(world.deletes[0], /^\/api\/stt\/job-1\?claim=/);
  assert.equal(view.result.current.isTranscribing, false);
});

test("a permanent 4xx poll fails at once instead of polling until the deadline", async () => {
  const { view, transcripts, errors } = mountDictation();
  world.pollResponses = [{ ok: false, status: 401, json: async () => ({ error: "Password required" }) }];

  await recordAndTranscribe(view);

  assert.deepEqual(transcripts, []);
  assert.deepEqual(errors, ["Password required"]);
  assert.equal(world.polls, 1);
  assert.equal(view.result.current.isTranscribing, false);
});

test("cancelling mid-transcription stops polling and drops a late result", async () => {
  const { view, transcripts, errors } = mountDictation();
  world.pollResponses = [
    { ok: true, status: 200, json: async () => ({ status: "pending" }) },
    { ok: true, status: 200, json: async () => ({ status: "done", text: "too late" }) },
  ];

  await recordAndTranscribe(view);
  assert.equal(world.polls, 1);
  assert.equal(view.result.current.isTranscribing, true);

  await act(async () => {
    view.result.current.cancel();
  });
  await settle(1200);

  assert.equal(world.polls, 1, "no poll may run after cancel");
  assert.deepEqual(world.deletes, ["/api/stt/job-1"], "discard must end the job for other browsers too");
  assert.deepEqual(transcripts, []);
  assert.deepEqual(errors, []);
  assert.equal(view.result.current.isTranscribing, false);
});

test("cancelling during capture clears state and releases the microphone", async () => {
  const { view, transcripts } = mountDictation();

  await act(async () => {
    view.result.current.toggle();
  });
  await settle();

  await act(async () => {
    view.result.current.cancel();
  });
  await settle();

  assert.equal(view.result.current.isRecording, false);
  assert.equal(view.result.current.isPaused, false);
  assert.equal(view.result.current.isReviewing, false);
  assert.equal(view.result.current.isTranscribing, false);
  assert.equal(view.result.current.captureRef.current.analyser, null);
  assert.ok(world.tracks[0].stopped);
  assert.deepEqual(transcripts, []);
});

test("unmounting while a job runs leaves the job for other browsers", async () => {
  const { view } = mountDictation("session-1");
  world.pollResponses = [{ ok: true, status: 200, json: async () => ({ status: "pending" }) }];
  await recordAndTranscribe(view);
  assert.equal(view.result.current.isTranscribing, true);

  view.unmount();
  await settle(600);

  assert.deepEqual(world.deletes, [], "navigating away must not discard the job");
});

test("a job from another browser is not adopted over an active recording", async () => {
  const { view } = mountDictation("session-1");
  await settle(50);
  await act(async () => {
    view.result.current.toggle();
  });
  await settle();

  world.scopeJobs = [{ id: "job-1", status: "error", error: "model loading" }];
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  await settle(50);

  assert.equal(view.result.current.isRecording, true);
  assert.equal(view.result.current.transcribeError, null);
});

test("a browser left open picks up a job started elsewhere without a focus change", async () => {
  world.pollResponses = [{ ok: true, status: 200, json: async () => ({ status: "done", text: "started elsewhere" }) }];
  const { transcripts } = mountDictation("session-1");
  await settle(50);
  assert.deepEqual(transcripts, []);

  world.scopeJobs = [{ id: "job-1", status: "pending" }];
  await waitUntil(() => transcripts.length === 1, 6000);
  assert.deepEqual(transcripts, ["started elsewhere"]);
});

test("switching sessions stops following the old job without discarding it", async () => {
  world.scopeJobs = [{ id: "job-1", status: "pending" }];
  world.pollResponses = [{ ok: true, status: 200, json: async () => ({ status: "pending" }) }];
  const transcripts = [];
  const view = renderHook(({ scope }) => useDictation({ scope, onTranscript: (text) => transcripts.push(text) }), {
    initialProps: { scope: "session-a" },
  });
  await waitUntil(() => world.polls >= 1);
  assert.equal(view.result.current.isTranscribing, true);

  world.scopeJobs = [];
  view.rerender({ scope: "session-b" });
  await settle(50);
  const pollsAtSwitch = world.polls;
  world.pollResponses = [{ ok: true, status: 200, json: async () => ({ status: "done", text: "for A" }) }];
  await settle(1200);

  assert.equal(view.result.current.isTranscribing, false);
  assert.equal(world.polls, pollsAtSwitch, "session B must not keep polling A's job");
  assert.deepEqual(transcripts, [], "A's transcript must not land in B's composer");
  assert.deepEqual(world.deletes, [], "the job stays adoptable from session A");
});

/** Holds the upload POST until the returned function is called. */
function holdUpload() {
  const gate = Promise.withResolvers();
  world.uploadGate = gate.promise;
  return gate.resolve;
}

test("discarding during the upload ends the job once the server answers", async () => {
  const { view, transcripts } = mountDictation("session-1");
  const release = holdUpload();
  await recordAndTranscribeUntilUpload(view);

  await act(async () => {
    view.result.current.cancel();
  });
  release();
  await waitUntil(() => world.deletes.length === 1);

  assert.deepEqual(world.deletes, ["/api/stt/job-1"]);
  assert.equal(world.polls, 0);
  assert.deepEqual(transcripts, []);
});

test("switching sessions during the upload keeps the job but never delivers it here", async () => {
  const transcripts = [];
  const view = renderHook(({ scope }) => useDictation({ scope, onTranscript: (text) => transcripts.push(text) }), {
    initialProps: { scope: "session-a" },
  });
  const release = holdUpload();
  await recordAndTranscribeUntilUpload(view);

  view.rerender({ scope: "session-b" });
  await settle(50);
  assert.equal(view.result.current.isTranscribing, false);
  release();
  await settle(1200);

  assert.equal(world.polls, 0, "session B must not follow A's job");
  assert.deepEqual(world.deletes, [], "A's job stays adoptable");
  assert.deepEqual(transcripts, []);
});

async function recordAndTranscribeUntilUpload(view) {
  await act(async () => {
    view.result.current.toggle();
  });
  await settle();
  await act(async () => {
    view.result.current.stop();
  });
  await settle();
  await act(async () => {
    view.result.current.confirmTranscribe();
  });
  await waitUntil(() => world.postedFiles.length === 1);
  assert.equal(view.result.current.isTranscribing, true);
}

test("a send started before leaving the session is still sent after coming back", async () => {
  const delivered = [];
  const mount = () =>
    renderHook(() => useDictation({ scope: "session-1", onTranscript: (text, after) => delivered.push([text, after]) }));
  world.pollResponses = [{ ok: true, status: 200, json: async () => ({ status: "pending" }) }];

  // Record and press send, then leave the session: AppShell remounts the
  // composer per session, so the hook instance is replaced.
  const first = mount();
  await act(async () => {
    first.result.current.toggle();
  });
  await settle();
  await act(async () => {
    first.result.current.stop({ after: "send" });
  });
  await waitUntil(() => world.polls >= 1);
  first.unmount();
  assert.deepEqual(world.deletes, [], "leaving must not discard the job");

  // Come back: a fresh instance adopts the job and must still send it, as the
  // job's owner, without waiting out another browser's grace period.
  world.scopeJobs = [{ id: "job-1", status: "pending" }];
  world.pollResponses = [{ ok: true, status: 200, json: async () => ({ status: "done", text: "spoken" }) }];
  mount();
  await waitUntil(() => delivered.length === 1);

  assert.deepEqual(delivered, [["spoken", "send"]]);
  assert.equal(world.postedAfter, "send");
  assert.deepEqual(world.claims.map((c) => c.owner), [world.postedOwner], "the tab keeps its owner token across remounts");
  assert.notEqual(world.claims[0].claim, world.postedOwner, "claims use a per-composer token, never the shared tab token");
});

test("send from the review deck keeps the send choice, even when a retry has to re-upload", async () => {
  const delivered = [];
  const errors = [];
  const view = renderHook(() => useDictation({
    scope: "session-1",
    onTranscript: (text, after) => delivered.push([text, after]),
    onError: (message) => errors.push(message),
  }));
  await act(async () => {
    view.result.current.toggle();
  });
  await settle();
  await act(async () => {
    view.result.current.stop();
  });
  await settle();
  assert.equal(view.result.current.isReviewing, true);

  world.pollResponses = [{ ok: true, status: 200, json: async () => ({ status: "error", error: "boom" }) }];
  await act(async () => {
    view.result.current.confirmTranscribe({ after: "send" });
  });
  await waitUntil(() => errors.length === 1);
  assert.equal(world.postedAfter, "send");

  // The server lost the job: retry re-uploads the local copy, still as a send.
  world.postedAfter = null;
  world.retryResponse = { ok: false, status: 404, json: async () => ({ error: "Transcription job not found" }) };
  world.pollResponses = [{ ok: true, status: 200, json: async () => ({ status: "done", text: "resent" }) }];
  await act(async () => {
    view.result.current.retry();
  });
  await waitUntil(() => delivered.length === 1);
  assert.equal(world.postedFiles.length, 2);
  assert.equal(world.postedAfter, "send");
  assert.deepEqual(delivered, [["resent", "send"]]);
});

test("a claim answered without text (another browser's grace window) keeps asking until the text arrives", async () => {
  const { view, transcripts, errors } = mountDictation();
  world.claimResponses = [{ status: "done" }, { status: "done" }];
  await recordAndTranscribe(view);
  await waitUntil(() => transcripts.length === 1);

  assert.deepEqual(errors, []);
  assert.deepEqual(transcripts, ["transcribed words"]);
  assert.equal(world.claims.length, 3);
});

test("starting a new recording discards the job the deck was showing, for every browser", async () => {
  const { view } = mountDictation();
  world.pollResponses = [{ ok: true, status: 200, json: async () => ({ status: "error", error: "boom" }) }];
  await recordAndTranscribe(view);
  await waitUntil(() => view.result.current.transcribeError === "boom");
  assert.deepEqual(world.deletes, []);

  await act(async () => {
    view.result.current.toggle();
  });
  await settle();

  assert.equal(view.result.current.isRecording, true);
  assert.deepEqual(world.deletes, ["/api/stt/job-1"]);
});

test("a lost job is an error for the browser that recorded it", async () => {
  const { view, transcripts, errors } = mountDictation();
  world.pollResponses = [{ ok: false, status: 404, json: async () => ({ error: "not found" }) }];

  await recordAndTranscribe(view);

  // Only this browser still holds the audio, so it is the only one that can
  // say "that failed" and offer a retry.
  assert.deepEqual(errors, ["not found"]);
  assert.deepEqual(transcripts, []);
});

test("a job from another browser that vanishes stands down instead of erroring", async () => {
  // Adopted from the session's job list, then the server has forgotten it: its
  // tombstone was pruned, or another browser claimed it. Neither is this
  // browser's failure, and it has no audio to retry with.
  world.pollResponses = [{ ok: false, status: 404, json: async () => ({ error: "not found" }) }];
  const { view, errors } = mountDictation("session-1");
  await settle(50);

  world.scopeJobs = [{ id: "job-1", status: "pending" }];
  await waitUntil(() => world.polls >= 1, 6000);

  assert.deepEqual(errors, []);
  assert.equal(world.polls, 1, "a 404 is final, not a poll until the deadline");
  assert.equal(view.result.current.isTranscribing, false);
  assert.equal(view.result.current.transcribeError, null);
});
