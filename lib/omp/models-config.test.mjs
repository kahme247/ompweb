import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const {
  ModelsConfigParseError,
  readModelsConfigFile,
  serializeModelsConfig,
  validateModelsConfig,
  writeModelsConfig,
} = await import("./models-config.ts");

// A hand-edited models.yml: comments, blank lines and quoting that a
// parse+stringify round trip would silently throw away.
const HAND_EDITED = `# Custom providers for omp.
# Keep the local llama entry first.

providers:
  local-llama:
    baseUrl: http://127.0.0.1:8080/v1 # llama.cpp server
    apiKey: LLAMA_API_KEY
    api: openai-completions
    models:
      # 70B, quantized
      - id: llama-3.3-70b
        name: "Llama 3.3 70B"
        contextWindow: 131072
        maxTokens: 8192
      # small, fast
      - id: llama-3.2-3b
        name: Llama 3.2 3B
        contextWindow: 32768

  work-proxy:
    baseUrl: https://proxy.internal/v1
    apiKey: "!op read op://work/openai/key"
    api: openai-responses
    models:
      - id: gpt-5
        reasoning: true
`;

function withAgentDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-models-config-"));
  const previous = {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    xdg: process.env.XDG_DATA_HOME,
  };
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.XDG_DATA_HOME;
  try {
    run(dir, join(dir, "models.yml"));
  } finally {
    for (const [key, value] of [
      ["PI_CODING_AGENT_DIR", previous.agentDir],
      ["XDG_DATA_HOME", previous.xdg],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("round-trips a hand-edited models.yml without losing comments", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, HAND_EDITED, "utf8");

    const file = readModelsConfigFile();
    assert.equal(file.parseError, undefined);
    assert.deepEqual(Object.keys(file.config.providers), ["local-llama", "work-proxy"]);

    // Edit exactly what the editor would: bump a model's maxTokens.
    file.config.providers["local-llama"].models[0].maxTokens = 16384;
    writeModelsConfig(file.config);

    const written = readFileSync(path, "utf8");
    assert.match(written, /# Custom providers for omp\./);
    assert.match(written, /# Keep the local llama entry first\./);
    assert.match(written, /# llama\.cpp server/);
    assert.match(written, /# 70B, quantized/);
    assert.match(written, /maxTokens: 16384/);
    assert.match(written, /apiKey: "!op read op:\/\/work\/openai\/key"/);
    assert.equal(readModelsConfigFile().config.providers["local-llama"].models[0].maxTokens, 16384);
  });
});

test("a save with no edits leaves the file byte-identical", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, HAND_EDITED, "utf8");
    writeModelsConfig(readModelsConfigFile().config);
    assert.equal(readFileSync(path, "utf8"), HAND_EDITED);
  });
});

test("keeps a model's comments with the model when siblings are removed", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, HAND_EDITED, "utf8");

    const { config } = readModelsConfigFile();
    // Drop the first model: with positional merging the 3B entry would inherit
    // the 70B node and "# small, fast" would be dropped with it.
    config.providers["local-llama"].models.splice(0, 1);
    writeModelsConfig(config);

    const written = readFileSync(path, "utf8");
    assert.match(written, /# small, fast\n\s+- id: llama-3\.2-3b/);
    assert.doesNotMatch(written, /llama-3\.3-70b/);
    // "# 70B, quantized" preceded the first item, so YAML attaches it to the
    // sequence rather than the item — it survives the deletion by design.
  });
});

test("adds and removes providers", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, HAND_EDITED, "utf8");

    const { config } = readModelsConfigFile();
    delete config.providers["work-proxy"];
    config.providers["new-provider"] = {
      baseUrl: "https://api.example.com/v1",
      apiKey: "EXAMPLE_KEY",
      api: "openai-completions",
      models: [{ id: "example-1", contextWindow: 8000 }],
    };
    writeModelsConfig(config);

    const reread = readModelsConfigFile();
    assert.deepEqual(Object.keys(reread.config.providers), ["local-llama", "new-provider"]);
    assert.equal(reread.config.providers["new-provider"].models[0].contextWindow, 8000);
    assert.match(readFileSync(path, "utf8"), /# Custom providers for omp\./);
  });
});

test("reports a parse error instead of an empty config", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "providers:\n  broken: [unclosed\n", "utf8");

    const file = readModelsConfigFile();
    assert.ok(file.parseError, "expected a parse error");
    assert.deepEqual(file.config, { providers: {} });
  });
});

test("refuses to overwrite an unparseable models.yml", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    const broken = "providers:\n  broken: [unclosed\n";
    writeFileSync(path, broken, "utf8");

    assert.throws(
      () => writeModelsConfig({ providers: {} }),
      (error) => error instanceof ModelsConfigParseError,
    );
    assert.equal(readFileSync(path, "utf8"), broken, "the broken file must be left untouched");

    writeModelsConfig({ providers: { a: { baseUrl: "https://x/v1", apiKey: "K", api: "openai-completions" } } }, { overwriteUnparseable: true });
    assert.deepEqual(Object.keys(readModelsConfigFile().config.providers), ["a"]);
  });
});

test("treats a non-mapping models.yml as unparseable", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "- one\n- two\n", "utf8");
    assert.ok(readModelsConfigFile().parseError);
  });
});

test("writes a fresh file when none exists", () => {
  withAgentDir((dir, path) => {
    const file = readModelsConfigFile();
    assert.equal(file.exists, false);
    writeModelsConfig({ providers: { p: { baseUrl: "https://x/v1", apiKey: "K", api: "openai-completions", models: [{ id: "m" }] } } });
    assert.match(readFileSync(path, "utf8"), /id: m/);
  });
});

test("serializeModelsConfig without a source still emits plain YAML", () => {
  const text = serializeModelsConfig({ providers: { p: { api: "openai-completions" } } });
  assert.match(text, /providers:\n {2}p:\n {4}api: openai-completions/);
});

test("validation rejects partial model cost but accepts a complete one", () => {
  const base = {
    providers: {
      p: {
        baseUrl: "https://api.example.com/v1",
        api: "openai-completions",
        auth: "none",
        models: [{ id: "m", cost: { input: 1, output: 2 } }],
      },
    },
  };

  assert.throws(
    () => validateModelsConfig(base),
    /cost\.cacheRead is required/,
  );

  validateModelsConfig({
    ...base,
    providers: {
      p: {
        ...base.providers.p,
        models: [{ id: "m", cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 2 } }],
      },
    },
  });
});

test("ignores blank model rows while preserving non-empty rows", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "providers:\n  p:\n    models:\n      - id: \"\"\n      - id: \"   \"\n      - id: valid\n", "utf8");

    const file = readModelsConfigFile();
    assert.deepEqual(file.config.providers.p.models.map((model) => model.id), ["valid"]);
    writeModelsConfig(file.config);
    assert.deepEqual(readModelsConfigFile().config.providers.p.models.map((model) => model.id), ["valid"]);
  });
});
