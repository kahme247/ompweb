// `npm run smoke [-- --package <dir>]`: starts `node <dir>/bin/omp-web.js` on a free port with a throwaway HOME and
// checks the shipped bundle, the SPA, a hashed asset, the API and the SSE stream, then stops it. <dir>: the repo root
// (after `npm run build`) or a packed install. Prints one `ok <step>` / `FAIL <step>: <detail>` line per step.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { package: { type: "string" } } });
const dir = path.resolve(values.package ?? path.join(import.meta.dir, ".."));

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
try {
  const ready = Promise.withResolvers<void>();
  const started = await step(`launcher prints Ready on port ${port}`, async () => {
    const child = Bun.spawn(["node", path.join(dir, "bin", "omp-web.js"), "-p", String(port), "-H", "127.0.0.1", "--no-open"], {
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
  if (launcher) {
    const child = launcher;
    await step("launcher stops and the port closes", async () => {
      if (process.platform === "win32") Bun.spawnSync(["taskkill", "/pid", String(child.pid), "/t", "/f"]);
      else child.kill("SIGTERM");
      const deadline = Date.now() + 15_000;
      while (await portOpen(port)) {
        assert(Date.now() < deadline, `port ${port} still accepts connections 15 s after the stop`);
        await Bun.sleep(200);
      }
    });
  }
  await step("temp dirs removed", () => rmSync(temp, { recursive: true, force: true }));
}

if (failed && log) console.log(`--- launcher output ---\n${log}`);
process.exit(failed ? 1 : 0);
