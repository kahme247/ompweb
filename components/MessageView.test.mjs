import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react/pure.js";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MessageView, SafeMarkdownBody, TaskResultPanel, isInterruptedMessage } = await jiti.import("./MessageView.tsx");
const { CodeBlock } = await jiti.import("./MermaidBlock.tsx");
const { buildSessionContext } = await jiti.import("../lib/session-reader.ts");
const { collectToolResults, planTranscriptRows } = await jiti.import("../lib/chat-transcript-plan.ts");
afterEach(cleanup);

test("sent messages without timestamps or branch metadata still offer copy", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: { role: "user", content: "Keep this message copyable." },
  }));
  assert.match(html, /<button[^>]*aria-label="Copy message"/);
});

// Plain Copy needs the browser's layout-aware innerText (not implemented by
// jsdom). Verify code gutters, math, tables, images and spacing in Chromium;
// do not substitute textContent and claim equivalent coverage here.
test("message Markdown copy preserves source, excludes activity, and confirms success in Strict Mode", async (t) => {
  let clipboard = "";
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text) => { clipboard = text; } },
  });
  t.after(() => {
    delete navigator.clipboard;
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
    else delete window.matchMedia;
  });
  const source = "# Heading\n\n**Bold** and [link](https://example.com)\n\n```js\n  code();\n```";
  const messages = [
    { role: "user", content: source },
    { role: "assistant", content: [
      { type: "text", text: source },
      { type: "thinking", thinking: "Do not copy thinking" },
      { type: "toolCall", toolCallId: "copy-tool", toolName: "read", input: { path: "not copied" } },
      { type: "text", text: "## Conclusion\n\nDone." },
    ] },
  ];
  for (const message of messages) {
    const view = render(React.createElement(React.StrictMode, null, React.createElement(MessageView, { message })));
    const button = view.getByRole("button", { name: "Copy as Markdown" });
    await act(async () => { fireEvent.click(button); });
    assert.equal(clipboard, message.role === "user" ? source : `${source}\n\n## Conclusion\n\nDone.`);
    // The click handler's copy chain (clipboard write -> setCopied) resolves on a
    // microtask that can land AFTER act's flush under load, leaving the "Copied"
    // label uncommitted when this line reads the DOM. waitFor lets React commit
    // instead of racing the scheduler (flaked under parallel suite load).
    await waitFor(() => assert.equal(button.textContent, "Copied"));
    view.unmount();
  }
});

test("plain Copy keeps full oversized message source instead of the reveal control", async (t) => {
  let clipboard = "";
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text) => { clipboard = text; } },
  });
  t.after(() => { delete navigator.clipboard; });
  const source = "# Keep the full raw source\n\n".repeat(5000);
  for (const message of [
    { role: "user", content: source },
    { role: "assistant", content: [
      { type: "thinking", thinking: "Do not copy thinking" },
      { type: "text", text: source },
    ] },
  ]) {
    const view = render(React.createElement(MessageView, { message }));
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Copy message" })); });
    assert.equal(clipboard, source);
    view.unmount();
  }
});

test("expanded oversized user message can be collapsed again", (t) => {
  // Layout stub: capped bubbles overflow; an uncapped bubble fits its content.
  const observers = [];
  const originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() {}
  };
  const proto = window.HTMLElement.prototype;
  const scrollHeight = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
  const clientHeight = Object.getOwnPropertyDescriptor(proto, "clientHeight");
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get() { return 1000; } });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get() { return this.style.maxHeight === "none" ? 1000 : 300; },
  });
  t.after(() => {
    globalThis.ResizeObserver = originalResizeObserver;
    for (const [name, descriptor] of [["scrollHeight", scrollHeight], ["clientHeight", clientHeight]]) {
      if (descriptor) Object.defineProperty(proto, name, descriptor);
      else delete proto[name];
    }
  });

  const view = render(React.createElement(MessageView, { message: { role: "user", content: "long\n\n".repeat(200) } }));
  const resize = () => act(() => { for (const observer of observers) observer.callback([]); });
  fireEvent.click(view.getByRole("button", { name: "Show full input" }));
  resize();
  const toggle = view.getByRole("button", { name: "Collapse input" });
  toggle.focus();
  fireEvent.click(toggle);
  // Before re-measuring, the same toggle must stay mounted and focused.
  assert.equal(document.activeElement, toggle);
  resize();
  assert.equal(view.getByRole("button", { name: "Show full input" }), toggle);
  assert.equal(document.activeElement, toggle);
});

