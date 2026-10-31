import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Real /api/models-config against a throwaway agent dir. Bug hunt round 1:
// GET returned provider apiKeys in plaintext; PUT must preserve the stored
// key when the client echoes the masked placeholder back.
const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": new URL("../", import.meta.url).pathname },
});

const agentDir = mkdtempSync(join(tmpdir(), "omp-web-models-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousXdg = process.env.XDG_DATA_HOME;
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.XDG_DATA_HOME;

const route = await jiti.import("../app/api/models-config/route.ts");
const lib = await jiti.import("./omp/models-config.ts");

const MODELS_YML = `providers:
  acme:
    baseUrl: https://example.invalid/v1
    apiKey: sk-LIVE-KEY-123
    models:
      - id: acme-1
        api: openai-completions
`;

test("GET masks apiKey and PUT with the placeholder preserves the stored key", async (t) => {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.yml"), MODELS_YML, "utf8");
  t.after(() => rmSync(join(agentDir, "models.yml"), { force: true }));

  const got = await (await route.GET()).json();
  assert.equal(got.providers.acme.apiKey, lib.MASKED_API_KEY);
  assert.equal(got.providers.acme.baseUrl, "https://example.invalid/v1");

  // Save an unrelated edit while echoing the placeholder back.
  const put = await route.PUT(new Request("http://localhost/api/models-config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...got, providers: { acme: { ...got.providers.acme, models: [{ id: "acme-1", api: "openai-completions", maxTokens: 2048 }] } } }),
  }));
  assert.equal(put.status, 200);
  const onDisk = readFileSync(join(agentDir, "models.yml"), "utf8");
  assert.match(onDisk, /sk-LIVE-KEY-123/);
  assert.match(onDisk, /maxTokens: 2048/);

  // A genuinely new key overwrites the stored one.
  const put2 = await route.PUT(new Request("http://localhost/api/models-config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providers: { acme: { baseUrl: "https://example.invalid/v1", apiKey: "sk-NEW-KEY-456", models: [{ id: "acme-1", api: "openai-completions", maxTokens: 2048 }] } } }),
  }));
  assert.equal(put2.status, 200);
  assert.match(readFileSync(join(agentDir, "models.yml"), "utf8"), /sk-NEW-KEY-456/);
});

test("PUT never persists the masked placeholder as a key", async (t) => {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.yml"), MODELS_YML, "utf8");
  t.after(() => rmSync(join(agentDir, "models.yml"), { force: true }));
  // A brand-new provider submitted with the placeholder: no stored key to
  // restore, so the placeholder must be dropped rather than written.
  const put = await route.PUT(new Request("http://localhost/api/models-config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providers: { brand: { baseUrl: "https://example.invalid/v1", apiKey: lib.MASKED_API_KEY, auth: "none" } } }),
  }));
  assert.equal(put.status, 200);
  assert.doesNotMatch(readFileSync(join(agentDir, "models.yml"), "utf8"), new RegExp(lib.MASKED_API_KEY));
});

test("teardown restores the environment", () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousXdg;
  rmSync(agentDir, { recursive: true, force: true });
});
