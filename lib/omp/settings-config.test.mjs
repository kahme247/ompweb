import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { readNativeSettings, writeNativeSettings } = await jiti.import("./settings-config.ts");

function withAgentDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-settings-config-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    run(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("uses config.yaml when the canonical config.yml is absent", () => {
  withAgentDir((dir) => {
    const fallback = join(dir, "config.yaml");
    writeFileSync(fallback, "compaction:\n  methodOrder: [soft]\n", "utf8");
    assert.equal(readNativeSettings().path, fallback);
    assert.deepEqual(readNativeSettings().settings.compaction.methodOrder, ["soft"]);

    writeNativeSettings({ hideThinkingBlock: true });
    assert.equal(existsSync(join(dir, "config.yml")), false);
    assert.match(readFileSync(fallback, "utf8"), /hideThinkingBlock: true/);
  });
});

test("validates compaction.methodOrder and replaces the whole persisted order", () => {
  withAgentDir((dir) => {
    assert.throws(() => writeNativeSettings({ mcp: { notifications: "yes" } }), /mcp.notifications must be a boolean/);
    assert.throws(() => writeNativeSettings({ compaction: { methodOrder: ["prune"] } }), /Invalid compaction method order/);
    assert.throws(() => writeNativeSettings({ compaction: { methodOrder: ["soft", "soft"] } }), /Invalid compaction method order/);
    writeFileSync(join(dir, "config.yml"), "compaction:\n  methodOrder: [remote, snapcompact, handoff, shake, soft]\n", "utf8");
    writeNativeSettings({ compaction: { methodOrder: ["shake", "remote"], autoContinue: true } });
    assert.deepEqual(readNativeSettings().settings.compaction.methodOrder, ["shake", "remote"]);
    // Empty is omp's "no automatic compaction method", not "unset".
    writeNativeSettings({ compaction: { methodOrder: [] } });
    assert.deepEqual(readNativeSettings().settings.compaction.methodOrder, []);
  });
});

test("reads the method order omp will run, including legacy strategy keys", () => {
  withAgentDir((dir) => {
    const read = (yaml) => {
      writeFileSync(join(dir, "config.yml"), yaml, "utf8");
      return readNativeSettings().settings.compaction?.methodOrder;
    };
    // omp's resolveCompactionMethodOrder drops unknown ids and repeats.
    assert.deepEqual(read("compaction:\n  methodOrder: [soft, future, shake, soft]\n"), ["soft", "shake"]);
    // An explicit list wins over leftover legacy keys, as in omp's migration.
    assert.deepEqual(read("compaction:\n  methodOrder: [handoff]\n  strategy: off\n"), ["handoff"]);
    assert.deepEqual(read("compaction:\n  strategy: off\n"), []);
    assert.deepEqual(read("compaction:\n  strategy: handoff\n"), ["handoff", "remote", "soft"]);
    assert.deepEqual(read("compaction:\n  strategy: context-full\n  remoteEnabled: false\n"), ["soft"]);
    assert.deepEqual(read("compaction:\n  remoteEnabled: false\n"), ["snapcompact", "handoff", "shake", "soft"]);
    assert.equal(read("compaction:\n  enabled: true\n"), undefined);
    // Top-level dotted keys count too; nested values win over them.
    assert.deepEqual(read('"compaction.methodOrder": []\n'), []);
    assert.deepEqual(read('"compaction.strategy": off\ncompaction:\n  strategy: shake\n'), ["shake", "remote", "soft"]);
  });
});
test("persists and reads the externalThinking setting (v17.2.14+)", () => {
  withAgentDir(() => {
    assert.throws(() => writeNativeSettings({ externalThinking: "yes" }), /externalThinking must be a boolean/);
    writeNativeSettings({ externalThinking: true });
    assert.equal(readNativeSettings().settings.externalThinking, true);
    // Writes are incremental: an unrelated later write preserves the key.
    writeNativeSettings({ hideThinkingBlock: true });
    assert.equal(readNativeSettings().settings.externalThinking, true);
    assert.equal(readNativeSettings().settings.hideThinkingBlock, true);
  });
});
test("persists and validates retry settings", () => {
  withAgentDir(() => {
    writeNativeSettings({ retry: { enabled: false, maxRetries: 3, modelFallback: true } });
    const settings = readNativeSettings().settings.retry;
    assert.equal(settings?.enabled, false);
    assert.equal(settings?.maxRetries, 3);
    assert.equal(settings?.modelFallback, true);
    assert.throws(() => writeNativeSettings({ retry: { maxRetries: 99 } }), /Retry attempts must be an integer between 0 and 20/);
  });
});
test("persists and validates tool approval policies", () => {
  withAgentDir(() => {
    writeNativeSettings({ tools: { approval: { bash: "deny", extension: "allow" } } });
    const settings = readNativeSettings().settings;
    assert.equal(settings.tools.approval.bash, "deny");
    assert.equal(settings.tools.approval.extension, "allow");
    assert.throws(() => writeNativeSettings({ tools: { approval: { bash: "bogus" } } }), /Invalid Bash approval policy/);
    assert.throws(() => writeNativeSettings({ tools: { approval: { extension: "deny" } } }), /Invalid extension tool approval policy/);
  });
});

test("changing Auto source preserves other provider settings and accepts explicit classifier", () => {
  withAgentDir((dir) => {
    const path = join(dir, "config.yml");
    writeFileSync(path, "# keep me\nproviders:\n  autoThinkingMaxEffort: max\n  unrelated: retained\n", "utf8");
    writeNativeSettings({ providers: { autoThinkingSource: "vendor" } });
    assert.equal(readNativeSettings().settings.providers?.autoThinkingSource, "vendor");
    assert.match(readFileSync(path, "utf8"), /autoThinkingMaxEffort: max/);
    assert.match(readFileSync(path, "utf8"), /unrelated: retained/);
    assert.match(readFileSync(path, "utf8"), /# keep me/);
    writeNativeSettings({ providers: { autoThinkingSource: "classifier" } });
    assert.equal(readNativeSettings().settings.providers?.autoThinkingSource, "classifier");
  });
});

test("unknown persisted Auto sources are not offered as a supported choice", () => {
  withAgentDir((dir) => {
    writeFileSync(join(dir, "config.yml"), "providers:\n  autoThinkingSource: future\n", "utf8");
    assert.equal(readNativeSettings().settings.providers, undefined);
  });
});

test("invalid Auto source input is rejected before touching config", () => {
  withAgentDir((dir) => {
    const path = join(dir, "config.yml");
    writeFileSync(path, "defaultThinkingLevel: high\n", "utf8");
    for (const providers of ["vendor", { autoThinkingSource: "future" }, { autoThinkingSource: null }]) {
      assert.throws(() => writeNativeSettings({ providers }));
      assert.equal(readFileSync(path, "utf8"), "defaultThinkingLevel: high\n");
    }
  });
});
