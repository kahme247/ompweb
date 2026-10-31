import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
const { act, cleanup, renderHook } = await import("@testing-library/react/pure.js");

const { useDictation } = await import("../hooks/useDictation.ts");

// Isolated routes keep the server's scope, owner grace, and first-claim-token
// rules. The clock runs hook timers without real-time sleeps or a live server.
let world;
const overrides = [];
function override(target, key, value) {
  overrides.push({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) });
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

async function advance(ms) {
  const end = world.now + ms;
  for (;;) {
    const next = [...world.timers.entries()]
      .filter(([, timer]) => timer.at <= end)
      .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
    if (!next) break;
    const [id, timer] = next;
    world.now = timer.at;
    if (timer.interval) timer.at += timer.interval;
    else world.timers.delete(id);
    await act(async () => {
      timer.callback();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
  }
  world.now = end;
  await flush();
}

class Recorder {
  constructor() {
    this.state = "inactive";
    this.mimeType = "audio/webm";
    world.recorders.push(this);
  }
  start() { this.state = "recording"; }
  requestData() { this.ondataavailable?.({ data: new Blob(["original recording"], { type: this.mimeType }) }); }
  pause() { this.state = "paused"; }
  resume() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    this.requestData();
    this.onstop?.();
  }
}

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function jobView(job) {
  return { id: job.id, status: job.status, ...(job.error ? { error: job.error } : {}) };
}

function addJob(scope, { owner = "other-tab", status = "pending", text = "foreign words", after } = {}) {
  const id = `job-${++world.sequence}`;
  const job = { id, scope, owner, status, text, after, doneAt: world.now, claimedBy: null };
  world.jobs.set(id, job);
  return job;
}

function complete(job, text = "original words") {
  job.status = "done";
  job.text = text;
  job.error = undefined;
  job.doneAt = world.now;
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  world = {
    now: 0, nextTimer: 0, timers: new Map(), sequence: 0, jobs: new Map(),
    uploads: [], claims: [], discards: [], retries: [], lists: [], polls: [],
    recorders: [], uploadGate: null, listFailure: null, retryFailure: null,
    claimFailures: 0, acknowledgements: [],
  };
  const schedule = (callback, ms = 0, interval = false) => {
    const id = ++world.nextTimer;
    world.timers.set(id, { callback, at: world.now + ms, interval: interval ? ms : 0 });
    return id;
  };
  override(window, "setTimeout", (callback, ms) => schedule(callback, ms));
  override(window, "clearTimeout", (id) => world.timers.delete(id));
  override(window, "setInterval", (callback, ms) => schedule(callback, ms, true));
  override(window, "clearInterval", (id) => world.timers.delete(id));
  override(navigator, "mediaDevices", { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) });
  override(window, "MediaRecorder", Recorder);
  override(globalThis, "MediaRecorder", Recorder);
  override(window, "AudioContext", undefined);
  override(document, "visibilityState", "visible");
  override(globalThis, "fetch", async (url, init = {}) => {
    const parsed = new URL(url, "https://omp.test");
    const method = init.method ?? "GET";
    if (parsed.pathname === "/api/stt" && method === "POST") {
      const body = init.body;
      const job = addJob(body.get("scope"), { owner: body.get("owner"), after: body.get("after") ?? undefined });
      world.uploads.push({ job, file: body.get("file") });
      const gate = world.uploadGate;
      if (gate) await gate.promise;
      world.acknowledgements.push(job.id);
      return response(202, { jobId: job.id });
    }
    if (parsed.pathname === "/api/stt") {
      const scope = parsed.searchParams.get("scope");
      world.lists.push(scope);
      if (world.listFailure) return response(world.listFailure, { error: "scope discovery unavailable" });
      return response(200, {
        jobs: [...world.jobs.values()].filter((job) => job.scope === scope && job.status !== "gone").reverse().map(jobView),
      });
    }
    const id = decodeURIComponent(parsed.pathname.slice("/api/stt/".length));
    const job = world.jobs.get(id);
    if (!job) return response(404, { error: "Transcription job not found" });
    if (method === "POST") {
      world.retries.push({ id, owner: parsed.searchParams.get("owner") });
      if (world.retryFailure) return response(world.retryFailure, { error: "retry unavailable" });
      if (job.status === "error") {
        job.status = "pending";
        job.error = undefined;
        job.owner = parsed.searchParams.get("owner");
      }
      return response(200, jobView(job));
    }
    if (method === "DELETE") {
      const claim = parsed.searchParams.get("claim");
      const owner = parsed.searchParams.get("owner");
      if (claim) {
        world.claims.push({ id, claim, owner });
        if (world.claimFailures-- > 0) throw new TypeError("temporary claim connection failure");
      } else world.discards.push(id);
      // Native closeSttJob returns an existing tombstone without changing its
      // claimed text/token, even for a token-less DELETE.
      if (job.status === "gone") {
        return response(200, claim && job.claimedBy === claim
          ? { ...jobView(job), status: "done", text: job.text, after: job.claimedAfter }
          : jobView(job));
      }
      if (!claim) {
        job.status = "gone";
        job.text = undefined;
        job.after = undefined;
        job.error = undefined;
        return response(200, jobView(job));
      }
      if (job.status !== "done" || (job.owner !== owner && world.now - job.doneAt < 15_000)) return response(200, jobView(job));
      job.claimedBy = claim;
      job.claimedAfter = job.owner === owner ? job.after : undefined;
      job.status = "gone";
      if (world.claimResponseLosses > 0) {
        world.claimResponseLosses--;
        throw new TypeError("claim accepted, but its response was lost");
      }
      return response(200, { id, status: "done", text: job.text, after: job.claimedAfter });
    }
    assert.equal(method, "GET");
    world.polls.push(id);
    return response(200, jobView(job));
  });
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  while (overrides.length) {
    const { target, key, descriptor } = overrides.pop();
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else delete target[key];
  }
});