test("expanded tool inputs follow streaming arguments without toggling output", () => {
  const code = "print('first')\nprint('complete')";
  const editInput = { path: "/tmp/example.ts", patch: "-old\n+new", options: { dryRun: false } };
  const toolResults = new Map([["edit-call", {
    role: "toolResult", toolCallId: "edit-call", content: [{ type: "text", text: "Edit complete" }],
  }]]);
  const props = (input) => ({
    isStreaming: true,
    toolCallsDefaultCollapsed: false,
    toolResults,
    message: {
      role: "assistant", model: "test", provider: "test",
      content: [
        { type: "toolCall", toolCallId: "eval-call", toolName: "eval", input: { language: "py", code: input } },
        { type: "toolCall", toolCallId: "edit-call", toolName: "edit", input: editInput },
      ],
    },
  });
  const { container, rerender } = render(React.createElement(MessageView, props("print('first')")));
  // With collapse off, each tool call is its own already-open row.
  const rowTriggers = () => [...container.querySelectorAll("button.activity-row-trigger")];
  assert.equal(rowTriggers().length, 2);
  const toggles = (label) => [...container.querySelectorAll("button.tool-call-input-toggle")]
    .filter((button) => (button.textContent ?? "").includes(label));
  const inputPanels = () => [...container.querySelectorAll("div.tool-call-input")];
  const pres = (panel) => [...panel.querySelectorAll("pre")];
  assert.equal(toggles("Show full input").length, 2);
  assert.ok(inputPanels().every((panel) => panel.hidden));
  for (const toggle of toggles("Show full input")) fireEvent.click(toggle);
  assert.equal(pres(inputPanels()[0])[1].textContent, "print('first')");
  assert.equal(pres(inputPanels()[1])[1].textContent, editInput.patch);
  assert.deepEqual(JSON.parse(pres(inputPanels()[1])[2].textContent ?? ""), editInput.options);
  rerender(React.createElement(MessageView, props(code)));
  assert.equal(pres(inputPanels()[0])[1].textContent, code);
  const output = () => [...container.querySelectorAll('pre[data-tool-output="true"]')].map((node) => node.textContent);
  assert.deepEqual(output(), ["Edit complete"]);
  for (const toggle of toggles("Collapse input")) fireEvent.click(toggle);
  assert.ok(inputPanels().every((panel) => panel.hidden));
  assert.deepEqual(output(), ["Edit complete"]);
});

test("large message content avoids the markdown pipeline until requested", () => {
  const largeMessage = "x".repeat(100_001);
  const html = renderToStaticMarkup(React.createElement(SafeMarkdownBody, null, largeMessage));

  assert.match(html, /Large message \(100 KB\)/);
  assert.doesNotMatch(html, /markdown-body/);
});

test("streaming code blocks avoid syntax-highlighter line markup", () => {
  const html = renderToStaticMarkup(React.createElement(CodeBlock, {
    code: "const value = 1;",
    lang: "ts",
    isStreaming: true,
  }));

  assert.match(html, /const value = 1;/);
  assert.doesNotMatch(html, /linenumber/);
});

test("MCP mount notices stay out of the transcript", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "custom",
      customType: "xdev-mount-notice",
      content: "The xd:// device inventory changed.",
      display: false,
    },
  }));

  assert.equal(html, "");
});

test("streaming tool calls start collapsed when the interface preference is enabled", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: true,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path: "foo.ts" } }],
    },
  }));

  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /<pre/);
});

test("expanded tool calls show the compact command header", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path: "foo.ts" } }],
    },
  }));

  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /tool-call-details/);
  assert.match(html, /\$<\/span><code>read foo\.ts<\/code>/);
});

test("read paths with an internal URL scheme are not file links", () => {
  const render = (path) => renderToStaticMarkup(React.createElement(MessageView, {
    onOpenFile() {},
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path } }],
    },
  }));

  for (const path of ["history://ScoutAgent", "proc://Job1", " local://notes.md", "ftp://example.com/a.ts", "javascript://x%0Aalert(1)", "file:///etc/passwd"]) {
    assert.doesNotMatch(render(path), /activity-file-link|role="link"/, path);
  }
  assert.match(render("src/foo.ts:10"), /activity-file-link/);
});

test("read paths with a web URL open the fetched page in a new tab without toggling the row", () => {
  const opened = [];
  const originalOpen = window.open;
  window.open = (...args) => { opened.push(args.join(" ")); return null; };
  const openedFiles = [];
  try {
    const cases = [
      [" https://example.com/docs", "https://example.com/docs _blank noopener,noreferrer"],
      ["HTTPS://Example.com/a:raw", "https://example.com/a _blank noopener,noreferrer"],
      ["https://example.com:8080/a.md:10-20", "https://example.com:8080/a.md _blank noopener,noreferrer"],
    ];
    for (const [path, expected] of cases) {
      opened.length = 0;
      const { container, getByRole } = render(React.createElement(MessageView, {
        onOpenFile(file) { openedFiles.push(file); },
        message: {
          role: "assistant",
          content: [{ type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path } }],
        },
      }));
      const trigger = container.querySelector("[aria-expanded]");
      const expanded = trigger.getAttribute("aria-expanded");
      fireEvent.click(getByRole("link"));
      fireEvent.keyDown(getByRole("link"), { key: "Enter" });
      assert.deepEqual(opened, [expected, expected], path);
      assert.equal(trigger.getAttribute("aria-expanded"), expanded, path);
      cleanup();
    }
  } finally {
    window.open = originalOpen;
  }
  assert.deepEqual(openedFiles, []);
});

