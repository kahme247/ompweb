import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_SERVER_OUTBOX, applyOutboxSnapshot, mergeHeldMessages, rememberOutboxEntries } from "./useAgentSession-queue.ts";
import { readQueueSnapshot } from "../lib/client-message-ids";

const local = (id, createdAt, enqueueOrder) => ({ id, sessionId: "s", scope: "scope", mode: "followUp", message: id, state: "sending", createdAt, enqueueOrder });
const stored = (id, createdAt, state = "held") => ({ id, sessionId: "s", mode: "followUp", message: id, state, createdAt });
const order = (held) => held.map(({ id, local }) => `${id}:${local ? "browser" : "server"}`);

test("held messages keep delivery order across the browser-to-server handoff, whatever the two clocks say", () => {
  // Saved offline at 100 and 200 in this browser; the server accepted the first at 1000 and another device's at 1500.
  const browser = [local("first", 100, 1), local("second", 200, 2)];
  const server = applyOutboxSnapshot(EMPTY_SERVER_OUTBOX, [stored("first", 1000), stored("other-device", 1500)]);
  assert.deepEqual(order(mergeHeldMessages("s", browser, [], server)), ["first:server", "other-device:server", "second:browser"]);
});

test("a confirmation the server snapshot has not covered yet replaces the browser copy and stays ahead of later local entries", () => {
  const browser = [local("first", 100, 1), local("second", 200, 2), local("third", 300, 3)];
  const server = applyOutboxSnapshot(EMPTY_SERVER_OUTBOX, [stored("first", 1000)]);
  const confirmed = [stored("second", 1100), stored("gone", 900, "delivered")];
  assert.deepEqual(order(mergeHeldMessages("s", browser, confirmed, server)), ["first:server", "second:server", "third:browser"]);
  assert.deepEqual(order(mergeHeldMessages("s", [local("gone", 50, 0)], confirmed, EMPTY_SERVER_OUTBOX)), ["second:server"], "a delivered confirmation removes the browser copy");
});

test("queue snapshots retain aligned native client IDs, including uncorrelated slots", () => {
  assert.deepEqual(readQueueSnapshot({
    steering: ["same text", "same text"], followUp: ["later"],
    clientMessageIds: { steering: ["first-intent", null], followUp: ["later-intent"] },
  }), {
    steering: ["same text", "same text"], followUp: ["later"],
    clientMessageIds: { steering: ["first-intent", null], followUp: ["later-intent"] },
  });
  assert.deepEqual(readQueueSnapshot({ steering: ["legacy"], followUp: [] }), { steering: ["legacy"], followUp: [] },
    "legacy snapshots stay uncorrelated rather than acquiring guessed IDs");
  assert.deepEqual(readQueueSnapshot({
    steering: ["first", 42, "third"], followUp: [],
    clientMessageIds: { steering: ["first-id", "invalid-text-id", "third-id"], followUp: [] },
  }), {
    steering: ["first", "third"], followUp: [],
    clientMessageIds: { steering: ["first-id", "third-id"], followUp: [] },
  }, "filtering malformed queue text preserves its original ID alignment");
  assert.deepEqual(readQueueSnapshot({
    steering: ["first", "second"], followUp: [],
    clientMessageIds: { steering: ["cannot-prove-alignment"], followUp: [] },
  })?.clientMessageIds, { steering: [null, null], followUp: [] }, "misaligned ID arrays cannot identify either queue slot");
});

test("a worker replay of a browser copy never moves a server-remembered row back to its source session", () => {
  // The server moved the row to session "moved" (a native move); the worker still lists it under the session it was typed in.
  const moved = { ...stored("row", 1000, "delivered"), sessionId: "moved", settlement: "native" };
  let outbox = rememberOutboxEntries(EMPTY_SERVER_OUTBOX, [moved]);
  assert.equal(outbox.known.get("row")?.sessionId, "moved");
  for (let replay = 0; replay < 2; replay++) {
    outbox = rememberOutboxEntries(outbox, [local("row", 100, 1)], true);
    assert.equal(outbox.known.get("row")?.sessionId, "moved", `replay ${replay + 1}`);
  }
  assert.deepEqual(order(mergeHeldMessages("moved", [], [], outbox)), ["row:server"], "the moved session still shows its bridge");
  // A browser-only row has nothing to protect: its replay still remembers the browser's payload.
  assert.equal(rememberOutboxEntries(EMPTY_SERVER_OUTBOX, [local("only-here", 100, 1)], true).known.get("only-here")?.sessionId, "s");
});
