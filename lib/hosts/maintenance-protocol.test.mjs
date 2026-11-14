import assert from "node:assert/strict";
import test from "node:test";
import { decodeFrame, encodeFrame, failure, MAINTENANCE_LIMITS, MaintenanceError, parseHello } from "./maintenance-protocol.ts";

const hello = (extra = {}) => ({ type: "hello", apiVersion: 1, protocolVersion: 12, ompwebVersion: "0.7.1", ompVersion: null, platform: "linux", capabilities: ["status", "updateSoftware"], ...extra });

test("a hello is read whatever the application protocol version, and unknown capabilities are dropped", () => {
  assert.deepEqual(parseHello(hello({ protocolVersion: 99, capabilities: ["status", "status", "future", 7] })), hello({ protocolVersion: 99, capabilities: ["status"] }));
  assert.equal(parseHello(hello({ ompVersion: "14.0.0" }))?.ompVersion, "14.0.0");
});

test("a hello of another API version or with a wrong field is refused", () => {
  for (const bad of [{ apiVersion: 2 }, { protocolVersion: 1.5 }, { protocolVersion: "12" }, { ompwebVersion: 1 }, { ompVersion: 3 }, { platform: "x".repeat(101) }, { capabilities: "status" }]) {
    assert.equal(parseHello(hello(bad)), null, JSON.stringify(bad));
  }
});

test("decodeFrame refuses what is not a bounded JSON object with a type", () => {
  assert.deepEqual(decodeFrame('{"type":"pong"}'), { type: "pong" });
  for (const bad of [new Uint8Array(2), "nope", "[]", "null", '{"id":1}', '{"type":3}']) assert.throws(() => decodeFrame(bad), (e) => e instanceof MaintenanceError && e.status === 400, String(bad));
  assert.throws(() => decodeFrame(JSON.stringify({ type: "x", pad: "x".repeat(MAINTENANCE_LIMITS.frameBytes) })), (e) => e.status === 413 && e.code === "too_large");
});

test("encodeFrame refuses a frame over the limit", () => {
  assert.throws(() => encodeFrame({ type: "res", result: "x".repeat(MAINTENANCE_LIMITS.frameBytes) }), (e) => e.status === 413);
});

test("failure keeps a native status and code and turns anything else into a 500", () => {
  assert.deepEqual(failure(new MaintenanceError(409, "update_busy", "busy")), { status: 409, code: "update_busy", message: "busy" });
  assert.deepEqual(failure({ status: 404, code: "session_not_running", message: "gone" }), { status: 404, code: "session_not_running", message: "gone" });
  assert.deepEqual(failure(Object.assign(new Error("busy"), { code: "host_busy", httpStatus: 409 })), { status: 409, code: "host_busy", message: "busy" });
  assert.deepEqual(failure(new Error("boom")), { status: 500, code: "internal", message: "boom" });
  assert.deepEqual(failure(Object.assign(new Error("x"), { code: "ENOENT", status: 200 })), { status: 500, code: "internal", message: "x" });
  assert.equal(failure({ status: 418, message: "tea" }).code, "host_error");
  assert.equal(failure("text").message, "text");
});
