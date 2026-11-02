import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "ompweb-host-updates-route-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;
const hub = await import("./hub.ts");
const { linkHost, linkLocalHost } = await import("./link-driver.test-helper.mjs");
const { HostOpError, MIN_LINK_PROTOCOL_VERSION, LINK_PROTOCOL_VERSION } = await import("./link-protocol.ts");
after(() => {
  hub.flushLinkSamples();
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

const info = (protocol = LINK_PROTOCOL_VERSION) => ({
  ompweb: { currentVersion: "0.6.0", availableVersion: "0.7.0", updateAvailable: true, canUpdate: true, blockedReason: null, updateCommand: "npm install -g @kahme247/ompweb@0.7.0", installMethod: "npm", protocolVersion: protocol },
  omp: { currentVersion: "18.0.0", availableVersion: "19.0.0", updateAvailable: true, canUpdate: true, blockedReason: null, updateCommand: "omp update" },
  operation: null,
});
const body = { target: "ompweb", version: "0.7.0" };
const operation = { id: "attempt-1", target: "ompweb", version: "0.7.0", state: "running" };
async function route() {
  assert.equal(typeof hub.getHostSoftwareUpdates, "function", "host update checks are exposed through the host link");
  return import("../../app/api/hosts/[id]/updates/route.ts");
}
const context = (id) => ({ params: Promise.resolve({ id }) });
const post = (r, id, data = body, headers = {}) => r.POST(new Request(`http://main.test/api/hosts/${id}/updates`, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(data),
}), context(id));

for (const local of [false, true]) test(`software checks and updates target only the ${local ? "local" : "chosen remote"} daemon`, async (t) => {
  const r = await route();
  const link = local ? await linkLocalHost() : await linkHost("Chosen host", { hello: { ompwebVersion: "0.6.0" } });
  t.after(() => {
    link.drop();
    if (local) {
      hub.closeHostLink("local");
      globalThis.__ompHostHub.links.delete("local");
    }
  });
  const seen = [];
  link.serve({
    checkUpdates: (args) => { seen.push(["check", args]); return info(); },
    updateSoftware: (args) => { seen.push(["update", args]); return { accepted: true, operation }; },
  });
  const res = await r.GET(new Request(`http://main.test/api/hosts/${link.id}/updates?force=1`), context(link.id));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ompweb.currentVersion, "0.6.0");
  assert.equal(res.headers.get("cache-control"), "no-store");
  if (!local) assert.equal(hub.hostsSnapshot().hosts.find((host) => host.id === link.id).ompwebVersion, "0.6.0");
  const updated = await post(r, link.id);
  assert.equal(updated.status, 202);
  assert.deepEqual((await updated.json()).operation, operation);
  assert.ok(seen.some(([name, args]) => name === "check" && args.force === true));
  for (const [, args] of seen) assert.deepEqual(args.compatibility, { min: MIN_LINK_PROTOCOL_VERSION, max: LINK_PROTOCOL_VERSION });
});

for (const protocol of [null, LINK_PROTOCOL_VERSION + 1, MIN_LINK_PROTOCOL_VERSION - 1]) test(`an available daemon protocol ${protocol} is visible but cannot be installed even if its host says canUpdate`, async (t) => {
  const r = await route();
  const link = await linkHost("Incompatible host");
  t.after(() => link.drop());
  let installs = 0;
  link.serve({ checkUpdates: () => info(protocol), updateSoftware: (args) => { installs++; return { accepted: true, operation: { ...operation, target: args.target, version: args.version } }; } });
  const checked = await r.GET(new Request(`http://main.test/api/hosts/${link.id}/updates`), context(link.id));
  const result = await checked.json();
  assert.equal(result.ompweb.updateAvailable, true);
  assert.equal(result.ompweb.canUpdate, false);
  assert.ok(result.ompweb.blockedReason);
  assert.equal((await post(r, link.id)).status, 409);
  assert.equal(installs, 0);
  assert.equal((await post(r, link.id, { target: "omp", version: "19.0.0" })).status, 202, "OMP itself does not change the link protocol");
});

test("unknown hosts, offline hosts and old daemons give explicit failures, never run locally", async (t) => {
  const r = await route();
  assert.equal((await r.GET(new Request("http://main.test/api/hosts/missing/updates"), context("missing"))).status, 404);
  const link = await linkHost("Older daemon");
  t.after(() => link.drop());
  link.serve({ checkUpdates: () => { throw new HostOpError(501, "unknown_op", "Unknown host op: checkUpdates"); } });
  assert.equal((await r.GET(new Request(`http://main.test/api/hosts/${link.id}/updates`), context(link.id))).status, 501);
  link.drop();
  assert.equal((await r.GET(new Request(`http://main.test/api/hosts/${link.id}/updates`), context(link.id))).status, 503);
});

test("the browser cannot supply compatibility, commands or an arbitrary target version", async (t) => {
  const r = await route();
  const link = await linkHost("Boundary");
  t.after(() => link.drop());
  let installs = 0;
  link.serve({ checkUpdates: () => info(), updateSoftware: () => { installs++; return { accepted: true, operation }; } });
  for (const bad of [{ ...body, compatibility: { min: 1, max: 99 } }, { target: "shell", version: "1.0.0" }, { ...body, version: "$(touch x)" }, { ...body, command: "reboot" }]) {
    assert.equal((await post(r, link.id, bad)).status, 400);
  }
  assert.equal((await post(r, link.id, { ...body, version: "0.8.0" })).status, 409, "a stale candidate cannot be installed");
  assert.equal((await post(r, link.id, body, { origin: "https://other.test" })).status, 403);
  assert.equal(installs, 0);
});

test("the web server's disabled-update policy blocks host checks and installs before any host operation", async (t) => {
  const r = await route();
  const link = await linkHost("Disabled updates");
  t.after(() => link.drop());
  const previous = process.env.OMP_WEB_DISABLE_AUTOUPDATE;
  process.env.OMP_WEB_DISABLE_AUTOUPDATE = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.OMP_WEB_DISABLE_AUTOUPDATE;
    else process.env.OMP_WEB_DISABLE_AUTOUPDATE = previous;
  });
  let checks = 0;
  link.serve({ checkUpdates: () => { checks++; return info(); } });
  assert.equal((await r.GET(new Request(`http://main.test/api/hosts/${link.id}/updates`), context(link.id))).status, 403);
  assert.equal((await post(r, link.id)).status, 403);
  assert.equal(checks, 0);
});
