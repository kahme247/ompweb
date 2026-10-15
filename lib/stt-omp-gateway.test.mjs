import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// With no OMP_WEB_STT_ENDPOINT, OMP_WEB_STT_MODEL names an omp model and the
// job runs through `omp auth-gateway stdio`. The omp binary is a stub speaking
// that JSON-lines protocol and logging every launch and request it sees.
const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});

const dir = mkdtempSync(join(tmpdir(), "omp-web-stt-gateway-"));
const log = join(dir, "gateway.log");
const fakeOmp = join(dir, "fake-omp");
writeFileSync(
  fakeOmp,
  `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const log = (entry) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + "\\n");
log({ launch: process.argv.slice(2) });
process.stdout.write(JSON.stringify({ ready: true, version: "test" }) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, path, body } = JSON.parse(line);
  log({ path, body });
  if (body.model === "crash/model") {
    process.stderr.write("gateway boom");
    process.exit(1);
  }
  const reply = body.model === "openai-codex/codex-transcribe"
    ? { id, status: 200, body: { text: "codex words", usage: { input_tokens: 0 } } }
    : { id, status: 401, body: { error: { message: "No credential available for provider " + body.model.split("/")[0] } } };
  process.stdout.write(JSON.stringify(reply) + "\\n");
});
`,
  { mode: 0o755 },
);

const originalEnv = { ...process.env };
delete process.env.OMP_WEB_STT_ENDPOINT;
process.env.OMP_WEB_OMP_BIN = fakeOmp;
const { POST } = await jiti.import("../app/api/stt/route.ts");
const { GET, DELETE } = await jiti.import("../app/api/stt/[jobId]/route.ts");
const { disposeAuthGateway } = await jiti.import("./omp/auth-gateway.ts");

after(() => {
  disposeAuthGateway();
  process.env = originalEnv;
  rmSync(dir, { recursive: true, force: true });
});

const ctx = (jobId) => ({ params: Promise.resolve({ jobId }) });

async function transcribe(model, fileName = "audio.webm") {
  process.env.OMP_WEB_STT_MODEL = model;
  const formData = new FormData();
  formData.append("file", new Blob(["recorded-audio"]), fileName);
  const started = await POST(new Request("http://localhost/api/stt", { method: "POST", body: formData }));
  assert.equal(started.status, 202);
  const { jobId } = await started.json();
  for (let i = 0; i < 1000; i++) {
    const job = await (await GET(new Request("http://localhost"), ctx(jobId))).json();
    if (job.status === "error") return job;
    if (job.status === "done") {
      return (await DELETE(new Request(`http://localhost/api/stt/${jobId}?claim=c&owner=c`, { method: "DELETE" }), ctx(jobId))).json();
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("job never finished");
}

test("an omp model without an endpoint transcribes through a shared omp auth gateway that respawns after a crash", { skip: process.platform === "win32" }, async () => {
  assert.equal((await transcribe("openai-codex/codex-transcribe")).text, "codex words");

  const failed = await transcribe("openai/whisper-1");
  assert.equal(failed.status, "error");
  assert.equal(failed.error, "No credential available for provider openai");

  const crashed = await transcribe("crash/model");
  assert.equal(crashed.status, "error");
  assert.match(crashed.error, /omp auth-gateway exited.*gateway boom/);
  assert.equal((await transcribe("openai-codex/codex-transcribe", "audio.mp4")).text, "codex words");

  const entries = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.filter((entry) => entry.launch).length, 2, "jobs share one gateway until it crashes");
  assert.deepEqual(entries.find((entry) => entry.launch).launch, ["auth-gateway", "stdio"]);
  const requests = entries.filter((entry) => entry.path);
  assert.equal(requests[0].path, "/v1/audio/transcriptions");
  assert.equal(requests[0].body.model, "openai-codex/codex-transcribe");
  const audio = Buffer.from("recorded-audio").toString("base64");
  assert.deepEqual(requests[0].body.input_audio, { data: audio, format: "webm" });
  assert.deepEqual(requests.at(-1).body.input_audio, { data: audio, format: "mp4" }, "the format follows the browser's file name");
});
