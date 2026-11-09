import assert from "node:assert/strict";
import test from "node:test";

const { sessionOwnershipOn } = await import("./session-ownership.ts");
const { HostOpError, LINK_LIMITS } = await import("./hosts/link-protocol.ts");

/** A host whose session op answers through `answer(ids)`; a throw simulates a link failure. */
function fakeHost(id, answer, label = "Build box") {
  const calls = [];
  return {
    calls,
    host: {
      id,
      label,
      sessionOps: {
        async sessionOwnership(ids) {
          calls.push(ids);
          return answer(ids);
        },
      },
    },
  };
}

const ok = (ids) => ({ ok: true, value: ids.map((sessionId) => ({ id: sessionId, owner: "none" })) });

test("an older daemon's 501 becomes unknown for every id, logged once per host", async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (line) => warnings.push(String(line));
  try {
    const { host, calls } = fakeHost("old", async () => {
      throw new HostOpError(501, "unknown_op", "Unknown host op: sessionOwnership");
    });
    const ids = ["a", "b"];
    assert.deepEqual(await sessionOwnershipOn(host, ids), [{ id: "a", owner: "unknown" }, { id: "b", owner: "unknown" }]);
    await sessionOwnershipOn(host, ids);
    assert.equal(calls.length, 2, "each refresh asks again: the daemon may have been updated");
    assert.equal(warnings.length, 1, "the compatibility state is logged once, not on every refresh");
    assert.match(warnings[0], /older daemon/);
  } finally {
    console.warn = original;
  }
});

test("an offline host, a timeout and a malformed reply are all unknown, never none", async () => {
  for (const failure of [
    new HostOpError(503, "host_offline", "Build box is offline"),
    new HostOpError(504, "host_timeout", "Build box did not answer sessionOwnership in time"),
    new HostOpError(502, "host_bad_result", "Build box sent an invalid sessionOwnership result"),
  ]) {
    const { host } = fakeHost("down", async () => { throw failure; });
    assert.deepEqual(await sessionOwnershipOn(host, ["a"]), [{ id: "a", owner: "unknown" }], failure.code);
  }
  // A daemon that answers an OpResult failure (rather than throwing) is the same: not evidence of absence.
  const { host } = fakeHost("failed", async () => ({ ok: false, status: 500, code: "host_op_failed", error: "boom" }));
  assert.deepEqual(await sessionOwnershipOn(host, ["a"]), [{ id: "a", owner: "unknown" }]);
});

test("more than 256 ids are paged, so no id is silently skipped", async () => {
  const { host, calls } = fakeHost("big", async (ids) => ok(ids));
  const ids = Array.from({ length: LINK_LIMITS.ownershipIds * 2 + 7 }, (_, index) => `s${index}`);
  const answer = await sessionOwnershipOn(host, ids);
  assert.equal(answer.length, ids.length);
  assert.deepEqual(answer.map((entry) => entry.id), ids, "request order across pages");
  assert.deepEqual(calls.map((page) => page.length), [LINK_LIMITS.ownershipIds, LINK_LIMITS.ownershipIds, 7]);
});

test("a failed page answers unknown for its ids and the remaining pages are still asked", async () => {
  let page = 0;
  const { host, calls } = fakeHost("flaky", async (ids) => {
    page += 1;
    if (page === 1) throw new HostOpError(504, "host_timeout", "slow");
    return ok(ids);
  });
  const ids = Array.from({ length: LINK_LIMITS.ownershipIds + 3 }, (_, index) => `s${index}`);
  const answer = await sessionOwnershipOn(host, ids);
  assert.equal(calls.length, 2, "the second page was still asked");
  assert.deepEqual(answer.slice(0, LINK_LIMITS.ownershipIds).map((entry) => entry.owner), Array(LINK_LIMITS.ownershipIds).fill("unknown"));
  assert.deepEqual(answer.slice(LINK_LIMITS.ownershipIds).map((entry) => entry.owner), ["none", "none", "none"]);
});

test("a duplicate id is asked once and answered once", async () => {
  const { host, calls } = fakeHost("dup", async (ids) => ok(ids));
  const answer = await sessionOwnershipOn(host, ["a", "a", "b"]);
  assert.deepEqual(calls, [["a", "b"]]);
  assert.deepEqual(answer.map((entry) => entry.id), ["a", "b"]);
});

test("both wire shapes of one failure classify the same: a daemon 500 is unknown, a 400 propagates", async () => {
  // Thrown and returned failures of the same status must not disagree: a 500
  // is an inspection that could not answer, a 4xx is a caller bug.
  for (const status of [500, 501, 502, 503, 504, 429]) {
    const thrown = fakeHost("thrown", async () => { throw new HostOpError(status, "host_op_failed", "boom"); });
    assert.deepEqual(await sessionOwnershipOn(thrown.host, ["a"]), [{ id: "a", owner: "unknown" }], `thrown ${status}`);
    const returned = fakeHost("returned", async () => ({ ok: false, status, code: "host_op_failed", error: "boom" }));
    assert.deepEqual(await sessionOwnershipOn(returned.host, ["a"]), [{ id: "a", owner: "unknown" }], `returned ${status}`);
  }
  for (const status of [400, 404]) {
    const thrown = fakeHost("thrown-bad", async () => { throw new HostOpError(status, "invalid_request", "bad request"); });
    await assert.rejects(sessionOwnershipOn(thrown.host, ["a"]), (error) => error.status === status);
    const returned = fakeHost("returned-bad", async () => ({ ok: false, status, code: "invalid_request", error: "bad request" }));
    await assert.rejects(sessionOwnershipOn(returned.host, ["a"]), (error) => error.status === status);
  }
});

test("a caller bug (400) is not swallowed as an unknown answer", async () => {
  const { host } = fakeHost("bad", async () => { throw new HostOpError(400, "invalid_request", "Invalid session ids"); });
  await assert.rejects(sessionOwnershipOn(host, ["a"]), (error) => error.status === 400);
});
