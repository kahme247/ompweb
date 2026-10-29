import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const agentDir = mkdtempSync(join(tmpdir(), "omp-web-hosts-route-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { alias: { "@/": new URL("../../", import.meta.url).pathname } });
const route = await jiti.import("../../app/api/hosts/route.ts");
const hub = await jiti.import("./hub.ts");
const { LINK_HELLO_HEADER, LINK_PROTOCOL_VERSION } = await jiti.import("./link-protocol.ts");

const hostsFile = join(agentDir, "omp-web", "hosts.json");
const BASE = "http://main.test/api/hosts";

const send = (method, body, headers = {}) =>
  route[method](new Request(BASE, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
const get = async () => (await route.GET()).json();

/** The daemon's dial: POST the hello, then GET the downlink with its id. A refused hello is returned as is. */
async function linkGet(token) {
  const hello = { type: "hello", v: LINK_PROTOCOL_VERSION, ompVersion: "14.0.0", platform: "linux", home: "/h", ack: 0, channels: [] };
  const offered = await hub.handleLinkPost(new Request(`${BASE}/link`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, [LINK_HELLO_HEADER]: "1" },
    body: JSON.stringify(hello),
  }));
  if (offered.status !== 200) return offered;
  return hub.handleLinkGet(new Request(`${BASE}/link`, {
    headers: { authorization: `Bearer ${token}`, [LINK_HELLO_HEADER]: (await offered.json()).helloId },
  }));
}

test("POST returns the token once; GET lists the host without any secret", async () => {
  const response = await send("POST", { label: "  laptop " }, { host: "omp.example.com:8443", "x-forwarded-proto": "https" });
  assert.equal(response.status, 200);
  const { host, token, command } = await response.json();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(host.label, "laptop");
  assert.equal(command, "ompweb host login --url https://omp.example.com:8443");

  const text = JSON.stringify(await get());
  assert.ok(!text.includes(token) && !text.includes("tokenHash"));
  const { hosts } = JSON.parse(text);
  assert.equal(hosts[0].id, "local");
  assert.ok(!("allowAgentStart" in hosts[0]));
  assert.deepEqual(hosts.slice(1).map((h) => [h.id, h.status, h.allowAgentStart]), [[host.id, "offline", false]]);
});

test("the command follows x-forwarded-host over the request host", async () => {
  const response = await send("POST", { label: "box" }, { "x-forwarded-host": "proxy.example.com", "x-forwarded-proto": "https" });
  assert.equal((await response.json()).command, "ompweb host login --url https://proxy.example.com");
});

test("DELETE revokes: the host's token then gets 401 on the link", async () => {
  const { host, token } = await (await send("POST", { label: "doomed" })).json();
  assert.equal((await linkGet(token)).status, 200);

  const response = await route.DELETE(new Request(`${BASE}?id=${host.id}`, { method: "DELETE" }));
  assert.equal(response.status, 200);
  assert.equal((await linkGet(token)).status, 401);
  assert.ok(!(await get()).hosts.some((h) => h.id === host.id));
  assert.equal((await route.DELETE(new Request(`${BASE}?id=${host.id}`, { method: "DELETE" }))).status, 404);
});

test("PATCH renames and toggles allowAgentStart; local cannot be edited or revoked", async () => {
  const { host } = await (await send("POST", { label: "old" })).json();
  const patched = await send("PATCH", { id: host.id, label: "new", allowAgentStart: true });
  assert.equal(patched.status, 200);
  assert.deepEqual((await get()).hosts.filter((h) => h.id === host.id).map((h) => [h.label, h.allowAgentStart]), [["new", true]]);

  assert.equal((await send("PATCH", { id: "local", label: "x" })).status, 400);
  assert.equal((await route.DELETE(new Request(`${BASE}?id=local`, { method: "DELETE" }))).status, 400);
  assert.equal((await send("PATCH", { id: "missing", label: "x" })).status, 404);
});

test("bodies are validated at the route", async () => {
  assert.equal((await send("POST", {})).status, 400);
  assert.equal((await send("POST", { label: "   " })).status, 400);
  assert.equal((await send("POST", { label: 5 })).status, 400);
  assert.equal((await send("POST", { label: "x".repeat(101) })).status, 400);
  assert.equal((await send("POST", { label: "x".repeat(100) })).status, 200);
  const { host } = await (await send("POST", { label: "ok" })).json();
  for (const body of [
    { id: host.id },
    { id: host.id, label: "" },
    { id: host.id, label: "y".repeat(101) },
    { id: host.id, allowAgentStart: "yes" },
    { label: "no id" },
  ]) assert.equal((await send("PATCH", body)).status, 400, JSON.stringify(body));
  assert.equal((await route.POST(new Request(BASE, { method: "POST", body: "{nope" }))).status, 400);
});

test("an unreadable hosts.json answers 503 and is never rewritten", async () => {
  const { host } = await (await send("POST", { label: "keep" })).json();
  const broken = "{not json";
  mkdirSync(join(hostsFile, ".."), { recursive: true });
  writeFileSync(hostsFile, broken);

  assert.equal((await send("POST", { label: "new" })).status, 503);
  assert.equal((await send("PATCH", { id: host.id, label: "x" })).status, 503);
  assert.equal((await route.DELETE(new Request(`${BASE}?id=${host.id}`, { method: "DELETE" }))).status, 503);
  assert.equal(readFileSync(hostsFile, "utf8"), broken);
});

test("the local row shows the reserved record's real link status; getHost(local) stays the direct host", async () => {
  writeFileSync(hostsFile, '{"hosts":[]}');
  const { localHost } = await jiti.import("./local-host.ts");
  const { ensureLocalHostLink } = await jiti.import("./local-bootstrap.ts");
  const localRows = async () => (await get()).hosts.filter((h) => h.id === "local");

  // Dev server, or before the first bootstrap: no record, no daemon.
  assert.deepEqual((await localRows()).map((h) => [h.label, h.status]), [["This machine", "offline"]]);
  assert.equal(hub.getLinkedHost("local"), null);

  const { token } = ensureLocalHostLink({ url: "http://127.0.0.1:30177" });
  assert.deepEqual((await localRows()).map((h) => h.status), ["offline"], "a record alone is not a link");

  assert.equal((await linkGet(token)).status, 200);
  const [row] = await localRows();
  assert.equal(row.status, "online");
  assert.equal(row.ompVersion, "14.0.0");
  assert.ok(!("allowAgentStart" in row), "the UI shows no revoke/rename controls for this machine");
  assert.equal((await get()).hosts[0].id, "local");
  assert.equal((await get()).hosts.filter((h) => h.id === "local").length, 1);

  assert.equal(hub.getHost("local"), localHost, "until the cutover, sessions run on the direct host");
  const linked = hub.getLinkedHost("local");
  assert.notEqual(linked, localHost);
  assert.equal(linked.id, "local");

  assert.equal((await send("PATCH", { id: "local", allowAgentStart: false })).status, 400);
  assert.equal((await route.DELETE(new Request(`${BASE}?id=local`, { method: "DELETE" }))).status, 400);
});
