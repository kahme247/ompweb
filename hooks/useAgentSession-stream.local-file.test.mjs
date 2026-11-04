// open_file with a local:// URL asks the server which file it is; that lookup must end, one way or the other.
import assert from "node:assert/strict";
import test from "node:test";

const { runHostTool, LOCAL_FILE_LOOKUP_TIMEOUT_MS } = await import("./useAgentSession-stream.ts");

test("a local:// lookup the server never answers ends the open_file call with an error, not a hang", async (t) => {
  // Client deadlines are an AbortController and a timer: AbortSignal.timeout is missing in older browsers.
  const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
  Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: undefined });
  t.after(() => Object.defineProperty(AbortSignal, "timeout", timeoutDescriptor));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let aborted = false;
  t.mock.method(globalThis, "fetch", (_url, init) => new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => {
      aborted = true;
      reject(new DOMException("The operation was aborted.", "AbortError"));
    });
  }));
  const opened = [];
  let settled = null;
  const call = runHostTool("open_file", { path: "local://note.md" }, { openUrl: () => "", openFile: (...args) => { opened.push(args); } }, "s1");
  call.then((result) => { settled = result; });
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  t.mock.timers.tick(LOCAL_FILE_LOOKUP_TIMEOUT_MS - 1);
  await flush();
  assert.equal(settled, null, "still waiting before the deadline");
  t.mock.timers.tick(1);
  await flush();
  assert.ok(settled, "the call settles at the deadline");
  assert.equal(settled.isError, true);
  assert.match(settled.text, /did not answer/);
  assert.equal(aborted, true, "the stalled request is cancelled");
  assert.deepEqual(opened, [], "no tab opens");
});

test("a local:// lookup that answers in time is not cut short", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", async () => Response.json({ path: "/sessions/s1/local/note.md" }));
  const opened = [];
  const result = await runHostTool("open_file", { path: "local://note.md" }, { openUrl: () => "", openFile: (...args) => { opened.push(args); } }, "s1");
  assert.deepEqual(result, { text: "Opened local://note.md", isError: false });
  assert.deepEqual(opened, [["/sessions/s1/local/note.md", "note.md"]]);
  // The deadline timer is not left running after the answer: nothing fires when it would have.
  t.mock.timers.tick(LOCAL_FILE_LOOKUP_TIMEOUT_MS * 2);
});
