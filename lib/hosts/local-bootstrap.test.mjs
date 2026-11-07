import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const agentDir = mkdtempSync(join(tmpdir(), "omp-web-local-bootstrap-test-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(agentDir, { recursive: true, force: true });
});

const { ensureLocalHostLink, localLinkUrl } = await import("./local-bootstrap.ts");
const { createHost, hostForToken, loadHosts, revokeHost, updateHost } = await import("./registry.ts");

const hostJson = join(agentDir, "omp-web", "host.json");
const readLogin = () => JSON.parse(readFileSync(hostJson, "utf8"));

test("bootstrap writes host.json (0600) with the loopback url and a token the registry accepts as local", async () => {
  const { token, written } = await ensureLocalHostLink({ url: "http://127.0.0.1:30177" });
  assert.equal(written, true);
  assert.deepEqual(readLogin(), { url: "http://127.0.0.1:30177", token, links: [{ url: "http://127.0.0.1:30177", token }] });
  if (process.platform !== "win32") assert.equal(statSync(hostJson).mode & 0o777, 0o600);
  assert.equal(hostForToken(token)?.id, "local");
  assert.equal(loadHosts().filter((host) => host.id === "local").length, 1);
});

test("a second call with the same url keeps the token and does not rewrite", async () => {
  const before = readLogin();
  const mtime = statSync(hostJson).mtimeMs;
  const { token, written } = await ensureLocalHostLink({ url: "http://127.0.0.1:30177/" });
  assert.equal(written, false);
  assert.equal(token, before.token);
  assert.equal(statSync(hostJson).mtimeMs, mtime);
});

test("staging adds its own url with the same token without moving production", async () => {
  const before = readLogin();
  const { token, written } = await ensureLocalHostLink({ url: "http://127.0.0.1:40000" });
  assert.equal(written, true);
  assert.deepEqual(readLogin(), { ...before, links: [...before.links, { url: "http://127.0.0.1:40000", token: before.token }] });
  assert.equal(token, before.token);
});

test("a host.json token the registry does not know is replaced, keeping one local record", async () => {
  writeFileSync(hostJson, JSON.stringify({ url: "http://127.0.0.1:40000", token: "unknown" }));
  const { token, written } = await ensureLocalHostLink({ url: "http://127.0.0.1:40000" });
  assert.equal(written, true);
  assert.notEqual(token, "unknown");
  assert.equal(hostForToken("unknown"), null);
  assert.equal(hostForToken(token)?.id, "local");
  assert.equal(loadHosts().filter((host) => host.id === "local").length, 1);
});

test("concurrent first bootstraps share one accepted local token and retain both URLs", async () => {
  rmSync(hostJson);
  const urls = ["http://127.0.0.1:30177", "http://127.0.0.1:40000"];
  const results = await Promise.all(urls.map((url) => ensureLocalHostLink({ url })));
  assert.equal(results[0].token, results[1].token);
  assert.equal(hostForToken(results[0].token)?.id, "local");
  assert.deepEqual(new Set(readLogin().links.map((link) => link.url)), new Set(urls));
});

test("simultaneous fresh bootstrap processes retain both links with one accepted local token", { timeout: 20_000 }, async (t) => {
  rmSync(hostJson);
  const module = fileURLToPath(new URL("./local-bootstrap.ts", import.meta.url));
  const source = `import { createJiti } from "jiti"; const jiti = createJiti(import.meta.url); const { ensureLocalHostLink } = await jiti.import(process.env.BOOTSTRAP_MODULE); await ensureLocalHostLink({ url: process.env.BOOTSTRAP_URL });`;
  const urls = ["http://127.0.0.1:30177", "http://127.0.0.1:40000"];
  await Promise.all(urls.map((url) => {
    const child = spawn("node", ["--input-type=module", "-e", source], {
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, BOOTSTRAP_MODULE: module, BOOTSTRAP_URL: url },
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => child.kill("SIGKILL"));
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    return new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`bootstrap exited ${code}: ${stderr}`)));
    });
  }));
  const { links } = readLogin();
  assert.deepEqual(new Set(links.map((link) => link.url)), new Set(urls));
  assert.equal(new Set(links.map((link) => link.token)).size, 1);
  assert.equal(hostForToken(links[0].token)?.id, "local");
});