function mount(scope, identityMove) {
  const transcripts = [];
  const errors = [];
  const view = renderHook(({ scope: currentScope, identityMove: move }) => useDictation({
    scope: currentScope,
    identityMove: move,
    onTranscript: (text, after) => transcripts.push({ scope: currentScope, text, after }),
    onError: (message) => errors.push(message),
  }), { initialProps: { scope, identityMove } });
  return { view, transcripts, errors };
}

async function upload(view, after = "send") {
  await act(async () => { await view.result.current.start(); });
  await act(async () => { view.result.current.stop({ after }); });
  await flush();
  return world.uploads.at(-1).job;
}

function move(view, from, to) {
  view.rerender({ scope: to, identityMove: { from, to } });
}

function associations() {
  return Object.keys(sessionStorage).filter((key) => key.startsWith("omp-web:stt-moved-job:"));
}

test("an uploaded job survives Edit, navigation, and a fresh B hook without appearing in A or an unrelated scope", async () => {
  const original = mount("A");
  await flush();
  const job = await upload(original.view, "followup");
  const owner = world.uploads[0].job.owner;
  move(original.view, "A", "B");
  await advance(500);
  original.view.unmount();

  const old = mount("A");
  const unrelated = mount("unrelated");
  await flush();
  complete(job);
  await advance(1000);
  assert.deepEqual(old.transcripts, []);
  assert.deepEqual(unrelated.transcripts, []);
  assert.deepEqual(original.transcripts, []);
  old.view.unmount();
  unrelated.view.unmount();

  const restored = mount("B");
  await flush();
  await advance(500);
  assert.deepEqual(restored.transcripts, [{ scope: "B", text: "original words", after: "followup" }]);
  assert.deepEqual(world.claims, [{ id: job.id, owner, claim: world.claims[0].claim }]);
  assert.equal(world.uploads.length, 1);
  assert.equal(job.scope, "A", "browser recovery must not rewrite the server scope");
  assert.deepEqual(restored.errors, []);
  assert.deepEqual(associations(), []);
  restored.view.unmount();
  const again = mount("B");
  await flush();
  await advance(4500);
  assert.deepEqual(again.transcripts, []);
  assert.equal(world.claims.length, 1);
});