test("ask tool previews question prompts instead of object coercion", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: true,
    message: {
      role: "assistant",
      content: [{
        type: "toolCall",
        toolCallId: "call-ask",
        toolName: "ask",
        input: {
          questions: [
            { header: "Color", question: "Which color do you prefer?", options: [{ label: "Blue" }], multiSelect: false },
            { header: "Features", question: "Which features should be enabled?", options: [{ label: "Search" }], multiSelect: true },
          ],
        },
      }],
    },
  }));

  assert.match(html, /Color: Which color do you prefer\?/);
  assert.match(html, /Features: Which features should be enabled\?/);
  assert.doesNotMatch(html, /\[object Object\]/);
});

test("expanded read output uses compact terminal text without line gutters", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path: "foo.ts" } }],
    },
    toolResults: new Map([[
      "call-1",
      { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "1: const value = 1;\\n2: return value;" }] },
    ]]),
  }));

  assert.match(html, /data-tool-output="true"/);
  assert.match(html, /const value = 1;/);
  assert.doesNotMatch(html, /1: const value/);
});

test("tool operations render as compact timeline rows", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "assistant",
      timestamp: 1000,
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: { command: "npm test" } }],
    },
    toolResults: new Map([[
      "call-1",
      { role: "toolResult", toolCallId: "call-1", content: [], timestamp: 3000 },
    ]]),
  }));

  assert.match(html, /data-activity-operation="true"/);
  assert.match(html, /activity-row-indicator/);
  assert.match(html, /activity-row-duration/);
  assert.doesNotMatch(html, /border-radius:7px/);
});
test("task tool results render a per-subagent summary panel", () => {
  const html = renderToStaticMarkup(React.createElement(TaskResultPanel, {
    details: {
      totalDurationMs: 360000,
      async: { state: "completed", jobId: "Scout", type: "task" },
      results: [
        { id: "Scout", agent: "scout", task: "Map the surface", exitCode: 0, tokens: 999000, cost: 1.25, durationMs: 360000, resolvedModel: "provider/gpt-5.6:medium" },
        { id: "Worker", agent: "worker", task: "Write the code", exitCode: 1, error: "Test failed", tokens: 500 },
      ],
    },
  }));

  assert.match(html, /Subagents/);
  assert.match(html, /Map the surface/);
  assert.match(html, /Write the code/);
  assert.match(html, /2 subagents/);
  assert.match(html, /999k tok/);
  assert.match(html, /gpt-5.6/);
  assert.match(html, /\u23a4|⤴/);
});

test("task panel renders nothing without task details", () => {
  assert.equal(renderToStaticMarkup(React.createElement(TaskResultPanel, { details: undefined })), "");
  assert.equal(renderToStaticMarkup(React.createElement(TaskResultPanel, { details: { patch: "p" } })), "");
});

test("async-only task details render the job as one started row", () => {
  const html = renderToStaticMarkup(React.createElement(TaskResultPanel, {
    details: { async: { state: "running", jobId: "AsyncAudit", type: "task" } },
  }));
  assert.match(html, /1 subagent/);
  assert.match(html, /AsyncAudit/);
  assert.doesNotMatch(html, /0 subagents/);
});

test("irc:incoming custom messages title with the sender name", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "custom",
      customType: "irc:incoming",
      content: "<irc>\nIncoming IRC message from agent `AuditUiComponents`:\n\nPlease review the current tree.\nThanks.",
      display: true,
    },
  }));
  assert.match(html, /AuditUiComponents/);
  assert.doesNotMatch(html, /irc:incoming/);
  assert.match(html, /Please review the current tree/);
  assert.doesNotMatch(html, /Incoming IRC message from agent/);
});

test("hub send renders as an IRC row with the steered message", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-hub-1", toolName: "hub", input: { op: "send", to: "VisualFix", message: "Please ensure the readout path is fixed.\nThanks." } }],
    },
    toolResults: new Map([[
      "call-hub-1",
      {
        role: "toolResult",
        toolCallId: "call-hub-1",
        toolName: "hub",
        content: [{ type: "text", text: "Delivered to 1 peer(s):\n- VisualFix: injected" }],
        details: { op: "send", to: ["VisualFix"], receipts: [{ to: "VisualFix", outcome: "injected" }] },
      },
    ]]),
  }));

  assert.match(html, /IRC → VisualFix injected/);
  assert.match(html, /Please ensure the readout path is fixed/);
  assert.doesNotMatch(html, /Delivered to 1 peer/);
});