test("a valid secondary token is reused even if the legacy primary token is stale", async () => {
  const current = readLogin();
  writeFileSync(hostJson, JSON.stringify({ ...current, token: "stale" }));
  const { token, written } = await ensureLocalHostLink({ url: "http://127.0.0.1:41000" });
  assert.equal(hostForToken(token)?.id, "local");
  assert.equal(token, current.links[0].token);
  assert.equal(written, true);
  assert.equal(readLogin().token, "stale", "bootstrap never changes the legacy primary");
});

test("malformed host.json is left untouched before any local token rotation", async () => {
  const token = readLogin().links[0].token;
  writeFileSync(hostJson, "{broken");
  await assert.rejects(ensureLocalHostLink({ url: "http://127.0.0.1:40000" }), { name: "HostLoginUnreadableError" });
  assert.equal(readFileSync(hostJson, "utf8"), "{broken");
  assert.equal(hostForToken(token)?.id, "local");
});

test("the registry refuses to revoke local or change its agent-start right, and createHost never makes it", () => {
  assert.throws(() => revokeHost("local"), { name: "ReservedHostError" });
  assert.throws(() => updateHost("local", { allowAgentStart: false }), { name: "ReservedHostError" });
  assert.notEqual(createHost("laptop").host.id, "local");
  assert.equal(loadHosts().filter((host) => host.id === "local").length, 1);
});

test("the link url follows the launcher's port and bind address", () => {
  const url = (env) => localLinkUrl({ OMP_WEB_PORT: "30177", ...env });
  assert.deepEqual(url({}), { url: "http://127.0.0.1:30177" });
  assert.deepEqual(url({ OMP_WEB_HOSTNAME: "127.0.0.1" }), { url: "http://127.0.0.1:30177" });
  assert.deepEqual(url({ OMP_WEB_HOSTNAME: "0.0.0.0" }), { url: "http://127.0.0.1:30177" });
  assert.deepEqual(url({ OMP_WEB_HOSTNAME: "::" }), { url: "http://127.0.0.1:30177" });
  assert.deepEqual(url({ OMP_WEB_HOSTNAME: "::1" }), { url: "http://[::1]:30177" });
  assert.deepEqual(url({ OMP_WEB_HOSTNAME: "[::1]" }), { url: "http://[::1]:30177" });
  // localhost resolves to whichever family the server bound: dial it by name.
  assert.deepEqual(url({ OMP_WEB_HOSTNAME: "localhost" }), { url: "http://localhost:30177" });
  assert.deepEqual(url({ OMP_WEB_HOSTNAME: "127.0.0.2" }), { url: "http://127.0.0.2:30177" });
});

test("a bind address the daemon could only reach over plain http is skipped with the reason", () => {
  assert.match(localLinkUrl({ OMP_WEB_PORT: "30177", OMP_WEB_HOSTNAME: "100.64.0.1" }).skip, /100\.64\.0\.1.*not loopback/);
  assert.match(localLinkUrl({ OMP_WEB_PORT: "30177", OMP_WEB_HOSTNAME: "example.com" }).skip, /not loopback/);
  assert.match(localLinkUrl({}).skip, /OMP_WEB_PORT/);
});

test("a host.json that points at another server is left alone", async () => {
  const remote = JSON.stringify({ url: "https://main.example.com", token: "remote-token" });
  writeFileSync(hostJson, remote);
  await assert.rejects(ensureLocalHostLink({ url: "http://127.0.0.1:40000" }), /main\.example\.com/);
  assert.equal(readFileSync(hostJson, "utf8"), remote);
});