test("an exact migrated ID wins over newer original-scope jobs, and future uploads use B", async () => {
  const original = mount("A");
  await flush();
  const job = await upload(original.view);
  move(original.view, "A", "B");
  original.view.unmount();
  const other = addJob("A", { status: "done", text: "do not move this job" });
  complete(job);
  const restored = mount("B");
  await flush();
  await advance(500);
  assert.deepEqual(restored.transcripts.map((entry) => entry.text), ["original words"]);
  assert.equal(other.status, "done");
  assert.deepEqual(world.claims.map((entry) => entry.id), [job.id]);
  const next = await upload(restored.view, "steer");
  assert.equal(next.scope, "B");
  assert.equal(world.uploads.length, 2);
  assert.deepEqual(associations(), []);
});

test("a late upload acknowledgement pins its exact ID after unmount and resolves recoverable ambiguity", async () => {
  world.uploadGate = deferred();
  const original = mount("A");
  await flush();
  const job = await upload(original.view, "steer");
  move(original.view, "A", "B");
  original.view.unmount();
  addJob("A", { status: "done", text: "other source job" });
  complete(job);

  const restored = mount("B");
  await flush();
  assert.match(restored.view.result.current.transcribeError, /Multiple transcription jobs/);
  assert.equal(restored.errors.length, 1);
  assert.equal(associations().length, 1);
  assert.deepEqual(world.claims, []);
  assert.deepEqual(restored.transcripts, []);

  world.uploadGate.resolve();
  await flush();
  assert.deepEqual(world.acknowledgements, [job.id]);
  await act(async () => { await restored.view.result.current.retry(); });
  await advance(500);
  assert.deepEqual(restored.transcripts, [{ scope: "B", text: "original words", after: "steer" }]);
  assert.deepEqual(original.transcripts, []);
  assert.deepEqual(world.claims.map((entry) => entry.id), [job.id]);
  assert.equal(world.uploads.length, 1);
  assert.deepEqual(associations(), []);
});

test("before acknowledgement, an unambiguous original-scope job is recoverable after remount", async () => {
  world.uploadGate = deferred();
  const original = mount("A");
  await flush();
  const job = await upload(original.view);
  move(original.view, "A", "B");
  original.view.unmount();
  complete(job);
  const restored = mount("B");
  await flush();
  await advance(500);
  assert.deepEqual(restored.transcripts, [{ scope: "B", text: "original words", after: "send" }]);
  world.uploadGate.resolve();
  await flush();
  await advance(4500);
  assert.equal(world.claims.length, 1);
  assert.equal(world.uploads.length, 1);
  assert.deepEqual(original.transcripts, []);
  assert.deepEqual(associations(), []);
  assert.deepEqual(world.discards, []);
  assert.equal(job.claimedBy, world.claims[0].claim);
  assert.equal(job.text, "original words");
});

test("multi-hop Edit keeps the initial job scope while only the final identity recovers it", async () => {
  world.uploadGate = deferred();
  const original = mount("A");
  await flush();
  const job = await upload(original.view);
  move(original.view, "A", "B");
  original.view.unmount();
  const middle = mount("B");
  await flush();
  move(middle.view, "B", "C");
  middle.view.unmount();
  world.uploadGate.resolve();
  await flush();
  complete(job);
  const old = mount("A");
  const intermediate = mount("B");
  const final = mount("C");
  await flush();
  await advance(500);
  assert.deepEqual(old.transcripts, []);
  assert.deepEqual(intermediate.transcripts, []);
  assert.deepEqual(final.transcripts, [{ scope: "C", text: "original words", after: "send" }]);
  assert.equal(job.scope, "A");
  assert.deepEqual(world.claims.map((entry) => entry.id), [job.id]);
  assert.equal(world.uploads.length, 1);
});

