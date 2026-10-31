import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Real /api/sessions/[id]/export against a stub omp binary and a synthetic
// session. Bug hunt round 1: exports were served `inline` from the
// authenticated origin with no sandboxing, so attacker-influenced transcript
// HTML (event-handler attributes) executed in omp-web's origin. Exports
// must now always download as an attachment, even when ?inline=1 is asked.
const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": new URL("../", import.meta.url).pathname },
});

const base = mkdtempSync(join(tmpdir(), "omp-web-export-route-"));
const agentDir = join(base, "agent");
const projectDir = join(agentDir, "sessions", "-project");
mkdirSync(projectDir, { recursive: true });
const stubOmp = join(base, "omp-stub.sh");
writeFileSync(stubOmp, "#!/bin/sh\nprintf '%s' '<html><body><img src=x onerror=alert(2)></body></html>' > \"$3\"\n");
chmodSync(stubOmp, 0o755);

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousXdg = process.env.XDG_DATA_HOME;
const previousOmpBin = process.env.OMP_WEB_OMP_BIN;
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.XDG_DATA_HOME;
process.env.OMP_WEB_OMP_BIN = stubOmp;

const route = await jiti.import("../app/api/sessions/[id]/export/route.ts");
const { invalidateSessionListCache } = await jiti.import("./session-reader.ts");

const sessionLines = [
  JSON.stringify({ type: "session", version: 3, id: "exporttest", cwd: join(base, "ws"), timestamp: "2026-01-01T00:00:00.000Z" }),
];
writeFileSync(join(projectDir, "2026-01-01_exporttest.jsonl"), `${sessionLines.join("\n")}\n`);
invalidateSessionListCache();

const getExport = (query) => route.GET(
  new Request(`http://localhost/api/sessions/exporttest/export${query}`),
  { params: Promise.resolve({ id: "exporttest" }) },
);

test("serves exports as attachments even when inline is requested", async () => {
  for (const query of ["?inline=1", ""]) {
    const res = await getExport(query);
    assert.equal(res.status, 200, `export${query} must succeed`);
    assert.match(res.headers.get("Content-Disposition") ?? "", /^attachment;/, `export${query} must be attachment-only`);
    assert.equal(await res.text(), "<html><body><img src=x onerror=alert(2)></body></html>");
  }
});

test("teardown restores the environment", () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousXdg;
  if (previousOmpBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
  else process.env.OMP_WEB_OMP_BIN = previousOmpBin;
  rmSync(base, { recursive: true, force: true });
});