test("hub jobs renders the waiting roster instead of raw markdown", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-hub-2", toolName: "hub", input: { op: "jobs" } }],
    },
    toolResults: new Map([[
      "call-hub-2",
      {
        role: "toolResult",
        toolCallId: "call-hub-2",
        toolName: "hub",
        content: [{ type: "text", text: "## Still Running (2)\n\n- `VisualFix` [task]" }],
        details: {
          op: "jobs",
          jobs: [
            { id: "VisualFix", type: "task", status: "running", label: "VisualFix", durationMs: 1890000 },
            { id: "VisualTrace", type: "task", status: "running", label: "VisualTrace", durationMs: 1890000 },
          ],
        },
      },
    ]]),
  }));

  assert.match(html, /waiting on 2 jobs/);
  assert.match(html, /VisualTrace/);
  assert.match(html, /31m30s/);
  assert.doesNotMatch(html, /Still Running/);
});

test("hub jobs without structured details keeps the raw result", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-hub-3", toolName: "hub", input: { op: "jobs" } }],
    },
    toolResults: new Map([[
      "call-hub-3",
      {
        role: "toolResult",
        toolCallId: "call-hub-3",
        toolName: "hub",
        content: [{ type: "text", text: "## Still Running (1)" }],
      },
    ]]),
  }));

  assert.match(html, /Still Running/);
});

test("advisor custom messages use the localized advisor label", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: { role: "custom", customType: "advisor", content: "Consider handling the edge case.", display: true },
  }));
  assert.match(html, /Advisor/);
  assert.match(html, /Consider handling the edge case/);
  assert.doesNotMatch(html, /customType/);
});

test("async-result notices start collapsed to their first line and expand to the exact line layout", () => {
  const view = render(React.createElement(MessageView, {
    message: {
      role: "custom",
      customType: "async-result",
      content: "<system-notice>\nBackground job bg_1 has completed. Resume your work using the result below.\n/root/repo\n---\nWall time: 0.16 seconds\n</system-notice>",
      display: true,
    },
  }));
  assert.equal(view.container.querySelector("pre"), null);
  assert.match(view.container.textContent, /Background job bg_1 has completed\. Resume your work using the result below\. …/);
  assert.doesNotMatch(view.container.textContent, /Wall time/);

  fireEvent.click(view.getByRole("button", { expanded: false }));
  const pre = view.container.querySelector("pre");
  assert.equal(pre.textContent, "Background job bg_1 has completed. Resume your work using the result below.\n/root/repo\n---\nWall time: 0.16 seconds");
  assert.match(pre.getAttribute("style"), /white-space: pre;/);
  assert.doesNotMatch(view.container.innerHTML, /system-notice|<h2/);
});

test("late LSP diagnostic notices expand to their exact line layout", () => {
  const view = render(React.createElement(MessageView, {
    message: {
      role: "custom",
      customType: "lsp-late-diagnostic",
      content: "<system-notice>\nLate LSP diagnostics arrived after the edit returned:\n/repo/a.py — 0 error(s), 1 warning(s)\n/repo/a.py:8:1 [warning] [Ruff] Import block is un-sorted or un-formatted\n\nhelp: Organize imports (I001)\n</system-notice>",
      display: true,
    },
  }));
  fireEvent.click(view.getByRole("button", { expanded: false }));
  assert.equal(
    view.container.querySelector("pre").textContent,
    "Late LSP diagnostics arrived after the edit returned:\n/repo/a.py — 0 error(s), 1 warning(s)\n/repo/a.py:8:1 [warning] [Ruff] Import block is un-sorted or un-formatted\n\nhelp: Organize imports (I001)",
  );
  assert.doesNotMatch(view.container.innerHTML, /system-notice/);
});