test("a recovered server failure remains visible and retries the existing job without re-uploading", async () => {
  const original = mount("A");
  await flush();
  const job = await upload(original.view);
  move(original.view, "A", "B");
  original.view.unmount();
  job.status = "error";
  job.error = "upstream transcription failed";
  const restored = mount("B");
  await flush();
  await advance(500);
  assert.equal(restored.view.result.current.transcribeError, job.error);
  assert.deepEqual(restored.errors, ["upstream transcription failed"]);
  assert.equal(associations().length, 1);
  await act(async () => { await restored.view.result.current.retry(); });
  assert.deepEqual(world.retries, [{ id: job.id, owner: job.owner }]);
  complete(job, "retried original words");
  await advance(500);
  assert.deepEqual(restored.transcripts, [{ scope: "B", text: "retried original words", after: "send" }]);
  assert.equal(world.uploads.length, 1);
  assert.deepEqual(associations(), []);
});

test("retry errors preserve recovery until explicit discard, which closes only the migrated job", async () => {
  const original = mount("A");
  await flush();
  const job = await upload(original.view);
  move(original.view, "A", "B");
  original.view.unmount();
  job.status = "error";
  job.error = "original failure";
  const other = addJob("A");
  const restored = mount("B");
  await flush();
  await advance(500);
  world.retryFailure = 503;
  await act(async () => { await restored.view.result.current.retry(); });
  assert.equal(restored.view.result.current.transcribeError, "retry unavailable");
  assert.deepEqual(restored.errors, ["original failure", "retry unavailable"]);
  assert.equal(associations().length, 1);
  await act(async () => { restored.view.result.current.cancel(); });
  await flush();
  assert.deepEqual(world.discards, [job.id]);
  assert.equal(job.status, "gone");
  assert.equal(other.status, "pending");
  assert.deepEqual(associations(), []);
  assert.deepEqual(world.claims, []);
});

test("discarding unresolved recovery is honored by the original upload's later response", async () => {
  world.uploadGate = deferred();
  const original = mount("A");
  await flush();
  const job = await upload(original.view);
  move(original.view, "A", "B");
  original.view.unmount();
  const other = addJob("A");
  const restored = mount("B");
  await flush();
  assert.match(restored.view.result.current.transcribeError, /Multiple transcription jobs/);
  await act(async () => { restored.view.result.current.cancel(); });
  const old = mount("A");
  await flush();
  complete(job);
  await advance(500);
  assert.deepEqual(old.transcripts, []);
  world.uploadGate.resolve();
  await flush();
  assert.deepEqual(world.discards, [job.id]);
  assert.equal(job.status, "gone");
  assert.equal(other.status, "pending");
  assert.deepEqual(world.claims, []);
  assert.deepEqual(associations(), []);
});

test("source discovery failure is visible and retry resumes recovery instead of abandoning the association", async () => {
  world.uploadGate = deferred();
  const original = mount("A");
  await flush();
  const job = await upload(original.view);
  move(original.view, "A", "B");
  original.view.unmount();
  const retainedAssociation = associations().map((key) => [key, sessionStorage.getItem(key)]);
  assert.equal(retainedAssociation.length, 1);
  const unrelated = addJob("unrelated", { status: "done", text: "do not adopt these words" });
  world.listFailure = 503;
  const restored = mount("B");
  await flush();
  assert.equal(restored.view.result.current.isTranscribing, false);
  assert.notEqual(restored.view.result.current.transcribeError, null);
  assert.deepEqual(restored.transcripts, []);
  assert.deepEqual(world.claims, []);
  assert.deepEqual(associations().map((key) => [key, sessionStorage.getItem(key)]), retainedAssociation);
  world.listFailure = null;
  await act(async () => { await restored.view.result.current.retry(); });
  assert.equal(restored.view.result.current.transcribeError, null);
  assert.equal(restored.view.result.current.isTranscribing, true);
  assert.deepEqual(restored.transcripts, []);
  assert.deepEqual(world.claims, []);
  complete(job);
  await advance(500);
  assert.deepEqual(restored.transcripts, [{ scope: "B", text: "original words", after: "send" }]);
  assert.deepEqual(world.claims.map(({ id, owner }) => ({ id, owner })), [{ id: job.id, owner: job.owner }]);
  assert.deepEqual(associations(), []);
  world.uploadGate.resolve();
  await flush();
  await advance(4500);
  assert.equal(restored.view.result.current.transcribeError, null);
  assert.equal(restored.view.result.current.isTranscribing, false);
  assert.deepEqual(restored.transcripts, [{ scope: "B", text: "original words", after: "send" }]);
  assert.deepEqual(original.transcripts, []);
  assert.deepEqual(world.claims.map((entry) => entry.id), [job.id]);
  assert.equal(unrelated.status, "done");
  assert.deepEqual(world.discards, []);
  assert.equal(job.claimedBy, world.claims[0].claim);
  assert.equal(job.text, "original words", "late acknowledgement must not alter the native claim tombstone");
  assert.deepEqual(associations(), []);
  assert.equal(world.uploads.length, 1);
});

