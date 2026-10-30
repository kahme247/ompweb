// `npm run smoke [-- --package <dir> | --binary <path>]`: starts ompweb (`node <dir>/bin/omp-web.js`, or the compiled
// binary) on a free port with a throwaway HOME, then `ompweb host` from the same install, and checks the shipped
// bundle, the SPA, a hashed asset, the API, a session listed through the daemon and the SSE stream, then stops both.
// <dir>: the repo root (after `npm run build`) or a packed install; <path>: release/ompweb-<os>-<arch>/ompweb, whose
// directory holds the static files. Prints one `ok <step>` / `FAIL <step>: <detail>` line per step.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { package: { type: "string" }, binary: { type: "string" } } });
const binary = values.binary && path.resolve(values.binary);
const dir = binary ? path.dirname(binary) : path.resolve(values.package ?? path.join(import.meta.dir, ".."));
const ompweb = binary ? [binary] : ["node", path.join(dir, "bin", "omp-web.js")];

let failed = false;
async function step(name: string, run: () => unknown): Promise<boolean> {
  try {
    await run();
    console.log(`ok ${name}`);
    return true;
  } catch (error) {
    failed = true;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function portOpen(port: number): Promise<boolean> {
  try {
    (await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } })).end();
    return true;
  } catch {
    return false;
  }
}

async function readText(stream: ReadableStream<Uint8Array>, onText: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) onText(decoder.decode(chunk.value, { stream: true }));
}

// shortcut: also fails on a guarded `typeof process !== "undefined" && process.env.X` (none ship today); allow such
// a reference by name if a dependency ever needs one.
await step("client bundle has no process.env (browsers have no process)", async () => {
  const dist = path.join(dir, "dist");
  const hits: string[] = [];
  let files = 0;
  for await (const file of new Bun.Glob("**/*.js").scan(dist)) {
    files += 1;
    const names = (await Bun.file(path.join(dist, file)).text()).match(/process\.env\b(\.\w+)?/g);
    if (names) hits.push(`${file}: ${[...new Set(names)].join(", ")}`);
  }
  assert(files > 0, `no .js files under ${dist}`);
  assert(hits.length === 0, hits.join("; "));
});

const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const { port } = probe;
probe.stop(true);
const base = `http://127.0.0.1:${port}`;

