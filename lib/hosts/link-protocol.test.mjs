import assert from "node:assert/strict";
import test from "node:test";

async function load() {
  return import("./link-protocol.ts");
}

const MB = 1024 * 1024;

const DOWN = [
  { type: "welcome", v: 1, hostId: "h1" },
  { type: "stdin", seq: 1, ch: "c1", line: '{"type":"prompt"}' },
  { type: "kill", seq: 2, ch: "c1", force: true },
  { type: "req", seq: 3, id: "r1", op: "listSessions", args: { cwd: "/x" } },
  { type: "ping" },
  { type: "pong" },
  { type: "ack", ack: 7 },
];

const UP = [
  {
    type: "hello",
    v: 1,
    ompVersion: null,
    platform: "darwin",
    home: "/Users/me",
    autoApproveExtension: true,
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
  { type: "ack", ack: 7 },
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

test("ack is unsequenced and its value must be a safe non-negative integer", async () => {
  const { decodeDown, decodeUp, LinkProtocolError } = await load();
  assert.deepEqual(decodeDown('{"type":"ack","ack":5}'), { type: "ack", ack: 5 });
  assert.deepEqual(decodeUp('{"type":"ack","ack":5}'), { type: "ack", ack: 5 });
  for (const bad of ["-1", String(2 ** 53), '"5"']) {
    assert.throws(() => decodeDown(`{"type":"ack","ack":${bad}}`), LinkProtocolError, bad);
    assert.throws(() => decodeUp(`{"type":"ack","ack":${bad}}`), LinkProtocolError, bad);
  }
});

test("a blob frame carries its request id and the bytes without copying them", async () => {
  const { encodeBlobFrame, decodeBlobFrame } = await load();
  const frame = encodeBlobFrame("r-1", new Uint8Array([9, 8, 7]));
  assert.equal(frame[0], 3);
  const decoded = decodeBlobFrame(frame);
  assert.equal(decoded.id, "r-1");
  assert.deepEqual([...decoded.bytes], [9, 8, 7]);
  assert.equal(decoded.bytes.buffer, frame.buffer);
  const multi = encodeBlobFrame("é", new Uint8Array([1]));
  assert.equal(multi[0], 2);
  assert.equal(decodeBlobFrame(multi).id, "é");
});

test("blob frames with an empty, over-long or cut id are refused", async () => {
  const { encodeBlobFrame, decodeBlobFrame, LinkProtocolError } = await load();
  assert.throws(() => encodeBlobFrame("", new Uint8Array(1)), LinkProtocolError);
  assert.throws(() => encodeBlobFrame("x".repeat(256), new Uint8Array(1)), LinkProtocolError);
  for (const frame of [[], [0, 1], [5, 0x61]]) {
    assert.throws(() => decodeBlobFrame(new Uint8Array(frame)), LinkProtocolError, JSON.stringify(frame));
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

test("decodeDown accepts every host op name and passes an unknown one on for the daemon to answer", async () => {
  const { HOST_OP_NAMES, encodeLine, decodeDown } = await load();
  assert.equal(HOST_OP_NAMES.length, 20);
  for (const op of HOST_OP_NAMES) {
    const message = { type: "req", seq: 1, id: "x", op, args: null };
    assert.deepEqual(decodeDown(encodeLine(message)), message);
  }
  const unknownOp = { type: "req", seq: 1, id: "x", op: "exec", args: null };
  assert.deepEqual(decodeDown(encodeLine(unknownOp)), unknownOp);
});

test("decode turns an unknown message type into an unknown message and still checks the envelope", async () => {
  const { decodeDown, decodeUp, LinkProtocolError } = await load();
  assert.deepEqual(decodeDown('{"type":"future","seq":4,"x":1}'), { type: "unknown", messageType: "future", seq: 4, wrongDirection: false });
  assert.deepEqual(decodeUp('{"type":"future","seq":5}'), { type: "unknown", messageType: "future", seq: 5, wrongDirection: false });
  assert.deepEqual(decodeUp('{"type":"future"}'), { type: "unknown", messageType: "future", seq: null, wrongDirection: false });
  for (const line of ['{"seq":1}', '{"type":7,"seq":1}', '{"type":"future","seq":"1"}', '{"type":"future","seq":1.5}']) {
    assert.throws(() => decodeUp(line), LinkProtocolError, line);
    assert.throws(() => decodeDown(line), LinkProtocolError, line);
  }
  // A known type keeps its strict validation.
  assert.throws(() => decodeUp('{"type":"stdout","seq":1}'), LinkProtocolError);
});

test("a known type from the other direction is an unknown message marked wrongDirection", async () => {
  const { decodeDown, decodeUp } = await load();
  assert.deepEqual(decodeDown('{"type":"stdout","seq":1,"ch":"c","line":"x"}'), { type: "unknown", messageType: "stdout", seq: 1, wrongDirection: true });
  assert.deepEqual(decodeUp('{"type":"stdin","seq":1,"ch":"c","line":"x"}'), { type: "unknown", messageType: "stdin", seq: 1, wrongDirection: true });
  assert.deepEqual(decodeUp('{"type":"welcome","v":4,"hostId":"h"}'), { type: "unknown", messageType: "welcome", seq: null, wrongDirection: true });
});

test("every seq and ack must be a safe non-negative integer, so one line cannot jump the window", async () => {
  const { decodeDown, decodeUp, LinkProtocolError } = await load();
  const hello = (ack) => `{"type":"hello","v":3,"ompVersion":null,"platform":"linux","home":"/h","autoApproveExtension":false,"ack":${ack},"channels":[]}`;
  for (const seq of ["1e300", "-1", "9007199254740992"]) {
    for (const line of [`{"type":"future","seq":${seq}}`, `{"type":"stdout","seq":${seq},"ch":"c","line":"x"}`, `{"type":"stdin","seq":${seq},"ch":"c","line":"x"}`]) {
      assert.throws(() => decodeUp(line), LinkProtocolError, line);
      assert.throws(() => decodeDown(line), LinkProtocolError, line);
    }
    assert.throws(() => decodeUp(hello(seq)), LinkProtocolError, `hello ack ${seq}`);
  }
  assert.equal(decodeUp(hello(0)).ack, 0);
  assert.equal(decodeUp('{"type":"future","seq":9007199254740991}').seq, Number.MAX_SAFE_INTEGER);
});

test("decodeDown refuses a req whose op is not a string or whose args are missing", async () => {
  const { decodeDown, LinkProtocolError } = await load();
  for (const line of ['{"type":"req","seq":1,"id":"x","op":7,"args":{}}', '{"type":"req","seq":1,"id":"x","args":{}}', '{"type":"req","seq":1,"id":"x","op":"listSessions"}']) {
    assert.throws(() => decodeDown(line), LinkProtocolError, line);
  }
});

test("UnknownMessageLog notes each unknown type once, at most 16 types, escaped and truncated", async () => {
  const { UnknownMessageLog, UNKNOWN_LOG_CAP } = await load();
  assert.equal(UNKNOWN_LOG_CAP, 16);
  const unknown = (messageType, wrongDirection = false) => ({ type: "unknown", messageType, seq: 1, wrongDirection });
  const log = new UnknownMessageLog("daemon");
  const first = log.note(unknown("future"));
  assert.match(first, /"future"/);
  assert.equal(log.note(unknown("future")), null, "once per type");
  for (let i = 1; i < UNKNOWN_LOG_CAP; i++) assert.ok(log.note(unknown(`t${i}`)), `type ${i}`);
  assert.equal(log.note(unknown("one-too-many")), null, "past the cap nothing is logged");
  log.reset();
  assert.ok(log.note(unknown("future")), "a new link notes it again");

  const hostile = new UnknownMessageLog("daemon").note(unknown("a\nb\u001b[31m" + "x".repeat(7 * MB)));
  assert.ok(hostile.length < 200, `${hostile.length} chars`);
  assert.ok(!/[\n\u001b]/.test(hostile), "control characters are escaped");
  assert.ok(hostile.includes("\\n") && hostile.includes("\\u001b"));
});

test("UnknownMessageLog names the sender of a message that travelled the wrong way, every time, up to 16", async () => {
  const { UnknownMessageLog, UNKNOWN_LOG_CAP } = await load();
  const wrong = { type: "unknown", messageType: "stdout", seq: 1, wrongDirection: true };
  const log = new UnknownMessageLog("daemon");
  for (let i = 0; i < UNKNOWN_LOG_CAP; i++) assert.equal(log.note(wrong), '"stdout" is not valid from the daemon');
  assert.equal(log.note(wrong), null);
  assert.equal(new UnknownMessageLog("server").note({ ...wrong, messageType: "stdin" }), '"stdin" is not valid from the server');
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
    '{"type":"hello","v":3,"ompVersion":null,"platform":"linux","home":"/h","autoApproveExtension":false,"ack":0,"channels":[{"ch":"c","sessionId":null,"cwd":"/w"}]}',
    '{"type":"hello","v":3,"ompVersion":null,"platform":"linux","home":"/h","autoApproveExtension":false,"ack":0,"channels":[{"ch":"c","sessionId":null,"cwd":"/w","pending":[1]}]}',
    '{"type":"hello","v":3,"ompVersion":null,"platform":"linux","home":"/h","autoApproveExtension":false,"ack":0,"channels":[{"ch":"c","sessionId":null,"pending":[]}]}',
    '{"type":"hello","v":3,"ompVersion":null,"platform":"linux","home":"/h","ack":0,"channels":[]}',
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

/** Every unit `sender` hands out, numbered from 1 like a link direction. */
function drain(sender) {
  let seq = 0;
  const out = [];
  for (let unit = sender.next(() => ++seq); unit; unit = sender.next(() => ++seq)) out.push(unit);
  return out;
}

test("a line over pieceBytes goes as parts of at most pieceBytes that join back into it, numbered as they go out", async () => {
  const { decodeDown, encodeQueued, LINK_LIMITS, LinkSender, PartJoiner } = await load();
  const sender = new LinkSender(true);
  // Multi-byte and escaped characters, so a part's size is not its slice length.
  const big = encodeQueued({ type: "stdin", ch: "a", line: `${"é\"\\x".repeat(300_000)}\n` });
  sender.push("a", { line: big, size: Buffer.byteLength(big) });
  const units = drain(sender);
  assert.ok(units.length > 4);
  const joiner = new PartJoiner();
  let joined = null;
  units.forEach((unit, index) => {
    assert.equal(unit.seq, index + 1);
    assert.ok(Buffer.byteLength(unit.line) <= LINK_LIMITS.pieceBytes, `part ${index} is ${Buffer.byteLength(unit.line)} bytes`);
    const part = decodeDown(unit.line);
    assert.equal(part.type, "part");
    assert.equal(part.end, index === units.length - 1);
    assert.equal(unit.done, part.end);
    joined = joiner.add(part);
  });
  // The joined line keeps the seq it was cut with (0): the parts were deduped, not it.
  assert.deepEqual(decodeDown(joined), { type: "stdin", seq: 0, ch: "a", line: `${"é\"\\x".repeat(300_000)}\n` });
});

test("queuedBytes of a line sent in parts falls by the line's own bytes each part, and stays above 0 until the last", async () => {
  const { decodeDown, encodeQueued, LinkSender } = await load();
  const sender = new LinkSender(true);
  // Every character is escaped in the line and again in its part, so a part's encoded size is far above the bytes it consumes.
  const big = encodeQueued({ type: "stdin", ch: "a", line: `${"\"\\".repeat(600_000)}\n` });
  const size = Buffer.byteLength(big);
  sender.push("a", { line: big, size });
  assert.equal(sender.queuedBytes, size);
  let consumed = 0;
  let units = 0;
  for (let seq = 0, unit = sender.next(() => ++seq); unit; unit = sender.next(() => ++seq)) {
    units += 1;
    consumed += Buffer.byteLength(decodeDown(unit.line).data);
    if (unit.done) assert.equal(sender.queuedBytes, 0);
    else assert.equal(sender.queuedBytes, size - consumed, `after part ${units}`);
    if (!unit.done) assert.ok(sender.queuedBytes > 0);
  }
  assert.ok(units > 4);
  assert.equal(sender.queuedBytes, 0);
});

test("the sender round-robins keys, so a small message waits for one piece; one multi-part line at a time", async () => {
  const { decodeDown, encodeQueued, LinkSender } = await load();
  const sender = new LinkSender(true);
  const line = (ch, text) => {
    const encoded = encodeQueued({ type: "stdin", ch, line: text });
    return { line: encoded, size: Buffer.byteLength(encoded) };
  };
  sender.push("a", line("a", "x".repeat(1_000_000)));
  sender.push("b", line("b", "y".repeat(1_000_000)));
  sender.push("c", line("c", "small"));
  const order = drain(sender).map((unit) => {
    const message = decodeDown(unit.line);
    return message.type === "part" ? `${unit.key}${message.end ? "$" : ""}` : `${unit.key}:${message.line}`;
  });
  // c passes a's parts at once; b's parts wait until a's line is whole.
  assert.deepEqual(order.slice(0, 2), ["a", "c:small"]);
  assert.ok(order.indexOf("a$") < order.indexOf("b"), order.join(" "));
  assert.equal(order.filter((unit) => unit === "a$" || unit === "b$").length, 2);
});

test("for a v4 peer the sender sends long lines whole, still round-robin by key", async () => {
  const { decodeDown, encodeQueued, LinkSender } = await load();
  const sender = new LinkSender(false);
  for (const [ch, text] of [["a", "x".repeat(1_000_000)], ["a", "after"], ["b", "small"]]) {
    const encoded = encodeQueued({ type: "stdin", ch, line: text });
    sender.push(ch, { line: encoded, size: Buffer.byteLength(encoded) });
  }
  const units = drain(sender).map((unit) => decodeDown(unit.line));
  assert.deepEqual(units.map((m) => [m.type, m.seq, m.line.length]), [["stdin", 1, 1_000_000], ["stdin", 2, 5], ["stdin", 3, 5]]);
  assert.deepEqual(units.map((m) => m.ch), ["a", "b", "a"]);
});

test("result bytes go as binary frames of at most pieceBytes, interleaved with other keys, unnumbered", async () => {
  const { decodeBlobFrame, encodeQueued, LINK_LIMITS, LinkSender } = await load();
  const sender = new LinkSender(true);
  const blob = new Uint8Array(LINK_LIMITS.pieceBytes * 2 + 5).fill(7);
  sender.push("r1", { id: "r1", blob });
  const res = encodeQueued({ type: "res", id: "r1", ok: true, blob: { bytes: blob.byteLength } });
  sender.push("r1", { line: res, size: res.length });
  const echo = encodeQueued({ type: "stdout", ch: "c", line: "e" });
  sender.push("c", { line: echo, size: echo.length });
  const units = drain(sender);
  const pieces = units.filter((unit) => unit.frame).map((unit) => decodeBlobFrame(unit.frame));
  assert.deepEqual(pieces.map((piece) => [piece.id, piece.bytes.byteLength]), [["r1", LINK_LIMITS.pieceBytes], ["r1", LINK_LIMITS.pieceBytes], ["r1", 5]]);
  assert.deepEqual(units.map((unit) => unit.frame ? "piece" : JSON.parse(unit.line).type), ["piece", "stdout", "piece", "piece", "res"]);
  assert.deepEqual(units.filter((unit) => unit.line).map((unit) => unit.seq), [1, 2]);
});

test("PartJoiner drops a torn line, starts again at 0, and bounds a line at maxLineBytes", async () => {
  const { LINK_LIMITS, PartJoiner } = await load();
  const joiner = new PartJoiner();
  assert.equal(joiner.add({ at: 0, end: false, data: "ab" }), null);
  // A part that does not continue the line in progress: the line and the part are dropped.
  assert.equal(joiner.add({ at: 5, end: true, data: "x" }), null);
  assert.equal(joiner.add({ at: 2, end: true, data: "cd" }), null);
  // A new line at 0 replaces a partial one.
  assert.equal(joiner.add({ at: 0, end: false, data: "old" }), null);
  assert.equal(joiner.add({ at: 0, end: false, data: "ne" }), null);
  assert.equal(joiner.add({ at: 2, end: true, data: "w" }), "new");
  // Over the line limit: dropped, and its later parts too.
  const half = "z".repeat(LINK_LIMITS.maxLineBytes / 2 + 1);
  assert.equal(joiner.add({ at: 0, end: false, data: half }), null);
  assert.equal(joiner.add({ at: half.length, end: false, data: half }), null);
  assert.equal(joiner.add({ at: half.length * 2, end: true, data: "!" }), null);
  assert.equal(joiner.add({ at: 0, end: true, data: "ok" }), "ok");
});

test("part messages decode in both directions and check their fields", async () => {
  const { decodeDown, decodeUp, encodeLine, LinkProtocolError } = await load();
  const part = { type: "part", seq: 4, at: 10, end: false, data: '{"ty' };
  assert.deepEqual(decodeDown(encodeLine(part)), part);
  assert.deepEqual(decodeUp(encodeLine(part)), part);
  assert.throws(() => decodeUp(encodeLine({ ...part, at: -1 })), LinkProtocolError);
  assert.throws(() => decodeUp(encodeLine({ ...part, end: "no" })), LinkProtocolError);
  assert.throws(() => decodeDown(encodeLine({ ...part, data: 1 })), LinkProtocolError);
});

/** A queued stdin line on `ch` of `chars` characters. */
async function queued(ch, chars) {
  const { encodeQueued } = await load();
  const line = encodeQueued({ type: "stdin", ch, line: "x".repeat(chars) });
  return { line, size: Buffer.byteLength(line) };
}

test("a key dropped part-way through its line, or sent whole to a v4 peer, lets another key's line go in parts", async () => {
  const { decodeDown, LinkSender } = await load();
  let seq = 0;
  const nextSeq = () => ++seq;
  for (const release of ["drop", "v4"]) {
    const sender = new LinkSender(true);
    sender.push("a", await queued("a", 1_000_000));
    assert.equal(decodeDown(sender.next(nextSeq).line).type, "part");
    if (release === "drop") sender.drop("a");
    else {
      sender.parts = false;
      const whole = sender.next(nextSeq);
      assert.equal(decodeDown(whole.line).type, "stdin", "the rest goes whole to a v4 peer");
      assert.equal(whole.part, false);
      sender.parts = true;
    }
    sender.push("b", await queued("b", 1_000_000));
    const units = drain(sender);
    assert.ok(units.length > 1 && units.every((unit) => unit.key === "b" && unit.part), `${release}: ${units.length} units`);
  }
});

test("dropBlobs forgets unsent result bytes, partly sent ones included, and keeps the res behind them", async () => {
  const { encodeQueued, LINK_LIMITS, LinkSender } = await load();
  const sender = new LinkSender(true);
  sender.push("r1", { id: "r1", blob: new Uint8Array(LINK_LIMITS.pieceBytes * 3) });
  const res = encodeQueued({ type: "res", id: "r1", ok: true, blob: { bytes: LINK_LIMITS.pieceBytes * 3 } });
  sender.push("r1", { line: res, size: res.length });
  assert.ok(sender.next(() => 1).frame);
  sender.dropBlobs();
  const units = drain(sender);
  assert.deepEqual(units.map((unit) => JSON.parse(unit.line).type), ["res"]);
});

test("PartJoiner drops a line of more than maxParts parts", async () => {
  const { PartJoiner } = await load();
  const joiner = new PartJoiner();
  for (let at = 0; at < PartJoiner.maxParts; at++) assert.equal(joiner.add({ at, end: false, data: "a" }), null);
  assert.equal(joiner.add({ at: PartJoiner.maxParts, end: true, data: "a" }), null, "one part too many");
  for (let at = 0; at < PartJoiner.maxParts - 1; at++) joiner.add({ at, end: false, data: "a" });
  assert.equal(joiner.add({ at: PartJoiner.maxParts - 1, end: true, data: "a" }), "a".repeat(PartJoiner.maxParts));
});
