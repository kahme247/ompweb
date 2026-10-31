import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildNotificationDialog, createNotificationDetector, parseNotificationPrefs, renderNotification } = await jiti.import("./notification-events.ts");

const session = { sessionId: "s1", sessionName: "Refactor auth" };

function run(frames) {
  const detect = createNotificationDetector();
  return frames.flatMap((frame) => detect(frame, session));
}

const summary = (events) => events.map((event) => [event.type, event.detail]);

test("completion fires when the session settles, not per prompt or per subagent", () => {
  const events = run([
    { type: "agent_start" },
    { type: "subagent_lifecycle", payload: { id: "a", status: "completed" } },
    { type: "subagent_event", payload: { id: "a", event: { type: "agent_end", isTerminal: true } } },
    { type: "agent_end", isTerminal: false },
    { type: "prompt_result", agentInvoked: true, status: "completed", sessionSettled: false },
    { type: "session_settled" },
  ]);
  assert.deepEqual(events, [{ sessionId: "s1", sessionName: "Refactor auth", type: "completed" }]);
});

test("local slash commands and aborted runs do not notify", () => {
  assert.deepEqual(run([{ type: "prompt_result", agentInvoked: false, status: "error", error: { message: "unknown command" } }]), []);
  assert.deepEqual(run([{ type: "prompt_result", agentInvoked: true, status: "aborted" }, { type: "session_settled" }]), []);
});

test("a run failure reported by omp-web and again by omp notifies once; a later crash adds nothing", () => {
  const events = run([
    { type: "prompt_error", errorMessage: "usage reserve is fail-closed" },
    { type: "prompt_result", agentInvoked: true, status: "error", error: { message: "usage reserve is fail-closed" } },
    { type: "process_exit", detail: "code 1" },
    { type: "session_settled" },
  ]);
  assert.deepEqual(summary(events), [["error", "usage reserve is fail-closed"]]);
});

test("a failed run notifies once as an error, not again as completed", () => {
  const events = run([
    { type: "prompt_result", agentInvoked: true, status: "error", error: { message: "Retry budget exhausted" } },
    { type: "session_settled" },
  ]);
  assert.deepEqual(summary(events), [["error", "Retry budget exhausted"]]);
});

test("after a failed stretch, a background wake with no prompt completes normally", () => {
  const events = run([
    { type: "prompt_result", agentInvoked: true, status: "error", error: { message: "boom" } },
    { type: "session_settled" },
    { type: "agent_start" },
    { type: "agent_end", isTerminal: true },
    { type: "session_settled" },
  ]);
  assert.deepEqual(events.map((event) => event.type), ["error", "completed"]);
});

test("every blocking dialog method asks for input; non-blocking UI frames do not", () => {
  const blocking = ["select", "confirm", "input", "editor", "open_url"].map((method) => ({ type: "extension_ui_request", id: method, method, title: `${method}?` }));
  const events = run([
    ...blocking,
    { type: "extension_ui_request", id: "ask", method: "ask", questions: [{ id: "q", question: "Ship it?", options: [] }] },
    { type: "extension_ui_request", id: "n", method: "notify", message: "fyi" },
    { type: "extension_ui_request", id: "s", method: "setStatus", statusKey: "k" },
    { type: "extension_ui_request", id: "p", method: "__proto__", title: "x" },
  ]);
  assert.deepEqual(summary(events), [
    ["input", "select?"], ["input", "confirm?"], ["input", "input?"], ["input", "editor?"], ["input", "open_url?"], ["input", "Ship it?"],
  ]);
});

test("a fallback takes its reason from the retry error omp sends right after it", () => {
  // omp's order: retry_fallback_applied, then auto_retry_start for the same failure.
  const events = run([
    { type: "auto_retry_start", attempt: 1, errorMessage: "429 rate limit, retry in 2s" },
    { type: "auto_retry_end", success: true },
    { type: "retry_fallback_applied", from: "anthropic/fable", to: "anthropic/opus", role: "default" },
    { type: "auto_retry_start", attempt: 2, errorMessage: "Request refused by the safety classifier" },
  ]);
  assert.deepEqual(events.map((event) => [event.from, event.to, event.detail]), [["anthropic/fable", "anthropic/opus", "Request refused by the safety classifier"]]);
});