const temp = mkdtempSync(path.join(os.tmpdir(), "ompweb-smoke-"));
const home = path.join(temp, "home");
const agentDir = path.join(home, ".omp", "agent");
mkdirSync(agentDir, { recursive: true });
// The daemon lists it: its id must be a UUID, and its cwd must exist.
const SESSION_ID = "5a0c0e5e-0000-4000-8000-000000000001";
const projectDir = path.join(temp, "project");
mkdirSync(projectDir);
mkdirSync(path.join(agentDir, "sessions", "-project"), { recursive: true });
writeFileSync(path.join(agentDir, "sessions", "-project", `2026-01-01_${SESSION_ID}.jsonl`), [
  { type: "session", version: 3, id: SESSION_ID, cwd: projectDir, timestamp: "2026-01-01T00:00:00.000Z" },
  { type: "message", id: "m0", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
  { type: "message", id: "m1", parentId: "m0", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
].map((line) => `${JSON.stringify(line)}\n`).join(""));
// USERPROFILE: os.homedir() on Windows, so the real ~/.omp stays untouched there too.
const env: Record<string, string | undefined> = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  PI_CODING_AGENT_DIR: agentDir,
  OMP_WEB_OMP_BIN: path.join(temp, "missing-omp"),
};
for (const name of ["OMP_WEB_PASSWORD", "OMP_WEB_PASSWORD_HASH"]) delete env[name];

let log = "";
let launcher: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
const stop = (child: Bun.Subprocess) => {
  if (process.platform === "win32") Bun.spawnSync(["taskkill", "/pid", String(child.pid), "/t", "/f"]);
  else child.kill("SIGTERM");
};
try {
  const ready = Promise.withResolvers<void>();
  const started = await step(`launcher prints Ready on port ${port}`, async () => {
    const child = Bun.spawn([...ompweb, "-p", String(port), "-H", "127.0.0.1", "--no-open"], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    launcher = child;
    let stdout = "";
    void readText(child.stdout, (text) => {
      log += text;
      stdout += text;
      if (stdout.includes("Ready")) ready.resolve();
    });
    void readText(child.stderr, (text) => { log += text; });
    const outcome = await Promise.race([
      ready.promise.then(() => "ready"),
      child.exited.then((code) => `launcher exited with ${code}`),
      Bun.sleep(60_000).then(() => "no Ready on stdout within 60 s"),
    ]);
    assert(outcome === "ready", outcome);
  });

  if (started) {
    let html = "";
    await step("GET / serves the SPA with no-cache", async () => {
      const response = await fetch(`${base}/`);
      html = await response.text();
      assert(response.status === 200, `status ${response.status}`);
      assert(response.headers.get("content-type")?.startsWith("text/html"), `content-type ${response.headers.get("content-type")}`);
      assert(html.includes('id="root"'), 'no id="root" in the page');
      assert(response.headers.get("cache-control")?.includes("no-cache"), `cache-control ${response.headers.get("cache-control")}`);
    });

    await step("first /assets/*.js is immutable and gzipped", async () => {
      const asset = /\/assets\/[^"'\s]+\.js/.exec(html)?.[0];
      assert(asset, "the page names no /assets/*.js");
      const response = await fetch(`${base}${asset}`, { headers: { "accept-encoding": "gzip" } });
      await response.arrayBuffer();
      assert(response.status === 200, `${asset}: status ${response.status}`);
      assert(response.headers.get("cache-control")?.includes("immutable"), `${asset}: cache-control ${response.headers.get("cache-control")}`);
      assert(response.headers.get("content-encoding") === "gzip", `${asset}: content-encoding ${response.headers.get("content-encoding")}`);
    });

    await step("GET /api/hosts returns JSON", async () => {
      const response = await fetch(`${base}/api/hosts`);
      assert(response.status === 200, `status ${response.status}`);
      assert(response.headers.get("content-type")?.startsWith("application/json"), `content-type ${response.headers.get("content-type")}`);
      await response.json();
    });

    await step("`ompweb host` links this machine", async () => {
      const child = Bun.spawn([...ompweb, "host"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      daemon = child;
      void readText(child.stdout, (text) => { log += text; });
      void readText(child.stderr, (text) => { log += text; });
      const deadline = Date.now() + 30_000;
      for (;;) {
        const { hosts } = await (await fetch(`${base}/api/hosts`)).json() as { hosts: { id: string; status: string }[] };
        // Linked: "omp-missing" rather than "online", as OMP_WEB_OMP_BIN names no omp.
        if (hosts.find((host) => host.id === "local")?.status === "omp-missing") break;
        assert(child.exitCode === null, `ompweb host exited with ${child.exitCode}`);
        assert(Date.now() < deadline, "this machine is not linked 30 s after `ompweb host` started");
        await Bun.sleep(200);
      }
    });

    // Sessions list only through the daemon, so this also proves the server ran as production: it wrote the link.
    await step("GET /api/sessions lists the session through the daemon", async () => {
      const response = await fetch(`${base}/api/sessions`);
      assert(response.status === 200, `status ${response.status}`);
      const { sessions } = await response.json() as { sessions: { id: string }[] };
      assert(sessions.some((session) => session.id === SESSION_ID), `listed: ${sessions.map((session) => session.id).join(", ") || "none"}`);
    });

    if (binary) {
      await step("the binary points updates at the release page and refuses in-app updates", async () => {
        const update = await (await fetch(`${base}/api/app-update`)).json() as { installMethod?: string; selfUpdateSupported?: boolean; updateCommand?: string };
        assert(update.installMethod === "binary" && update.selfUpdateSupported === false, JSON.stringify(update));
        assert(update.updateCommand?.startsWith("https://github.com/kahme247/ompweb/releases"), `updateCommand ${update.updateCommand}`);
        // Started, the worker would run on this binary: a second ompweb, not the update.
        const response = await fetch(`${base}/api/omp-update`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "update" }) });
        assert(response.status === 409, `POST /api/omp-update update: status ${response.status}`);
      });
    }

    await step("GET /api/events delivers an event and stays open for 12 s", async () => {
      const abort = new AbortController();
      try {
        const response = await fetch(`${base}/api/events`, { signal: abort.signal });
        assert(response.status === 200 && response.body, `status ${response.status}`);
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let text = "";
        while (!text.includes("\n\n")) {
          const chunk = await Promise.race([reader.read(), Bun.sleep(10_000).then(() => null)]);
          assert(chunk, "no event within 10 s");
          assert(!chunk.done, "the stream ended before its first event");
          text += chunk.value;
        }
        let open = true;
        void (async () => { while (!(await reader.read()).done); })().catch(() => {}).finally(() => { open = false; });
        await Bun.sleep(12_000);
        assert(open, "the stream closed within 12 s of its first event");
      } finally {
        abort.abort();
      }
    });
  }
} finally {
  if (daemon) {
    const child = daemon;
    await step("`ompweb host` stops", async () => {
      stop(child);
      const outcome = await Promise.race([child.exited, Bun.sleep(15_000).then(() => "running")]);
      assert(outcome !== "running", "ompweb host still runs 15 s after the stop");
    });
  }
  if (launcher) {
    const child = launcher;
    await step("launcher stops and the port closes", async () => {
      stop(child);
      const deadline = Date.now() + 15_000;
      while (await portOpen(port)) {
        assert(Date.now() < deadline, `port ${port} still accepts connections 15 s after the stop`);
        await Bun.sleep(200);
      }
    });
  }
  await step("temp dirs removed", () => rmSync(temp, { recursive: true, force: true }));
}

if (failed && log) console.log(`--- ompweb output ---\n${log}`);
process.exit(failed ? 1 : 0);
