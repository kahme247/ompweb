// The external omp boundary only; both web servers and the host daemon are real.
import * as fs from "node:fs";
import * as readline from "node:readline";
if (process.argv.includes("--version")) {
  console.log("18.15.0-multi-server-test");
  process.exit(0);
}
const sessionId = process.env.OMP_MULTI_SESSION_ID;
const sessionFile = process.env.OMP_MULTI_SESSION_FILE;
const record = (entry) => fs.appendFileSync(process.env.OMP_MULTI_LOG, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
let chunkNumber = 0;
const out = (frame) => {
  const data = Buffer.from(JSON.stringify(frame));
  if (data.length <= 1024 * 1024) return process.stdout.write(`${data}\n`);
  const count = Math.ceil(data.length / 262144), chunkId = `native-chunk-${++chunkNumber}`;
  for (let index = 0; index < count; index++) process.stdout.write(`${JSON.stringify({
    type: "rpc_chunk", chunkId, index, count, byteLength: data.length,
    data: data.subarray(index * 262144, (index + 1) * 262144).toString("base64"),
  })}\n`);
};
const resumed = process.argv.includes("--resume");
record({ type: "start", resumed });
let streaming = false;
let messages = [];
let timer;
let promptNumber = 0;
let question;
const saved = fs.readFileSync(sessionFile, "utf8").trim().split("\n").map(JSON.parse);
let parentId = saved.findLast((entry) => entry.type !== "session" && entry.id)?.id ?? null;
let entryNumber = 0;
const persist = (message) => {
  const id = `native-${process.pid}-${++entryNumber}`;
  fs.appendFileSync(sessionFile, `${JSON.stringify({ type: "message", id, parentId, timestamp: new Date().toISOString(), message })}\n`);
  parentId = id;
};
const end = () => {
  streaming = false;
  clearTimeout(timer);
  out({ type: "agent_end", isTerminal: true, messages: [] });
  out({ type: "session_settled" });
};
out({ type: "ready", supportedProtocolVersions: [1, 2] });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  record({ type: "stdin", command });
  const reply = (data = {}) => out({ type: "response", id: command.id, command: command.type, success: true, data });
  switch (command.type) {
    case "negotiate_protocol": return reply({ protocolVersion: 2 });
    case "get_state": return reply({ sessionId, sessionFile, cwd: process.cwd(), isStreaming: streaming, isSettled: !streaming, isCompacting: false, queuedMessages: [], messages });
    case "get_subagents": return reply({ subagents: [] });
    case "get_btw_history": return reply({ records: [] });
    case "abort":
    case "abort_and_restore_queue":
      reply({ messages: [] });
      return end();
    case "extension_ui_response":
      record({ type: "answer", id: command.id });
      question = undefined;
      return end();
    case "prompt": {
      reply({ agentInvoked: true });
      streaming = true;
      const n = ++promptNumber;
      const user = { role: "user", content: [{ type: "text", text: command.message }], timestamp: Date.now() };
      messages.push(user);
      out({ type: "agent_start" });
      out({ type: "message_start", messageId: `u${n}`, message: user });
      persist(user);
      out({ type: "message_end", messageId: `u${n}`, message: user });
      if (command.message === "ask") {
        question = { type: "extension_ui_request", id: `q${n}`, method: "ask", questions: [{ id: "pick", question: "Pick one", options: [{ label: "A" }, { label: "B" }] }] };
        out(question);
        return;
      }
      const assistant = { role: "assistant", content: [{ type: "text", text: "" }], timestamp: Date.now() };
      out({ type: "message_start", messageId: `a${n}`, message: assistant });
      assistant.content[0].text = "one";
      out({ type: "message_update", messageId: `a${n}`, message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "one" } });
      out({ type: "tool_execution_start", toolCallId: `t${n}`, toolName: "read", args: { path: "shared.txt" } });
      out({ type: "tool_execution_end", toolCallId: `t${n}`, toolName: "read",
        result: { content: [{ type: "text", text: "one shared result" }],
          ...(command.message === "from B" ? { details: { largeResult: "x".repeat(1_100_000) } } : {}) }, isError: false });
      timer = setInterval(() => {
        if (command.message === "slow" && !fs.existsSync(process.env.OMP_MULTI_RELEASE_FILE)) return;
        assistant.content[0].text = "one two";
        out({ type: "message_update", messageId: `a${n}`, message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " two" } });
        messages.push(assistant);
        persist(assistant);
        out({ type: "message_end", messageId: `a${n}`, message: assistant });
        end();
      }, command.message === "slow" ? 50 : 300);
      return;
    }
    default: return reply();
  }
});
process.stdin.on("end", () => process.exit(0));
