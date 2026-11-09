import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as route from "../app/api/usage/route.ts";
import { invalidateUsageReportCache } from "../lib/usage-service.ts";

const MAX_WINDOW_MS = 400 * 24 * 60 * 60 * 1000;

function call(query) {
  return route.GET(new Request(`http://localhost/api/usage${query ? `?${query}` : ""}`));
}

/** Point OMP_WEB_USAGE_WORKER at a throwaway module for one test. */
async function withWorker(source, run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-usage-route-worker-"));
  const file = join(dir, "worker.mjs");
  writeFileSync(file, source, "utf8");
  const previous = process.env.OMP_WEB_USAGE_WORKER;
  process.env.OMP_WEB_USAGE_WORKER = file;
  try {
    return await run(file, dir);
  } finally {
    if (previous === undefined) delete process.env.OMP_WEB_USAGE_WORKER;
    else process.env.OMP_WEB_USAGE_WORKER = previous;
    invalidateUsageReportCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempAgentDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-usage-route-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  invalidateUsageReportCache();
  try {
    return await run(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateUsageReportCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

function okWorker(report) {
  return `import { parentPort } from "node:worker_threads";\nparentPort.postMessage({ ok: true, report: ${JSON.stringify(report)} });\n`;
}

test("usage rejects non-numeric, backwards and over-wide windows with a stable code", async () => {
  const cases = [
    "from=abc",
    "to=NaN",
    "from=1.5",
    "from=-1",
    "from=100&to=50",
    `from=0&to=${MAX_WINDOW_MS + 1000}`,
    `from=${Date.now() - MAX_WINDOW_MS - 1000}`,
  ];
  for (const query of cases) {
    const response = await call(query);
    assert.equal(response.status, 400, query);
    const body = await response.json();
    assert.deepEqual(body, { error: "Invalid usage window", code: "invalid_usage_window" }, query);
  }

  // A window exactly at the limit is accepted (and answered by a fake worker).
  await withTempAgentDir(async () => {
    await withWorker(okWorker({ scannedAt: Date.now(), summary: { inputTokens: 1 } }), async () => {
      const response = await call(`from=1000&to=${1000 + MAX_WINDOW_MS}`);
      assert.equal(response.status, 200);
    });
  });
});

test("a valid report is served as JSON", async () => {
  await withTempAgentDir(async () => {
    await withWorker(okWorker({ scannedAt: Date.now(), summary: { inputTokens: 42 } }), async () => {
      const response = await call("range=7d");
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
      const body = await response.json();
      assert.equal(body.summary.inputTokens, 42);
    });
  });
});

test("worker failures never leak paths or raw messages to the client", async () => {
  await withTempAgentDir(async () => {
    const missing = join(tmpdir(), "omp-missing-usage-worker-for-route.mjs");
    const previous = process.env.OMP_WEB_USAGE_WORKER;
    process.env.OMP_WEB_USAGE_WORKER = missing;
    try {
      const response = await call("range=30d");
      assert.equal(response.status, 500);
      const body = await response.json();
      assert.deepEqual(body, { error: "Usage report failed", code: "usage_failed" });
      assert.doesNotMatch(JSON.stringify(body), /omp-missing-usage-worker|[A-Za-z]:\\|\/Users\/|\/tmp\//);
    } finally {
      if (previous === undefined) delete process.env.OMP_WEB_USAGE_WORKER;
      else process.env.OMP_WEB_USAGE_WORKER = previous;
    }
  });
});

test("a scan that exceeds the deadline answers 504 usage_timeout", { timeout: 10_000 }, async (t) => {
  const previousTimeout = process.env.OMP_WEB_USAGE_TIMEOUT_MS;
  process.env.OMP_WEB_USAGE_TIMEOUT_MS = "60";
  t.after(() => {
    if (previousTimeout === undefined) delete process.env.OMP_WEB_USAGE_TIMEOUT_MS;
    else process.env.OMP_WEB_USAGE_TIMEOUT_MS = previousTimeout;
  });
  await withTempAgentDir(async () => {
    await withWorker("setInterval(() => {}, 1000);\n", async () => {
      const response = await call("range=90d");
      assert.equal(response.status, 504);
      assert.deepEqual(await response.json(), { error: "Usage scan timed out", code: "usage_timeout" });
    });
  });
});

test("a full queue answers 503 usage_busy instead of piling up more scans", { timeout: 15_000 }, async () => {
  await withTempAgentDir(async () => {
    await withWorker(
      "import { parentPort } from \"node:worker_threads\";\nsetTimeout(() => parentPort.postMessage({ ok: true, report: { scannedAt: Date.now() } }), 150);\n",
      async () => {
        const responses = await Promise.all([
          call("range=7d"),
          call("range=30d"),
          call("range=90d"),
          call("range=month"),
        ]);
        const statuses = responses.map((response) => response.status).sort();
        assert.deepEqual(statuses, [200, 200, 200, 503]);
        const busy = responses.find((response) => response.status === 503);
        assert.deepEqual(await busy.json(), { error: "Usage scan busy", code: "usage_busy" });
      },
    );
  });
});