test("an explicit fallback reason wins; a fallback with no following retry has none", () => {
  const events = run([
    { type: "retry_fallback_applied", from: "a/x", to: "b/y", reason: "usage reserve reached" },
    { type: "auto_retry_start", errorMessage: "ignored for the explicit reason" },
    { type: "retry_fallback_applied", from: "a/x", to: "b/y" },
    { type: "prompt_result", agentInvoked: true, status: "completed" },
    { type: "retry_fallback_applied", from: "a/x" },
  ]);
  assert.deepEqual(summary(events), [["modelSwitch", "usage reserve reached"], ["modelSwitch", undefined]]);
});

test("prewalk and plan hand-offs notify as model switches; other notices do not", () => {
  const events = run([
    { type: "notice", level: "info", source: "prewalk", message: "Prewalk: switched to openai/gpt-5 after first edit call." },
    { type: "notice", level: "info", source: "plan-yolo", message: "Plan-yolo: plan approved, switched to openai/gpt-5." },
    { type: "notice", level: "error", source: "session-persistence", message: "disk full" },
  ]);
  assert.deepEqual(events.map((event) => event.type), ["modelSwitch", "modelSwitch"]);
});

test("untrusted prefs fall back to defaults field by field", () => {
  assert.deepEqual(parseNotificationPrefs({ enabled: true, types: { input: false, bogus: true }, whenActive: "loud", locale: "<script>" }), {
    enabled: true,
    types: { completed: true, input: false, error: true, modelSwitch: false },
    whenActive: "toast",
    locale: "en",
  });
});

test("rendered notifications open their session and clip long details", () => {
  const t = (key, vars) => `${key}${vars ? JSON.stringify(vars) : ""}`;
  const rendered = renderNotification({ type: "error", sessionId: "a b", sessionName: null, detail: "x".repeat(500) }, t);
  assert.equal(rendered.url, "/?session=a%20b");
  assert.equal(rendered.title, "notifications.untitledSession");
  assert.equal(rendered.tag, "a b:error");
  assert.ok(rendered.body.length < 260, rendered.body);
});

test("a pasted overlong session name is clipped so push payloads stay small", () => {
  const rendered = renderNotification({ type: "completed", sessionId: "s1", sessionName: "y".repeat(60_000) }, (key) => key);
  assert.equal(rendered.title.length, 100);
  assert.ok(rendered.title.endsWith("…"));
  assert.equal(renderNotification({ type: "completed", sessionId: "s1", sessionName: "Fix bug" }, (key) => key).title, "Fix bug");
});

test("an input notification carries the answerable select dialog with display text clipped", () => {
  const [event] = run([{
    type: "extension_ui_request",
    id: "req-1",
    method: "select",
    title: "  Choose   a target ",
    options: [{ label: "alpha" }, "beta"],
    expiresAt: 1234,
  }]);
  assert.equal(event.requestId, "req-1", "the event carries the id a retraction matches");
  assert.deepEqual(event.dialog, {
    requestId: "req-1",
    method: "select",
    title: "Choose a target",
    options: ["alpha", "beta"],
    expiresAt: 1234,
  });
  assert.equal(event.detail, "  Choose   a target ");
});

test("answer labels are kept byte-for-byte; labels that would have to change omit the dialog", () => {
  const select = (options) => buildNotificationDialog({ id: "s", method: "select", title: "Pick", options });
  assert.deepEqual(select(["main", "next"]).options, ["main", "next"]);
  assert.deepEqual(select(["Yes,\nplease", " padded "]).options, ["Yes,\nplease", " padded "], "whitespace is part of the label");
  assert.equal(select(["A".repeat(161)]), undefined, "a label over the cap is never clipped");
  assert.equal(select([{ value: "no-label" }]), undefined, "an option without a label cannot be shown exactly");
  assert.equal(select([""]), undefined);
  assert.equal(select(Array.from({ length: 13 }, (_, index) => `option ${index}`)), undefined, "more options than the cap");
  const ask = buildNotificationDialog({
    id: "a",
    method: "ask",
    questions: [{ id: "q1", question: "Which?", options: ["B".repeat(121)] }],
  });
  assert.equal(ask, undefined, "an ask option over the per-option cap is not clipped");
});

test("an input event keeps its request id even when no dialog can be carried", () => {
  const [event] = run([{ type: "extension_ui_request", id: "open-1", method: "open_url", title: "Open the docs" }]);
  assert.equal(event.type, "input");
  assert.equal(event.requestId, "open-1");
  assert.equal(event.dialog, undefined);
});