test("claim transport retries keep one claim token, and a foreign owner still waits the server's 15-second grace", async () => {
  const original = mount("A");
  await flush();
  const job = await upload(original.view, "followup");
  move(original.view, "A", "B");
  original.view.unmount();
  sessionStorage.setItem("omp-web:stt-owner-token", "different-tab-owner");
  complete(job);
  const restored = mount("B");
  await flush();
  await advance(14_999);
  assert.deepEqual(restored.transcripts, []);
  assert.equal(job.status, "done");
  world.claimFailures = 1;
  await advance(1001);
  assert.deepEqual(restored.transcripts, [{ scope: "B", text: "original words", after: undefined }]);
  assert.equal(new Set(world.claims.map((entry) => entry.claim)).size, 1);
  assert.ok(world.claims.every((entry) => entry.owner === "different-tab-owner"));
  assert.equal(world.uploads.length, 1);
  assert.deepEqual(associations(), []);
});

test("another browser storage context does not inherit a local identity association or rewrite server discovery", async () => {
  const original = mount("A");
  await flush();
  const job = await upload(original.view);
  move(original.view, "A", "B");
  original.view.unmount();
  const saved = Object.entries(sessionStorage);
  sessionStorage.clear();
  complete(job);
  const foreign = mount("B");
  await flush();
  await advance(1000);
  assert.deepEqual(foreign.transcripts, []);
  assert.equal(job.scope, "A");
  assert.deepEqual(world.claims, []);
  foreign.view.unmount();
  sessionStorage.clear();
  for (const [key, value] of saved) sessionStorage.setItem(key, value);
  const local = mount("B");
  await flush();
  await advance(500);
  assert.deepEqual(local.transcripts, [{ scope: "B", text: "original words", after: "send" }]);
});

test("a committed claim whose response is lost repeats the same token and inserts into B only once", async () => {
  const original = mount("A");
  await flush();
  const job = await upload(original.view);
  move(original.view, "A", "B");
  original.view.unmount();
  complete(job);
  world.claimResponseLosses = 1;
  const restored = mount("B");
  await flush();
  await advance(500);
  assert.equal(job.status, "gone", "the first request really committed the server claim");
  assert.deepEqual(restored.transcripts, []);
  await advance(500);
  assert.deepEqual(restored.transcripts, [{ scope: "B", text: "original words", after: "send" }]);
  assert.equal(world.claims.length, 2);
  assert.equal(new Set(world.claims.map((entry) => entry.claim)).size, 1);
  assert.deepEqual(restored.errors, []);
  assert.equal(world.uploads.length, 1);
  assert.deepEqual(associations(), []);
});

test("a migrated job already claimed elsewhere stands down and removes its local association", async () => {
  const original = mount("A");
  await flush();
  const job = await upload(original.view);
  move(original.view, "A", "B");
  original.view.unmount();
  job.status = "gone";
  job.claimedBy = "another-composer";
  const restored = mount("B");
  await flush();
  await advance(500);
  assert.deepEqual(restored.transcripts, []);
  assert.deepEqual(restored.errors, []);
  assert.equal(restored.view.result.current.isTranscribing, false);
  assert.deepEqual(world.claims, []);
  assert.deepEqual(associations(), []);
});