test("developer reminders show their wrapper attributes, start collapsed, and toggle from the header", () => {
  const view = render(React.createElement(MessageView, {
    message: {
      role: "custom",
      customType: "developer",
      content: [{ type: "text", text: '<system-reminder reason="rule_violation" rule="ts-no-tiny-functions" path="builtin-defaults:ts-no-tiny-functions.md" note="a>b">\nUser-defined rule matched tool-call arguments.\n\n## Why\n\n- One-line wrappers: no real behavior.\n</system-reminder>' }],
      display: true,
    },
  }));
  const header = view.getByRole("button", { expanded: false });
  assert.match(header.textContent, /^system-reminder · reason=rule_violation · rule=ts-no-tiny-functions · path=builtin-defaults:ts-no-tiny-functions\.md · note=a>b/);
  // A `>` inside an attribute value must not leak wrapper syntax into the body.
  assert.match(view.container.textContent, /User-defined rule matched tool-call arguments\. …/);
  assert.doesNotMatch(view.container.textContent, /b">/);
  assert.doesNotMatch(view.container.textContent, /One-line wrappers/);

  fireEvent.click(header);
  assert.equal(header.getAttribute("aria-expanded"), "true");
  assert.match(view.container.textContent, /One-line wrappers: no real behavior/);
  assert.doesNotMatch(view.container.textContent, /<system-reminder/);

  fireEvent.click(header);
  assert.doesNotMatch(view.container.textContent, /One-line wrappers/);
});

test("passive tool context from a session file renders on the batch's last tool card", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const entry = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: at, message });
  const { messages } = buildSessionContext([
    entry("u1", null, { role: "user", content: "look around" }),
    entry("a1", "u1", {
      role: "assistant", provider: "t", model: "m",
      content: [
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
        { type: "toolCall", id: "call-2", name: "bash", arguments: { command: "ls" } },
      ],
    }),
    entry("r1", "a1", { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "a" }] }),
    entry("r2", "r1", { role: "toolResult", toolCallId: "call-2", toolName: "bash", content: [{ type: "text", text: "b" }] }),
    entry("d1", "r2", {
      role: "developer", attribution: "agent", passiveToolContext: true, timestamp: 1,
      content: [{ type: "text", text: "\x1b[2mTreat\tthis result\nas authoritative.\x1b[0m" }],
    }),
    entry("d2", "d1", { role: "developer", content: [{ type: "text", text: "Unmarked steering note." }], timestamp: 2 }),
    entry("a2", "d2", { role: "assistant", provider: "t", model: "m", content: [{ type: "text", text: "Done." }] }),
  ]);
  const toolResults = collectToolResults(messages);
  const html = (message) => renderToStaticMarkup(React.createElement(MessageView, { message, toolResults, toolCallsDefaultCollapsed: false }));
  // Expanded tool group, collapsed cards: one truncating row on the last card, the full text on hover.
  const shown = html(messages[1]);
  assert.equal(shown.match(/>Context:/g)?.length, 1);
  assert.match(shown, /class="activity-row-secondary" title="Context: Treat\tthis result\nas authoritative\."><span aria-hidden="true">↳ <\/span>Context: Treat\tthis result\nas authoritative\./);
  assert.ok(shown.indexOf(">read<") < shown.indexOf(">bash<"));
  assert.ok(shown.indexOf("Context:") > shown.indexOf(">bash<"), "the line sits on the last card (call-2)");
  assert.doesNotMatch(shown, /tool-call-context/);
  // An expanded card shows the full text as its own segment at the end of its details instead.
  const single = { ...messages[1], content: [messages[1].content[1]] };
  const view = render(React.createElement(MessageView, { message: single, toolResults }));
  fireEvent.click(view.getByRole("button", { expanded: false }));
  const segment = view.container.querySelector(".tool-call-details .tool-call-context");
  assert.equal(segment?.textContent, "↳ Context: Treat\tthis result\nas authoritative.");
  assert.equal(view.container.querySelector(".activity-row-secondary[title]"), null, "no truncated row while expanded");
  // A harness wrapper shows as a label, titled like a developer message, never as raw tag text.
  const wrapped = new Map(toolResults);
  wrapped.set("call-2", { ...toolResults.get("call-2"), passiveContext: '<system-reminder reason="rule_violation" rule="ts-set-map">\nUse a Record.\n</system-reminder>' });
  const labeled = renderToStaticMarkup(React.createElement(MessageView, { message: single, toolResults: wrapped }));
  assert.match(labeled, /↳ <\/span>Context \(system-reminder · reason=rule_violation · rule=ts-set-map\): Use a Record\.<\/div>/);
  assert.doesNotMatch(labeled, /&lt;/);
  // The length cap can cut the closing tag; the opening tag still never leaks, and empty values drop out.
  wrapped.set("call-2", { ...toolResults.get("call-2"), passiveContext: '<system-reminder reason="" rule="ts-set-map">\nUse a Rec' });
  const cut = renderToStaticMarkup(React.createElement(MessageView, { message: single, toolResults: wrapped }));
  assert.match(cut, /↳ <\/span>Context \(system-reminder · rule=ts-set-map\): Use a Rec<\/div>/);
  assert.doesNotMatch(cut, /&lt;|reason=/);
  // Expanded, the wrapper becomes a nested card: its title as the header, the body below.
  wrapped.set("call-2", { ...toolResults.get("call-2"), passiveContext: '<system-reminder source="graphify">\nMANDATORY: run `graphify query`.\n</system-reminder>' });
  const card = render(React.createElement(MessageView, { message: single, toolResults: wrapped }));
  fireEvent.click(card.getAllByRole("button", { expanded: false }).at(-1));
  const nested = card.container.querySelector(".tool-call-details .tool-call-context-card");
  assert.equal(nested?.querySelector(".tool-call-context-title")?.textContent, "↳ system-reminder · source=graphify");
  assert.equal(nested?.querySelector(".tool-call-context-body")?.textContent, "MANDATORY: run `graphify query`.");
  // The marked message is no row of its own; the unmarked one still is.
  assert.equal(messages[4].customType, "passive-tool-context");
  assert.equal(html(messages[4]), "");
  assert.equal(messages[5].customType, "developer");
  assert.equal(messages[5].display, true);
  assert.match(html(messages[5]), /Unmarked steering note\./);
  assert.deepEqual(
    planTranscriptRows(messages)[0].segments.map((segment) => segment.kind === "text" ? "text" : segment.pieces.map((piece) => piece.index)),
    [[1, 5], "text"],
  );
});

