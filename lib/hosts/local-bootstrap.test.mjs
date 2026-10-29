import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const agentDir = mkdtempSync(join(tmpdir(), "omp-web-local-bootstrap-test-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url);
const { ensureLocalHostLink, localLinkUrl } = await jiti.import("./local-bootstrap.ts");
const { createHost, hostForToken, loadHosts, revokeHost, updateHost } = await jiti.import("./registry.ts");

const hostJson = join(agentDir, "omp-web", "host.json");
const readLogin = () => JSON.parse(readFileSync(hostJson, "utf8"));

test("bootstrap writes host.json (0600) with the loopback url and a token the registry accepts as local", () => {
  const { token, written } = ensureLocalHostLink({ url: "http://127.0.0.1:30177" });
  assert.equal(written, true);
  assert.deepEqual(readLogin(), { url: "http://127.0.0.1:30177", token });
  if (process.platform !== "win32") assert.equal(statSync(hostJson).mode & 0o777, 0o600);
  assert.equal(hostForToken(token)?.id, "local");
  assert.equal(loadHosts().filter((host) => host.id === "local").length, 1);
});

test("a second call with the same url keeps the token and does not rewrite", () => {
  const before = readLogin();
  const mtime = statSync(hostJson).mtimeMs;
  const { token, written } = ensureLocalHostLink({ url: "http://127.0.0.1:30177/" });
  assert.equal(written, false);
  assert.equal(token, before.token);
  assert.equal(statSync(hostJson).mtimeMs, mtime);
});

test("a new url is written with the same token", () => {
  const before = readLogin();
  const { token, written } = ensureLocalHostLink({ url: "http://127.0.0.1:40000" });
  assert.equal(written, true);
  assert.deepEqual(readLogin(), { url: "http://127.0.0.1:40000", token: before.token });
  assert.equal(token, before.token);
});

test("a host.json token the registry does not know is replaced, keeping one local record", () => {
  writeFileSync(hostJson, JSON.stringify({ url: "http://127.0.0.1:40000", token: "unknown" }));
  const { token, written } = ensureLocalHostLink({ url: "http://127.0.0.1:40000" });
  assert.equal(written, true);
  assert.notEqual(token, "unknown");
  assert.equal(hostForToken("unknown"), null);
  assert.equal(hostForToken(token)?.id, "local");
  assert.equal(loadHosts().filter((host) => host.id === "local").length, 1);
});

test("the registry refuses to revoke or edit local, and createHost never makes it", () => {
  assert.throws(() => revokeHost("local"), { name: "ReservedHostError" });
  assert.throws(() => updateHost("local", { label: "x" }), { name: "ReservedHostError" });
  assert.notEqual(createHost("laptop").host.id, "local");
  assert.equal(loadHosts().filter((host) => host.id === "local").length, 1);
});

test("the link url follows the launcher's port, and ::1 binds", () => {
  assert.equal(localLinkUrl({ OMP_WEB_PORT: "30177" }), "http://127.0.0.1:30177");
  assert.equal(localLinkUrl({ OMP_WEB_PORT: "30177", OMP_WEB_HOSTNAME: "0.0.0.0" }), "http://127.0.0.1:30177");
  assert.equal(localLinkUrl({ OMP_WEB_PORT: "30177", OMP_WEB_HOSTNAME: "::1" }), "http://[::1]:30177");
  assert.equal(localLinkUrl({}), null);
});