for (const paused of [false, true]) {
  test(`Edit preserves ${paused ? "paused" : "active"} capture and its first upload uses the new scope`, async () => {
    const capture = mount("A");
    await flush();
    await act(async () => { await capture.view.result.current.start(); });
    if (paused) await act(async () => { capture.view.result.current.togglePause(); });
    const recorder = world.recorders[0];
    move(capture.view, "A", "B");
    assert.equal(world.recorders.length, 1);
    assert.equal(recorder.state, paused ? "paused" : "recording");
    assert.equal(capture.view.result.current.isRecording, true);
    assert.equal(capture.view.result.current.isPaused, paused);
    assert.deepEqual(associations(), []);
    await act(async () => { capture.view.result.current.stop({ after: "send" }); });
    await flush();
    const job = world.uploads[0].job;
    assert.equal(job.scope, "B");
    complete(job);
    await advance(500);
    assert.deepEqual(capture.transcripts, [{ scope: "B", text: "original words", after: "send" }]);
    assert.equal(world.uploads.length, 1);
  });
}

test("a detached upload response failure is surfaced on B and retry discovers the existing unambiguous server job", async () => {
  world.uploadGate = deferred();
  const original = mount("A");
  await flush();
  const job = await upload(original.view);
  move(original.view, "A", "B");
  original.view.unmount();
  world.uploadGate.reject(new TypeError("upload acknowledgement connection failed"));
  await flush();
  const restored = mount("B");
  await flush();
  assert.equal(restored.view.result.current.transcribeError, "upload acknowledgement connection failed");
  assert.deepEqual(restored.errors, ["upload acknowledgement connection failed"]);
  assert.equal(associations().length, 1);
  await act(async () => { await restored.view.result.current.retry(); });
  complete(job);
  await advance(500);
  assert.deepEqual(restored.transcripts, [{ scope: "B", text: "original words", after: "send" }]);
  assert.deepEqual(original.transcripts, []);
  assert.equal(world.uploads.length, 1);
  assert.deepEqual(world.claims.map((entry) => entry.id), [job.id]);
  assert.deepEqual(associations(), []);
});

test("Discard closes an ID pinned by a late acknowledgement before recovery Retry", async () => {
  world.uploadGate = deferred();
  const original = mount("A");
  await flush();
  const job = await upload(original.view, "send");
  move(original.view, "A", "B");
  original.view.unmount();
  const other = addJob("A");
  const restored = mount("B");
  await flush();
  assert.notEqual(restored.view.result.current.transcribeError, null);
  assert.deepEqual(world.polls, []);
  world.uploadGate.resolve();
  await flush();
  assert.deepEqual(world.acknowledgements, [job.id]);
  assert.equal(JSON.parse(sessionStorage.getItem(associations()[0])).jobId, job.id);

  await act(async () => { restored.view.result.current.cancel(); });
  await flush();
  assert.deepEqual(world.discards, [job.id]);
  assert.equal(job.status, "gone");
  assert.equal(other.status, "pending");
  assert.deepEqual(associations(), []);
  await advance(4500);
  restored.view.unmount();
  const reopened = mount("B");
  await flush();
  await advance(4500);
  assert.deepEqual(restored.transcripts, []);
  assert.deepEqual(reopened.transcripts, []);
  assert.deepEqual(world.claims, []);
  assert.equal(world.uploads.length, 1);
});

for (const acknowledgementError of [new TypeError("lost upload acknowledgement"), { unexpected: true }]) {
  test(`an attached accepted upload with ${acknowledgementError instanceof Error ? "known" : "unknown"} acknowledgement failure stays recoverable only at B after navigation`, async () => {
    world.uploadGate = deferred();
    const original = mount("A");
    await flush();
    const job = await upload(original.view, "followup");
    move(original.view, "A", "B");
    world.uploadGate.reject(acknowledgementError);
    await flush();
    assert.equal(original.view.result.current.isTranscribing, false);
    assert.notEqual(original.view.result.current.transcribeError, null);
    assert.equal(original.errors.length, 1);
    assert.equal(associations().length, 1);
    original.view.rerender({ scope: "unrelated" });
    await flush();
    assert.equal(original.view.result.current.transcribeError, null);
    assert.equal(original.view.result.current.isTranscribing, false);
    original.view.unmount();

    const old = mount("A");
    const restored = mount("B");
    await flush();
    assert.notEqual(restored.view.result.current.transcribeError, null);
    complete(job);
    await advance(1000);
    assert.deepEqual(old.transcripts, []);
    assert.deepEqual(restored.transcripts, []);
    assert.deepEqual(world.claims, []);
    await act(async () => { await restored.view.result.current.retry(); });
    await advance(500);
    assert.deepEqual(restored.transcripts, [{ scope: "B", text: "original words", after: "followup" }]);
    assert.deepEqual(old.transcripts, []);
    assert.deepEqual(original.transcripts, []);
    assert.deepEqual(world.claims.map((entry) => entry.id), [job.id]);
    assert.deepEqual(world.discards, []);
    assert.deepEqual(associations(), []);
    assert.equal(world.uploads.length, 1);
  });
}

