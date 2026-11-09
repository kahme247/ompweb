import assert from "node:assert/strict";
import test from "node:test";

const { createNotificationDetector, parseNotificationPrefs, renderNotification } = await import("./notification-events.ts");
const locales = {
  en: (await import("./i18n/locales/en.json")).default,
  ja: (await import("./i18n/locales/ja.json")).default,
  "zh-CN": (await import("./i18n/locales/zh-CN.json")).default,
};

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
    inputReminder: true,
  });
});

test("a blocking dialog carries its request id and answerable payload", () => {
  const [event] = run([{
    type: "extension_ui_request",
    id: "req-1",
    method: "confirm",
    title: "Allow tool: bash",
    message: "Run rm -rf build?",
  }]);
  assert.equal(event.requestId, "req-1");
  assert.deepEqual(event.dialog, { requestId: "req-1", method: "confirm", title: "Allow tool: bash", message: "Run rm -rf build?" });
});

test("an ask dialog keeps option labels verbatim and drops payloads that cannot be answered", () => {
  const questions = [{ id: "q1", question: "Ship it?", options: ["Yes", "No"], multi: true }];
  const [event] = run([{ type: "extension_ui_request", id: "req-2", method: "ask", questions }]);
  assert.deepEqual(event.dialog.questions, [{ id: "q1", question: "Ship it?", options: ["Yes", "No"], multi: true, allowCustom: true }]);

  // A label that would have to be clipped cannot be answered: no dialog, but
  // the request id still reaches the notification so a retraction can close it.
  const long = [{ id: "q1", question: "Ship it?", options: ["x".repeat(200)] }];
  const [clipped] = run([{ type: "extension_ui_request", id: "req-3", method: "ask", questions: long }]);
  assert.equal(clipped.dialog, undefined);
  assert.equal(clipped.requestId, "req-3");
});

test("open_url has no answerable dialog but keeps its request id", () => {
  const [event] = run([{ type: "extension_ui_request", id: "req-4", method: "open_url", url: "https://example.test", instructions: "Open it" }]);
  assert.equal(event.requestId, "req-4");
  assert.equal(event.dialog, undefined);
});

test("input reminders stay enabled unless a device explicitly turned them off", () => {
  assert.equal(parseNotificationPrefs({}).inputReminder, true, "a device that saved prefs before the toggle existed keeps reminders");
  assert.equal(parseNotificationPrefs({ inputReminder: false }).inputReminder, false);
  assert.equal(parseNotificationPrefs({ inputReminder: "no" }).inputReminder, true, "only the boolean false disables it");
});

/** The real dictionaries the server renders with, so a wording change is what the test sees. */
const translate = (locale) => (key, vars) => {
  const template = locales[locale][key] ?? locales.en[key] ?? key;
  return vars ? template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match)) : template;
};

test("a reminder renders a grammatical duration sentence in every shipped language", () => {
  const pendingSince = "2026-11-05T09:15:00.000Z";
  const opened = Date.parse(pendingSince);
  const event = { type: "input", sessionId: "s1", sessionName: "Deploy", detail: "Ship it?", requestId: "req-1", reminder: true, pendingSince };
  const at = (ms) => renderNotification(event, translate("en"), "en", opened + ms);

  // The rendered sentence, not the key and its variables: the duration has to
  // read as a duration, which the old "since 2 hours" did not.
  assert.equal(at(2 * 60 * 60 * 1000).title, "Reminder: Deploy");
  assert.equal(at(2 * 60 * 60 * 1000).body, "Waiting for 2 hours: Ship it?");
  assert.equal(renderNotification({ ...event, detail: undefined }, translate("en"), "en", opened + 2 * 60 * 60 * 1000).body,
    "Still waiting for your answer (2 hours).");
  // Minutes, singular and plural; a day-old question reads in days.
  assert.equal(at(60_000).body, "Waiting for 1 minute: Ship it?");
  assert.equal(at(45 * 60_000).body, "Waiting for 45 minutes: Ship it?");
  assert.equal(at(26 * 60 * 60 * 1000).body, "Waiting for 1 day: Ship it?");

  // Japanese: the duration is a 前から construction, never "2 時間 から".
  const ja = (ms) => renderNotification(event, translate("ja"), "ja", opened + ms);
  assert.equal(ja(2 * 60 * 60 * 1000).title, "リマインダー: Deploy");
  assert.equal(ja(2 * 60 * 60 * 1000).body, "2 時間前から回答を待っています: Ship it?");

  // Simplified Chinese: 已等待 <duration>, not a "since" clause.
  const zh = (ms) => renderNotification(event, translate("zh-CN"), "zh-CN", opened + ms);
  assert.equal(zh(2 * 60 * 60 * 1000).title, "提醒：Deploy");
  assert.equal(zh(2 * 60 * 60 * 1000).body, "已等待 2小时：Ship it?");

  // The first input notification is not a reminder and keeps its own wording.
  const first = renderNotification({ ...event, reminder: false }, translate("en"), "en");
  assert.equal(first.title, "Deploy");
  assert.equal(first.body, "Waiting for your answer: Ship it?");
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