test("a deferred thinking block rendered from a block subset loads its source block", async (t) => {
  const requested = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return new Response(JSON.stringify({ thinking: "loaded" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const view = render(React.createElement(MessageView, {
    message: { role: "assistant", provider: "t", model: "m", content: [{ type: "thinking", thinking: "", deferred: true }] },
    sessionId: "s1",
    entryId: "e1",
    sourceBlockIndices: [2],
  }));
  await act(async () => { fireEvent.click(view.container.querySelector(".activity-row-trigger")); });
  assert.equal(requested.length, 1);
  assert.match(requested[0], /\/entries\/e1\/thinking\?blockIndex=2$/);
});

test("thinking blocks stay collapsed by default and open with the expand preference", async () => {
  const message = {
    role: "assistant",
    provider: "t",
    model: "m",
    content: [{ type: "thinking", thinking: "weighing the options" }, { type: "text", text: "Answer" }],
  };
  const html = (props) => renderToStaticMarkup(React.createElement(MessageView, { message, ...props }));
  // Default (off): unchanged behavior — the reasoning text is not rendered.
  assert.doesNotMatch(html({}), /weighing the options/);
  assert.doesNotMatch(html({ expandThinkingByDefault: false }), /weighing the options/);
  // On: the block is open on mount, so reading reasoning needs no clicks.
  assert.match(html({ expandThinkingByDefault: true }), /weighing the options/);
  // The same initial state covers a streaming block on purpose (see ThinkingBlock):
  // the reasoning the preference is meant to expose is the one being written.
  assert.match(html({ expandThinkingByDefault: true, isStreaming: true }), /weighing the options/);
});

test("an expanded thinking block collapses and re-expands by hand", async () => {
  const message = {
    role: "assistant",
    provider: "t",
    model: "m",
    content: [{ type: "thinking", thinking: "weighing the options" }],
  };
  const view = render(React.createElement(MessageView, { message, expandThinkingByDefault: true }));
  const output = () => view.container.querySelector(".thinking-output")?.textContent;
  assert.equal(output(), "weighing the options");
  const trigger = view.container.querySelector(".activity-row-trigger");
  await act(async () => { fireEvent.click(trigger); });
  assert.equal(output(), undefined);
  await act(async () => { fireEvent.click(trigger); });
  assert.equal(output(), "weighing the options");
});

test("a deferred thinking block auto-expanded by the preference loads its source block", async (t) => {
  const requested = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return new Response(JSON.stringify({ thinking: "loaded" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  // Ids of their own: loadThinkingContent caches per (session, entry, block),
  // and the click test above already loaded s1/e1 block 2 in this process.
  const view = render(React.createElement(MessageView, {
    message: { role: "assistant", provider: "t", model: "m", content: [{ type: "thinking", thinking: "", deferred: true }] },
    sessionId: "s2",
    entryId: "e2",
    sourceBlockIndices: [3],
    expandThinkingByDefault: true,
  }));
  await waitFor(() => assert.equal(view.container.querySelector(".thinking-output")?.textContent, "loaded"));
  assert.equal(requested.length, 1);
  assert.match(requested[0], /\/entries\/e2\/thinking\?blockIndex=3$/);
});

test("a running tool call shows a spinner instead of the no-result marker", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: { command: "long-job" } }],
    },
    toolResults: new Map([[
      "call-1",
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [], partial: true },
    ]]),
  }));

  assert.match(html, /activity-row-spinner/);
  assert.doesNotMatch(html, /lucide-check/);
  assert.doesNotMatch(html, /lucide-circle-slash/);
});