test("Retry of an attached lost acknowledgement discovers its accepted job instead of uploading local audio again", async () => {
  world.uploadGate = deferred();
  const original = mount("A");
  await flush();
  const job = await upload(original.view);
  move(original.view, "A", "B");
  world.uploadGate.reject(new TypeError("lost acknowledgement"));
  await flush();
  assert.notEqual(original.view.result.current.transcribeError, null);
  await act(async () => { await original.view.result.current.retry(); });
  complete(job);
  await advance(500);
  assert.deepEqual(original.transcripts, [{ scope: "B", text: "original words", after: "send" }]);
  assert.equal(world.uploads.length, 1);
  assert.deepEqual(world.discards, []);
  assert.deepEqual(associations(), []);
});

for (const detached of [false, true]) {
  test(`failed recovery storage never deletes a successful ${detached ? "detached" : "mounted"} upload`, async () => {
    world.uploadGate = deferred();
    const original = mount("A");
    await flush();
    const job = await upload(original.view, "steer");
    const storagePrototype = Object.getPrototypeOf(sessionStorage);
    const setItem = storagePrototype.setItem;
    override(storagePrototype, "setItem", function (key, value) {
      if (key.startsWith("omp-web:stt-moved-job:")) throw new DOMException("Storage denied or full", "QuotaExceededError");
      return setItem.call(this, key, value);
    });
    move(original.view, "A", "B");
    assert.deepEqual(associations(), [], "the association could not be persisted");
    assert.ok(original.errors.some((error) => typeof error === "string" && error.length > 0));
    if (detached) original.view.unmount();
    world.uploadGate.resolve();
    await flush();
    assert.deepEqual(world.acknowledgements, [job.id]);
    assert.deepEqual(world.discards, []);
    assert.equal(job.status, "pending");
    const old = mount("A");
    const target = detached ? mount("B") : original;
    await flush();
    complete(job);
    await advance(500);
    assert.deepEqual(target.transcripts, [{ scope: "B", text: "original words", after: "steer" }]);
    assert.deepEqual(old.transcripts, []);
    assert.deepEqual(world.claims.map((entry) => entry.id), [job.id]);
    assert.deepEqual(world.discards, []);
    assert.equal(world.uploads.length, 1);
    assert.deepEqual(associations(), []);
    await advance(4500);
    assert.equal(target.transcripts.length, 1);
  });
}

test("an in-memory unresolved Discard still closes the late upload when recovery storage throws", async () => {
  world.uploadGate = deferred();
  const original = mount("A");
  await flush();
  const job = await upload(original.view);
  const storagePrototype = Object.getPrototypeOf(sessionStorage);
  const setItem = storagePrototype.setItem;
  override(storagePrototype, "setItem", function (key, value) {
    if (key.startsWith("omp-web:stt-moved-job:")) throw new DOMException("Storage unavailable", "SecurityError");
    return setItem.call(this, key, value);
  });
  move(original.view, "A", "B");
  original.view.unmount();
  const other = addJob("A");
  const restored = mount("B");
  await flush();
  assert.notEqual(restored.view.result.current.transcribeError, null);
  await act(async () => { restored.view.result.current.cancel(); });
  world.uploadGate.resolve();
  await flush();
  assert.deepEqual(world.discards, [job.id]);
  assert.equal(job.status, "gone");
  assert.equal(other.status, "pending");
  await advance(4500);
  assert.deepEqual(restored.transcripts, []);
  assert.deepEqual(world.claims, []);
  assert.equal(world.uploads.length, 1);
});
