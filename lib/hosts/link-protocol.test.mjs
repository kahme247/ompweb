import assert from "node:assert/strict";
import test from "node:test";

async function load() {
  return import("./link-protocol.ts");
}

const MB = 1024 * 1024;

const DOWN = [
  { type: "welcome", v: 1, hostId: "h1", nonce: "n1" },
  { type: "stdin", seq: 1, ch: "c1", line: '{"type":"prompt"}' },
  { type: "kill", seq: 2, ch: "c1", force: true },
  { type: "req", seq: 3, id: "r1", op: "listSessions", args: { cwd: "/x" } },
  { type: "replaced", seq: 4 },
  { type: "ping" },
  { type: "pong" },
];

const UP = [
  {
    type: "hello",
    v: 1,
    ompVersion: null,
    platform: "darwin",
    home: "/Users/me",
    ack: 3,
    channels: [
      { ch: "c1", sessionId: "s1", cwd: "/Users/me/project", pending: ['{"type":"host_tool_call","id":"t1"}'] },
      { ch: "c2", sessionId: null, cwd: "/Users/me", pending: null },
    ],
  },
  { type: "stdout", seq: 1, ch: "c1", line: '{"type":"message_end"}' },
  { type: "stderr", seq: 2, ch: "c1", chunk: "warn\n" },
  { type: "exit", seq: 3, ch: "c1", code: 0, signal: null },
  { type: "resync", seq: 4, ch: "c1" },
  { type: "res", seq: 5, id: "r1", ok: true, result: [1, 2] },
  { type: "res", seq: 6, id: "r2", ok: true, blob: { bytes: 2_000_000 } },
  {
    type: "res",
    seq: 7,
    id: "r3",
    ok: false,
    error: { status: 404, code: "not_found", message: "no session" },
  },
  { type: "ping" },
  { type: "pong" },
];

test("round-trips every down message kind", async () => {
  const { encodeLine, decodeDown } = await load();
  for (const message of DOWN) {
    const line = encodeLine(message);
    assert.ok(line.endsWith("\n"), `${message.type} ends with newline`);
    assert.equal(line.indexOf("\n"), line.length - 1, `${message.type} is one line`);
    assert.deepEqual(decodeDown(line), message);
  }
});

test("round-trips every up message kind", async () => {
  const { encodeLine, decodeUp } = await load();
  for (const message of UP) {
    assert.deepEqual(decodeUp(encodeLine(message)), message);
  }
});

test("decodeUp returns an inline res exactly as sent", async () => {
  const { decodeUp } = await load();
  assert.deepEqual(decodeUp('{"type":"res","seq":1,"id":"a","ok":true,"result":1}'), {
    type: "res",
    seq: 1,
    id: "a",
    ok: true,
    result: 1,
  });
});

test("decodeDown accepts every host op name and rejects anything else", async () => {
  const { HOST_OP_NAMES, encodeLine, decodeDown, LinkProtocolError } = await load();
  assert.equal(HOST_OP_NAMES.length, 20);
  for (const op of HOST_OP_NAMES) {
    const message = { type: "req", seq: 1, id: "x", op, args: null };
    assert.deepEqual(decodeDown(encodeLine(message)), message);
  }
  assert.throws(
    () => decodeDown(encodeLine({ type: "req", seq: 1, id: "x", op: "exec", args: null })),
    LinkProtocolError,
  );
});

test("decode rejects messages travelling in the other direction", async () => {
  const { decodeDown, decodeUp, LinkProtocolError } = await load();
  assert.throws(
    () => decodeDown('{"type":"stdout","seq":1,"ch":"c","line":"x"}'),
    LinkProtocolError,
  );
  assert.throws(() => decodeUp('{"type":"stdin","seq":1,"ch":"c","line":"x"}'), LinkProtocolError);
});

test("decode rejects malformed lines with LinkProtocolError", async () => {
  const { decodeUp, LinkProtocolError } = await load();
  const bad = [
    "not json",
    "[]",
    "null",
    '{"seq":1}',
    '{"type":"stdout","seq":"1","ch":"c","line":"x"}',
    '{"type":"stdout","seq":1,"ch":"c"}',
    '{"type":"exit","seq":1,"ch":"c","code":"0","signal":null}',
    '{"type":"res","seq":1,"id":"a"}',
    '{"type":"res","seq":1,"id":"a","ok":false,"error":{"code":"x","message":"y"}}',
    '{"type":"hello","v":3,"ompVersion":null,"platform":"linux","home":"/h","ack":0,"channels":[{"ch":"c","sessionId":null,"cwd":"/w"}]}',
    '{"type":"hello","v":3,"ompVersion":null,"platform":"linux","home":"/h","ack":0,"channels":[{"ch":"c","sessionId":null,"cwd":"/w","pending":[1]}]}',
    '{"type":"hello","v":3,"ompVersion":null,"platform":"linux","home":"/h","ack":0,"channels":[{"ch":"c","sessionId":null,"pending":[]}]}',
  ];
  for (const line of bad) {
    assert.throws(() => decodeUp(line), LinkProtocolError, line);
  }
});

test("encodeLine throws LinkLimitError for a stdout line over 8 MB", async () => {
  const { encodeLine, LinkLimitError } = await load();
  const message = { type: "stdout", seq: 1, ch: "c1", line: "a".repeat(8 * MB + 1) };
  assert.throws(() => encodeLine(message), LinkLimitError);
});

test("encodeLine measures UTF-8 bytes, not characters", async () => {
  const { encodeLine, LinkLimitError } = await load();
  const twoBytePerChar = { type: "stdout", seq: 1, ch: "c1", line: "é".repeat(4 * MB + 1000) };
  assert.throws(() => encodeLine(twoBytePerChar), LinkLimitError);
  const fits = { type: "stdout", seq: 1, ch: "c1", line: "a".repeat(8 * MB - 1000) };
  assert.doesNotThrow(() => encodeLine(fits));
});

test("decode rejects an over-limit line before parsing it", async () => {
  const { decodeUp, LinkLimitError } = await load();
  const line = '{"type":"stdout","seq":1,"ch":"c","line":"' + "a".repeat(8 * MB) + '"}';
  assert.throws(() => decodeUp(line), LinkLimitError);
});

test("SeqWindow applies each seq once and tracks the high-water mark", async () => {
  const { SeqWindow } = await load();
  const window = new SeqWindow();
  assert.equal(window.acked, 0);
  assert.equal(window.applied(3), true);
  assert.equal(window.applied(3), false);
  assert.equal(window.acked, 3);
  assert.equal(window.applied(2), false);
  assert.equal(window.applied(4), true);
  assert.equal(window.acked, 4);
});

test("SeqWindow.next counts up from 1 on the sending side", async () => {
  const { SeqWindow } = await load();
  const window = new SeqWindow();
  assert.deepEqual([window.next(), window.next(), window.next()], [1, 2, 3]);
});

test("Outbox.ack drops acknowledged messages and keeps the rest in seq order", async () => {
  const { Outbox } = await load();
  const outbox = new Outbox();
  outbox.push({ seq: 1 });
  outbox.push({ seq: 2 });
  outbox.push({ seq: 3 });
  outbox.ack(2);
  assert.deepEqual(outbox.pending(), [{ seq: 3 }]);
  outbox.ack(1);
  assert.deepEqual(outbox.pending(), [{ seq: 3 }]);
});
