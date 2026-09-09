import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MessageView, SafeMarkdownBody, TaskResultPanel } = await jiti.import("./MessageView.tsx");
const { CodeBlock } = await jiti.import("./MermaidBlock.tsx");

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

test("advisor custom messages use the localized advisor label", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: { role: "custom", customType: "advisor", content: "Consider handling the edge case.", display: true },
  }));
  assert.match(html, /Advisor/);
  assert.match(html, /Consider handling the edge case/);
  assert.doesNotMatch(html, /customType/);
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

test("consecutive tool calls group into an activity group summary", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
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

  assert.match(html, /activity-group/);
  assert.match(html, /Read 2 files and searched 1 time/);
});

test("bash (local) rows count as terminal commands in group summaries", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: true,
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: { command: "go vet ./..." } },
        { type: "toolCall", toolCallId: "call-2", toolName: "bash (local)", input: { command: "go test ./..." } },
      ],
    },
  }));

  assert.match(html, /Ran 2 commands/);
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