test("a running tool with no output yet says so instead of reporting no output", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: { command: "long-job" } }],
    },
    toolResults: new Map([[
      "call-1",
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [], partial: true },
    ]]),
  }));

  assert.match(html, /data-tool-running="true"/);
  assert.doesNotMatch(html, /No output/);
});

test("a running tool streams its output before the result is committed", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: { command: "long-job" } }],
    },
    toolResults: new Map([[
      "call-1",
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "line-1\nline-2" }], partial: true },
    ]]),
  }));

  assert.match(html, /data-tool-output="true"/);
  assert.match(html, /line-1/);
  assert.match(html, /line-2/);
  assert.doesNotMatch(html, /data-tool-running="true"/);
});

test("a committed tool result replaces the running affordances", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: { command: "long-job" } }],
    },
    toolResults: new Map([[
      "call-1",
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "done" }], timestamp: 3000 },
    ]]),
  }));

  assert.doesNotMatch(html, /activity-row-spinner/);
  assert.doesNotMatch(html, /data-tool-running="true"/);
  assert.match(html, /lucide-check/);
});

test("expanded edit results with a patch render the split diff view", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "edit", input: { path: "demo.ts" } }],
    },
    toolResults: new Map([[
      "call-1",
      {
        role: "toolResult",
        toolCallId: "call-1",
        content: [{ type: "text", text: "Patch applied" }],
        details: {
          patch: "--- a/demo.ts\n+++ b/demo.ts\n@@ -1,1 +1,2 @@\n const keep = true;\n-dropped const gone = 1;\n+added const here = 2;",
        },
      },
    ]]),
  }));

  // Split diff grid (before/after columns) instead of the raw output <pre>.
  assert.match(html, /grid-template-columns:minmax\(0, ?1fr\) minmax\(0, ?1fr\)/);
  assert.match(html, /added const here = 2;/);
  assert.match(html, /dropped const gone = 1;/);
  assert.doesNotMatch(html, /<pre/);
});

test("parallel tool calls each render as their own row, never a merged group", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    toolCallsDefaultCollapsed: true,
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path: "a.ts" } },
        { type: "toolCall", toolCallId: "call-2", toolName: "read", input: { path: "b.ts" } },
        { type: "toolCall", toolCallId: "call-3", toolName: "grep", input: { pattern: "test" } },
      ],
    },
  }));

  assert.equal(html.match(/class="activity-row-trigger"/g)?.length, 3);
  for (const target of ["a.ts", "b.ts", "test"]) assert.match(html, new RegExp(target));
});

test("todo tool calls render clean status badge with action and task name", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", toolCallId: "call-1", toolName: "todo", input: { op: "done", task: "Build redesigned component" } },
      ],
    },
  }));

  assert.match(html, /tool-call-todo-badge/);
  assert.match(html, /Completed/);
  assert.match(html, /Build redesigned component/);
});

test("isInterruptedMessage identifies user interruptions accurately", () => {
  assert.equal(isInterruptedMessage("Interrupted by user"), true);
  assert.equal(isInterruptedMessage("interrupted by user"), true);
  assert.equal(isInterruptedMessage("Interrupted"), true);
  assert.equal(isInterruptedMessage("Request aborted"), true);
  assert.equal(isInterruptedMessage("Aborted"), true);
  assert.equal(isInterruptedMessage(null, "aborted"), true);
  assert.equal(isInterruptedMessage("Generation stopped by user"), true);
  assert.equal(isInterruptedMessage("429 Too Many Requests"), false);
  assert.equal(isInterruptedMessage("Provider connection failed"), false);
  assert.equal(isInterruptedMessage(null), false);
});

test("interrupted assistant message renders user-friendly status badge without responseError prefix", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      errorMessage: "Interrupted by user",
      content: [],
    },
  }));

  assert.match(html, /role="status"/);
  assert.match(html, /Generation interrupted/);
  assert.doesNotMatch(html, /messageView\.responseError/);
  assert.doesNotMatch(html, /Response error/);
  assert.doesNotMatch(html, /role="alert"/);
});

test("actual error assistant message renders alert badge without responseError prefix", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      errorMessage: "429 Too Many Requests: Rate limit exceeded",
      content: [],
    },
  }));

  assert.match(html, /role="alert"/);
  assert.match(html, /429 Too Many Requests: Rate limit exceeded/);
  assert.doesNotMatch(html, /messageView\.responseError/);
  assert.doesNotMatch(html, /Response error:/);
});

