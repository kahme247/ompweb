import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement, StrictMode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react/pure.js";
import userEvent from "@testing-library/user-event";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, fsCache: false, jsx: { runtime: "automatic" } });
const { ScheduledTasksConfig } = await jiti.import("./ScheduledTasksConfig.tsx");
const { ToastProvider } = await jiti.import("./ui/toast.tsx");
afterEach(cleanup);

const emptyList = { tasks: [], runs: [], timeZone: "Asia/Shanghai", schedulerEnabled: true };

function mockApi(t, { list = emptyList, onWrite }) {
  const writes = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const method = options?.method ?? "GET";
    if (method !== "GET") {
      const write = { url: String(url), method, body: options?.body ? JSON.parse(options.body) : undefined };
      writes.push(write);
      return onWrite(write);
    }
    if (url === "/api/projects") return Response.json({ projects: [{ path: "/work/other", alias: "Other" }] });
    if (url === "/api/models") return Response.json({ modelList: [{ id: "m1", name: "Model One", provider: "p" }] });
    return Response.json(list);
  });
  return writes;
}

async function fillWeeklyTask(user) {
  await user.click((await screen.findAllByRole("button", { name: "New task" }))[0]);
  await user.type(screen.getByLabelText(/^Name/), "Friday report");
  await user.type(screen.getByLabelText(/^Prompt/), "Summarize this week's merged changes");
  await user.selectOptions(screen.getByLabelText("Repeat"), "weekly");
  await user.click(screen.getByRole("checkbox", { name: "Fri" }));
  const time = screen.getByLabelText("Time");
  await user.clear(time);
  await user.type(time, "15:30");
  await user.click(screen.getByRole("radio", { name: /Continue the same session/ }));
  await user.selectOptions(screen.getByLabelText("Thinking level"), "high");
}

test("creating a weekly task posts the exact scheduled task input", async (t) => {
  const writes = mockApi(t, { onWrite: () => Response.json({ task: {} }, { status: 201 }) });
  const user = userEvent.setup();
  // StrictMode (as in `next dev`) replays effect cleanup on mount; the form
  // must still close after a successful save.
  render(createElement(StrictMode, null, createElement(ScheduledTasksConfig, { cwd: "/work/app" })));
  await screen.findByText("Times use the server time zone (Asia/Shanghai).");
  await fillWeeklyTask(user);
  await user.click(screen.getByRole("button", { name: "Create task" }));
  await waitFor(() => assert.equal(writes.length, 1));
  assert.deepEqual(writes[0], {
    url: "/api/scheduled-tasks",
    method: "POST",
    body: {
      name: "Friday report",
      cwd: "/work/app",
      prompt: "Summarize this week's merged changes",
      schedule: { kind: "weekly", days: [5], time: "15:30" },
      sessionMode: "continue",
      model: null,
      thinkingLevel: "high",
      enabled: true,
    },
  });
  await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Create task" }), null));
});

test("server field errors render next to the field and keep the form open", async (t) => {
  mockApi(t, {
    onWrite: () => Response.json({ error: "Invalid scheduled task", code: "invalid_scheduled_task", fields: { prompt: "Prompt is limited to 20000 characters" } }, { status: 400 }),
  });
  const user = userEvent.setup();
  render(createElement(ScheduledTasksConfig, { cwd: "/work/app" }));
  await fillWeeklyTask(user);
  await user.click(screen.getByRole("button", { name: "Create task" }));
  const error = await screen.findByText("Enter a prompt of up to 20000 characters.");
  assert.equal(error.getAttribute("role"), "alert");
  assert.ok(screen.getByRole("button", { name: "Create task" }));
});

const listedTask = {
  id: "task-1", name: "Friday report", cwd: "/work/app", prompt: "p",
  schedule: { kind: "weekly", days: [5], time: "15:30" }, sessionMode: "new", model: null, thinkingLevel: null, enabled: true,
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", anchorAt: "2026-10-01T00:00:00.000Z", lastSlotAt: "2026-10-23T07:30:00.000Z", lastSessionId: "session-1",
  nextRunAt: "2026-10-30T07:30:00.000Z", running: false,
};

test("a listed task shows its schedule, last run, and opens the run's session", async (t) => {
  const task = listedTask;
  const run = { id: "run-1", taskId: "task-1", trigger: "schedule", scheduledFor: "2026-10-23T07:30:00.000Z", startedAt: "2026-10-23T07:30:01.000Z", finishedAt: null, sessionId: "session-1", status: "failed", error: "Model unavailable" };
  mockApi(t, { list: { ...emptyList, tasks: [task], runs: [run] }, onWrite: () => Response.json({}) });
  const opened = [];
  const user = userEvent.setup();
  render(createElement(ScheduledTasksConfig, { cwd: "/work/app", onOpenSession: (id) => opened.push(id) }));
  await screen.findByText("Every Friday at 15:30");
  assert.ok(screen.getByText("Failed"));
  assert.ok(screen.getByText("Model unavailable"));
  await user.click(screen.getByRole("button", { name: "Open session" }));
  assert.deepEqual(opened, ["session-1"]);
});

test("Run now reports a run that failed to start instead of announcing it as started", async (t) => {
  mockApi(t, {
    list: { ...emptyList, tasks: [listedTask] },
    onWrite: () => Response.json({ run: { id: "run-2", taskId: "task-1", trigger: "manual", scheduledFor: null, startedAt: "2026-10-27T00:00:00.000Z", finishedAt: "2026-10-27T00:00:00.000Z", sessionId: null, status: "failed", error: "Workspace directory does not exist: /work/app", pid: null } }, { status: 202 }),
  });
  const user = userEvent.setup();
  render(createElement(ToastProvider, null, createElement(ScheduledTasksConfig, { cwd: "/work/app" })));
  await user.click(await screen.findByRole("button", { name: "Run now" }));
  assert.ok(await screen.findByText("Could not start Friday report"));
  assert.equal(screen.queryByText("Started Friday report"), null);
});
