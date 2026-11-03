// Main's side of upload retention: a hello and a changed setting each send `setUploadRetention` to the daemon(s).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

const agentDir = mkdtempSync(join(tmpdir(), "omp-web-retention-sync-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const { HostOpError } = await import("./link-protocol.ts");
const { startUploadRetentionSync } = await import("./upload-retention-sync.ts");
const { saveWebServerSettings } = await import("../web-settings.ts");
const route = await import("../../app/api/web-settings/route.ts");
const { linkHost, linkLocalHost, until } = await import("./link-driver.test-helper.mjs");

const put = (body) => route.PUT(new Request("http://main.test/api/web-settings", { method: "PUT", body: JSON.stringify(body) }));

/** Serve the daemon end of `link`, recording each `setUploadRetention`'s args; `answer` decides the reply. */
function serveRetention(link, answer = () => null) {
  const seen = [];
  void link.serve({ setUploadRetention: (args) => { seen.push(args); return answer(); } });
  return seen;
}

test("a daemon that says hello is sent the current setting, again at its next hello", async (t) => {
  const stop = startUploadRetentionSync();
  t.after(stop);
  saveWebServerSettings({ uploadRetentionDays: 7 });
  const link = await linkHost("Retention hello");
  t.after(() => link.drop());
  const req = await link.next();
  assert.equal(req.type, "req");
  assert.equal(req.op, "setUploadRetention");
  assert.deepEqual(req.args, { days: 7 });
  await link.answer(req, null);

  link.drop();
  saveWebServerSettings({ uploadRetentionDays: null });
  await link.dial();
  const again = await link.next();
  assert.deepEqual([again.op, again.args], ["setUploadRetention", { days: null }]);
});

test("PUT /api/web-settings validates uploadRetentionDays and tells this machine and every linked host when it changes", async (t) => {
  saveWebServerSettings({ uploadRetentionDays: 30 });
  const remote = await linkHost("Retention remote");
  const local = await linkLocalHost();
  t.after(() => {
    remote.drop();
    local.drop();
  });
  const remoteSeen = serveRetention(remote);
  const localSeen = serveRetention(local);

  for (const bad of [0, -1, 1.5, 3651, "30", true, {}, []]) {
    const refused = await put({ uploadRetentionDays: bad });
    assert.equal(refused.status, 400, `${JSON.stringify(bad)} is refused`);
    assert.equal((await refused.json()).code, "invalid_settings");
  }
  assert.equal((await (await route.GET()).json()).uploadRetentionDays, 30, "a refused value changes nothing");
  await sleep(50);
  assert.deepEqual([remoteSeen, localSeen], [[], []]);

  // Unchanged: nothing is sent.
  assert.equal((await put({ uploadRetentionDays: 30 })).status, 200);
  assert.equal((await put({ autoResumeSessions: false })).status, 200);
  await sleep(50);
  assert.deepEqual([remoteSeen, localSeen], [[], []]);

  const changed = await put({ uploadRetentionDays: 90 });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).uploadRetentionDays, 90);
  await until(() => remoteSeen.length === 1 && localSeen.length === 1, "both hosts to be told");
  assert.deepEqual([remoteSeen, localSeen], [[{ days: 90 }], [{ days: 90 }]]);

  assert.equal((await put({ uploadRetentionDays: null })).status, 200);
  await until(() => remoteSeen.length === 2, "the host to be told never");
  assert.deepEqual(remoteSeen[1], { days: null });
  assert.equal((await (await route.GET()).json()).uploadRetentionDays, null);
});

test("an old daemon (501) and an offline host (503) are ignored silently; any other failure warns", async (t) => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  t.after(() => {
    console.warn = warn;
  });
  saveWebServerSettings({ uploadRetentionDays: 30 });
  const old = await linkHost("Retention old");
  const broken = await linkHost("Retention broken");
  const offline = await linkHost("Retention offline");
  offline.drop();
  t.after(() => {
    old.drop();
    broken.drop();
  });
  let oldCalls = 0;
  let brokenCalls = 0;
  void old.serve({ setUploadRetention: () => { oldCalls++; throw new HostOpError(501, "unknown_op", "Unknown host op: setUploadRetention"); } });
  void broken.serve({ setUploadRetention: () => { brokenCalls++; throw new HostOpError(500, "host_op_failed", "disk full"); } });

  assert.equal((await put({ uploadRetentionDays: 7 })).status, 200);
  await until(() => oldCalls === 1 && brokenCalls === 1, "both daemons to answer");
  await until(() => warnings.length > 0, "the failure to be reported");
  await sleep(50);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /disk full/);
});