test("confirm, input and editor dialogs expose only what the app can answer", () => {
  assert.deepEqual(buildNotificationDialog({ id: "c", method: "confirm", title: "Deploy?", message: "This writes to prod." }), {
    requestId: "c",
    method: "confirm",
    title: "Deploy?",
    message: "This writes to prod.",
  });
  assert.deepEqual(buildNotificationDialog({ id: "i", method: "input", title: "Branch name", placeholder: "feature/x" }), {
    requestId: "i",
    method: "input",
    title: "Branch name",
    placeholder: "feature/x",
  });
  assert.deepEqual(buildNotificationDialog({ id: "e", method: "editor", title: "Commit message", prefill: "secret body" }), {
    requestId: "e",
    method: "editor",
    title: "Commit message",
  });
});

test("ask dialogs keep question ids, options and the Other input rule", () => {
  const dialog = buildNotificationDialog({
    id: "ask",
    method: "ask",
    title: "Ship it?",
    questions: [
      { id: "q1", question: "Which branch?", options: [{ label: "main" }, { label: "next" }], multi: true, allowCustom: false },
      { id: "q2", question: "Notes?" },
    ],
  });
  assert.deepEqual(dialog, {
    requestId: "ask",
    method: "ask",
    title: "Ship it?",
    questions: [
      { id: "q1", question: "Which branch?", options: ["main", "next"], multi: true },
      { id: "q2", question: "Notes?", allowCustom: true },
    ],
  });
  // Missing/duplicate ids make the whole dialog unusable: omp could not match answers.
  assert.equal(buildNotificationDialog({ id: "a", method: "ask", questions: [{ question: "no id" }] }), undefined);
  assert.equal(buildNotificationDialog({ id: "a", method: "ask", questions: [{ id: "x", question: "one" }, { id: "x", question: "two" }] }), undefined);
  assert.equal(buildNotificationDialog({ id: "a", method: "ask", questions: [{ id: "x", question: "one" }, { id: "y", question: "two" }, { id: "z", question: "three" }, { id: "w", question: "four" }, { id: "v", question: "five" }, { id: "u", question: "six" }] }), undefined);
});

test("dialogs that cannot be represented or would not fit a push are omitted entirely", () => {
  assert.equal(buildNotificationDialog({ id: "u", method: "open_url", title: "https://example.test" }), undefined);
  assert.equal(buildNotificationDialog({ id: "u", method: "notify", message: "fyi" }), undefined);
  assert.equal(buildNotificationDialog({ id: "", method: "confirm", title: "No id" }), undefined);
  assert.equal(buildNotificationDialog({ id: "x".repeat(129), method: "confirm", title: "Long id" }), undefined);
  assert.equal(buildNotificationDialog({ id: "s", method: "select", title: "No options" }), undefined);
  const huge = buildNotificationDialog({
    id: "huge",
    method: "ask",
    title: "T".repeat(160),
    questions: Array.from({ length: 5 }, (_, index) => ({
      id: `q${index}`,
      question: "Q".repeat(240),
      options: Array.from({ length: 9 }, () => "O".repeat(120)),
    })),
  });
  assert.equal(huge, undefined, "real content above the byte cap must not be truncated into a misleading dialog");
});

test("exhausted retries end the run as exactly one error notification", () => {
  const events = run([
    { type: "agent_start" },
    { type: "auto_retry_start", attempt: 1, errorMessage: "429 rate limit" },
    { type: "auto_retry_end", success: false, attempt: 3 },
    { type: "auto_retry_start", attempt: 4, errorMessage: "provider unavailable" },
    { type: "auto_retry_end", success: false, attempt: 5 },
    { type: "prompt_result", agentInvoked: true, status: "error", error: { message: "Retry budget exhausted" } },
    { type: "session_settled" },
  ]);
  assert.deepEqual(summary(events), [["error", "Retry budget exhausted"]]);
});

test("a crash mid-run notifies once, even when omp later reports the same failure again", () => {
  const events = run([
    { type: "agent_start" },
    { type: "process_exit", detail: "code 3221225477" },
    { type: "prompt_result", agentInvoked: true, status: "error", error: { message: "child exited" } },
  ]);
  assert.deepEqual(summary(events), [["error", "code 3221225477"]]);
});
