import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

async function loadSubject() {
  return jiti.import("./transcript.ts");
}

test("renders user and assistant sections with header meta", async () => {
  const { transcriptToMarkdown } = await loadSubject();
  const md = transcriptToMarkdown(
    [
      { role: "user", content: "Hello world" },
      { role: "assistant", content: [{ type: "text", text: "Hi there" }], model: "m", provider: "p" },
    ],
    { title: "Demo", cwd: "/repo" },
  );
  assert.match(md, /^# Demo\n/);
  assert.match(md, /_\/repo_/);
  assert.match(md, /## User\n\nHello world/);
  assert.match(md, /## Assistant \(p\/m\)\n\nHi there/);
});

test("nests tool results under their tool call", async () => {
  const { transcriptToMarkdown } = await loadSubject();
  const md = transcriptToMarkdown([
    {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "t1", toolName: "read", input: { path: "a.ts" } }],
      model: "m",
      provider: "p",
    },
    { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "file bytes" }] },
  ]);
  assert.match(md, /### Tool: read `t1`/);
  assert.match(md, /"path": "a\.ts"/);
  assert.match(md, /\*\*Tool result: read\*\*/);
  assert.match(md, /```\nfile bytes\n```/);
  // Result consumed once — no orphan section.
  assert.equal(md.match(/Tool result/g)?.length, 1);
});

test("renders orphan tool results and shell executions", async () => {
  const { transcriptToMarkdown } = await loadSubject();
  const md = transcriptToMarkdown([
    { role: "toolResult", toolCallId: "ghost", content: [{ type: "text", text: "late output" }] },
    { role: "bashExecution", command: "git status", output: "clean", exitCode: 0 },
  ]);
  assert.match(md, /### Tool result: ghost/);
  assert.match(md, /### Shell: `git status`/);
  assert.match(md, /_exit 0_/);
});

test("wraps thinking in details and degrades images", async () => {
  const { transcriptToMarkdown } = await loadSubject();
  const md = transcriptToMarkdown([
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "blob:sha256:abc" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "done" },
      ],
      model: "m",
      provider: "p",
    },
  ]);
  assert.match(md, /\[attached image\]/);
  assert.match(md, /<details><summary>Thinking<\/summary>\n\nhmm\n\n<\/details>/);
});
test("uses tilde fences when fenced content holds backticks", async () => {
  const { transcriptToMarkdown } = await loadSubject();
  const md = transcriptToMarkdown([
    { role: "toolResult", toolCallId: "ghost", content: [{ type: "text", text: "```\ncode fence\n```" }] },
  ]);
  assert.match(md, /~~~~\n```\ncode fence\n```\n~~~~/);
});

test("truncates huge transcripts at the total limit", async () => {
  const { transcriptToMarkdown, TRANSCRIPT_TOTAL_CHAR_LIMIT } = await loadSubject();
  const messages = Array.from({ length: 30 }, (_, i) => ({ role: "user", content: `msg${i} ` + "x".repeat(20000) }));
  const md = transcriptToMarkdown(messages);
  assert.match(md, /transcript truncated/);
  assert.ok(md.length <= TRANSCRIPT_TOTAL_CHAR_LIMIT + 100);
});
