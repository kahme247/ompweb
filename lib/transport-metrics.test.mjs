import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, afterEach } from "node:test";

const route = await import("../app/api/transport-metrics/route.ts");
const { appendTransportSamples, transportMetricsPath } = await import("./transport-metrics.ts");

const agentDir = mkdtempSync(join(tmpdir(), "omp-web-transport-metrics-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});
afterEach(() => {
  rmSync(transportMetricsPath(), { force: true });
  rmSync(`${transportMetricsPath()}.1`, { force: true });
});

const post = (body, headers = {}) =>
  route.POST(new Request("http://localhost/api/transport-metrics", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
const lines = () => readFileSync(transportMetricsPath(), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));

test("the store lives under the agent dir", () => {
  assert.equal(transportMetricsPath(), join(agentDir, "omp-web", "transport-metrics.jsonl"));
});

test("POST keeps valid samples, stamps them and answers the count", async () => {
  const before = Date.now();
  const res = await post(
    {
      samples: [
        { metric: "action", req: "a" },
        { metric: "event", at: 1 },
        { metric: "hang" },
        "nope",
        { metric: "action", big: "x".repeat(5000) },
        { req: "no metric" },
        { metric: "m".repeat(33) },
      ],
    },
    { "user-agent": "Test/1.0" },
  );
  const after = Date.now();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { written: 3 });
  const written = lines();
  assert.deepEqual(written.map((line) => line.metric), ["action", "event", "hang"]);
  for (const line of written) {
    assert.ok(line.serverAt >= before && line.serverAt <= after);
    assert.equal(line.ua, "Test/1.0");
  }
});

test("a client cannot forge serverAt or ua, and ua is cut to 200 characters", async () => {
  await post({ samples: [{ metric: "action", serverAt: 1, ua: "forged" }] }, { "user-agent": "u".repeat(300) });
  const [line] = lines();
  assert.ok(line.serverAt > 1_000_000_000_000);
  assert.equal(line.ua, "u".repeat(200));
});

test("POST rejects a bad body, a missing array and more than 1000 samples", async () => {
  for (const body of ["null", "[]", '"x"', "{}", '{"samples":"x"}', "{not json"]) {
    const res = await post(body);
    assert.equal(res.status, 400, body);
    assert.equal((await res.json()).code, "invalid_transport_metrics");
  }
  const tooMany = await post({ samples: Array.from({ length: 1001 }, () => ({ metric: "event" })) });
  assert.equal(tooMany.status, 400);
  assert.equal(existsSync(transportMetricsPath()), false);
  const exactly = await post({ samples: Array.from({ length: 1000 }, () => ({ metric: "event" })) });
  assert.deepEqual(await exactly.json(), { written: 1000 });
});

test("POST answers 413 above 256 KiB", async () => {
  const res = await post({ samples: [{ metric: "action", pad: "x".repeat(256 * 1024) }] });
  assert.equal(res.status, 413);
});

test("the store rotates above 20 MiB", () => {
  appendTransportSamples([{ metric: "old" }], null);
  const size = 20 * 1024 * 1024 + 1;
  truncateSync(transportMetricsPath(), size);
  appendTransportSamples([{ metric: "new" }], null);
  assert.equal(statSync(`${transportMetricsPath()}.1`).size, size);
  assert.deepEqual(lines().map((line) => line.metric), ["new"]);
});

test("GET answers now", async () => {
  const before = Date.now();
  const res = await route.GET();
  const after = Date.now();
  assert.equal(res.headers.get("cache-control"), "no-store");
  const { now } = await res.json();
  assert.ok(now >= before && now <= after);
});
