import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export async function workspaceHarness() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "omp-workspace-it-")));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "main-agent");
  const hub = await import("./hub.ts");
  const linkRoute = await import("../../app/api/hosts/link/route.ts");
  const fileRoute = await import("../../app/api/files/[...path]/route.ts");
  const indexRoute = await import("../../app/api/file-index/route.ts");
  const uploadsRoute = await import("../../app/api/uploads/route.ts");
  const uploadRoute = await import("../../app/api/uploads/[id]/route.ts");
  const { createHost, rotateLocalHostToken } = await import("./registry.ts");
  const { closeOutboxStore } = await import("../message-outbox.ts");
  const children = [];
  const sockets = new Set();
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/hosts/link") return linkRoute.GET(req, { upgrade: (data) => server.upgrade(req, { data }) });
      if (url.pathname === "/api/file-index") return indexRoute.GET(req);
      if (url.pathname === "/api/uploads" && req.method === "POST") return uploadsRoute.POST(req);
      if (url.pathname.startsWith("/api/uploads/")) {
        const params = Promise.resolve({ id: decodeURIComponent(url.pathname.slice("/api/uploads/".length)) });
        if (req.method === "PUT") return uploadRoute.PUT(req, { params });
        if (req.method === "DELETE") return uploadRoute.DELETE(req, { params });
      }
      if (url.pathname.startsWith("/api/files/")) {
        const params = Promise.resolve({ path: url.pathname.slice("/api/files/".length).split("/").map(decodeURIComponent) });
        return fileRoute[req.method](req, { params, disableIdleTimeout: () => server.timeout(req, 0) });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: { ...hub.hostLinkSocket,
      open(ws) { sockets.add(ws); },
      close(ws, code, reason) { sockets.delete(ws); hub.hostLinkSocket.close(ws, code, reason); },
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  async function startHost(local = false, agentDirectory = null) {
    const record = local ? { host: { id: "local" }, token: rotateLocalHostToken() } : createHost(`Host ${children.length}`);
    const home = join(root, `daemon-${children.length}`);
    const agentDir = agentDirectory ?? join(home, ".omp", "agent");
    const project = join(home, "project");
    mkdirSync(join(agentDir, "omp-web"), { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(agentDir, "omp-web", "host.json"), JSON.stringify({ url, token: record.token }), { mode: 0o600 });
    const child = spawn("node", [fileURLToPath(new URL("../../bin/omp-web-host.js", import.meta.url))], {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home, PI_CONFIG_DIR: join(home, ".omp"), PI_CODING_AGENT_DIR: agentDir, OMP_WEB_OMP_BIN: join(home, "no-omp") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (chunk) => { log += chunk; });
    child.stderr.on("data", (chunk) => { log += chunk; });
    children.push(child);
    const deadline = Date.now() + 15_000;
    while (!["online", "omp-missing"].includes(hub.getHost(record.host.id).status())) {
      assert.equal(child.exitCode, null, log);
      assert.ok(Date.now() < deadline, `daemon did not link: ${log}`);
      await delay(20);
    }
    const host = hub.getHost(record.host.id);
    return { id: record.host.id, home, agentDir, project, host, child, log: () => log };
  }
  return {
    root, url, hub, server, sockets, startHost,
    file(hostId, path, type = "read", query = {}, headers = {}) {
      const params = new URLSearchParams({ hostId, type, ...query });
      return fetch(`${url}/api/files/${encodeURIComponent(path)}?${params}`, { headers });
    },
    async close() {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGTERM");
          await exited;
        }
      }
      await server.stop(true);
      hub.flushLinkSamples();
      // The upload registry opens the outbox store under this agent dir; Windows cannot remove an open SQLite file.
      closeOutboxStore();
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