test("interrupted message with partial content renders content before interrupted badge", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      errorMessage: "Interrupted by user",
      content: [
        { type: "text", text: "Partial generated response text" },
      ],
    },
  }));

  const contentIdx = html.indexOf("Partial generated response text");
  const statusIdx = html.indexOf("Generation interrupted");
  assert.ok(contentIdx !== -1, "partial content must be rendered");
  assert.ok(statusIdx !== -1, "status badge must be rendered");
  assert.ok(contentIdx < statusIdx, "content must precede the interrupted status badge");
});

const FORK_LABEL = "Fork a new session from this point";

test("agent replies offer copy and fork at their resolved target", async (t) => {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  t.after(() => {
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
    else delete window.matchMedia;
  });
  const forked = [];
  const view = render(React.createElement(MessageView, {
    message: { role: "assistant", model: "test", provider: "test", content: [{ type: "text", text: "Done." }] },
    entryId: "assistant-1",
    // Resolved by resolveForkTargets: the newest reply falls back to its own
    // turn's prompt with edit-and-resend.
    forkEntryId: "user-1",
    forkEditsPrompt: true,
    onFork: (entryId, editPrompt) => forked.push([entryId, editPrompt]),
  }));
  assert.ok(view.getByRole("button", { name: "Copy message" }));
  await act(async () => { fireEvent.click(view.getByRole("button", { name: FORK_LABEL })); });
  assert.deepEqual(forked, [["user-1", true]]);
  view.unmount();
});

test("agent replies without text still offer the new-session action", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "assistant", model: "test", provider: "test",
      content: [{ type: "toolCall", toolCallId: "tool-1", toolName: "read", input: { path: "a.ts" } }],
    },
    entryId: "assistant-2",
    forkEntryId: "user-1",
    onFork: () => {},
  }));
  assert.doesNotMatch(html, /aria-label="Copy message"/);
  assert.match(html, new RegExp(`aria-label="${FORK_LABEL}"`));
});

test("a streaming reply and an unforkable row keep no fork action", () => {
  const reply = { role: "assistant", model: "test", provider: "test", content: [{ type: "text", text: "Streaming" }] };
  const streaming = renderToStaticMarkup(React.createElement(MessageView, {
    message: reply, entryId: "assistant-3", forkEntryId: "user-1", onFork: () => {}, isStreaming: true,
  }));
  assert.doesNotMatch(streaming, new RegExp(`aria-label="${FORK_LABEL}"`));
  assert.doesNotMatch(streaming, /aria-label="Copy message"/);
  assert.doesNotMatch(streaming, /aria-label="Read aloud"/);

  const noTarget = renderToStaticMarkup(React.createElement(MessageView, {
    message: reply, entryId: "assistant-4", onFork: () => {},
  }));
  assert.doesNotMatch(noTarget, new RegExp(`aria-label="${FORK_LABEL}"`));
});

test("user messages fork at their own entry and edit the prompt", async (t) => {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  t.after(() => {
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
    else delete window.matchMedia;
  });
  const forked = [];
  const view = render(React.createElement(MessageView, {
    message: { role: "user", content: "Keep this forkable." },
    entryId: "user-7",
    forkEntryId: "user-7",
    onFork: (entryId, editPrompt) => forked.push([entryId, editPrompt]),
  }));
  await act(async () => { fireEvent.click(view.getByRole("button", { name: FORK_LABEL })); });
  assert.deepEqual(forked, [["user-7", true]]);
  view.unmount();
});

test("user-bubble overflow toggle appears when a late-loading image pushes past the cap", (t) => {
  // Layout stub: the bubble fits its text at first; a loaded image grows
  // its scroll height past the 300px cap without resizing the capped box,
  // so the ResizeObserver never fires and only an image-load re-measure
  // can reveal the overflow.
  const originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; }
    observe() {}
    disconnect() {}
  };
  const proto = window.HTMLElement.prototype;
  const scrollHeight = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
  const clientHeight = Object.getOwnPropertyDescriptor(proto, "clientHeight");
  let grown = false;
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get() { return grown ? 900 : 300; } });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get() { return 300; } });
  t.after(() => {
    globalThis.ResizeObserver = originalResizeObserver;
    for (const [name, descriptor] of [["scrollHeight", scrollHeight], ["clientHeight", clientHeight]]) {
      if (descriptor) Object.defineProperty(proto, name, descriptor);
      else delete proto[name];
    }
  });

  const view = render(React.createElement(MessageView, {
    message: {
      role: "user",
      content: [{ type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", mimeType: "image/png" }],
    },
  }));
  assert.equal(view.queryByRole("button", { name: "Show full input" }), null);
  const img = view.container.querySelector("img");
  assert.ok(img, "user-bubble image must render");
  grown = true;
  fireEvent.load(img);
  assert.ok(view.getByRole("button", { name: "Show full input" }), "image load must re-measure overflow and reveal the toggle");
});
