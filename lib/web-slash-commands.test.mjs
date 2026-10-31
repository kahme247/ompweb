import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./web-slash-commands.ts");
}

test("exposes the expected command set with hints and arg requirements", async () => {
  const { WEB_SLASH_COMMANDS } = await loadSubject();
  const names = WEB_SLASH_COMMANDS.map((command) => command.name);

  assert.deepEqual(names, ["plan", "fix", "test", "explain", "simplify", "commit", "loop"]);
  assert.ok(WEB_SLASH_COMMANDS.every((command) => command.descriptionKey.startsWith("chatInput.cmd")));
  assert.ok(WEB_SLASH_COMMANDS.every((command) => command.argumentHintKey.startsWith("chatInput.cmd")));

  const required = new Set(WEB_SLASH_COMMANDS.filter((command) => command.requiresArgs).map((command) => command.name));
  assert.deepEqual(required, new Set(["plan", "fix", "test", "explain", "simplify", "loop"]));
});

test("lookup resolves by primary name only", async () => {
  const { getWebSlashCommand } = await loadSubject();
  assert.equal(getWebSlashCommand("goal"), undefined);
  assert.equal(getWebSlashCommand("plan")?.name, "plan");
  assert.equal(getWebSlashCommand("vibe"), undefined);
  assert.equal(getWebSlashCommand("GOAL"), undefined);
});

test("required-arg commands embed the args verbatim", async () => {
  const { getWebSlashCommand } = await loadSubject();
  const plan = getWebSlashCommand("plan");
  assert.ok(plan);
  const prompt = plan.buildPrompt("ship the export feature");

  assert.match(prompt, /Create a plan for this task/);
  assert.ok(prompt.includes("ship the export feature"));
});

test("optional-arg commands degrade to a default when no args are given", async () => {
  const { getWebSlashCommand } = await loadSubject();
  const commit = getWebSlashCommand("commit");
  assert.ok(commit);

  assert.match(commit.buildPrompt(""), /clear conventional commit message/);
  assert.match(commit.buildPrompt("feat: add catalog"), /commit the current changes with this message: "feat: add catalog"/);
});

test("expansion expands web commands, rejects missing args, and passes others through", async () => {
  const { expandWebSlashCommand } = await loadSubject();

  const expanded = expandWebSlashCommand("/plan ship the export");
  assert.equal(expanded.kind, "expand");
  if (expanded.kind === "expand") assert.match(expanded.prompt, /ship the export/);

  const usage = expandWebSlashCommand("/plan ");
  assert.equal(usage.kind, "usage-error");
  if (usage.kind === "usage-error") {
    assert.equal(usage.command, "/plan");
    assert.equal(usage.argumentHintKey, "chatInput.cmdPlanArg");
  }

  // Plain messages and commands omp owns are not the client's business.
  assert.equal(expandWebSlashCommand("just a message").kind, "not-web");
  assert.equal(expandWebSlashCommand("/goal ship the export").kind, "not-web");
  assert.equal(expandWebSlashCommand("/compact").kind, "not-web");
  assert.equal(expandWebSlashCommand("/vibe go fast").kind, "not-web");
});

test("loop repeats a task up to the requested count", async () => {
  const { getWebSlashCommand, expandWebSlashCommand } = await loadSubject();
  const loop = getWebSlashCommand("loop");
  assert.ok(loop);

  const prompt = loop.buildPrompt("3 run the test suite");
  assert.match(prompt, /up to 3 attempts/);
  assert.ok(prompt.includes("run the test suite"));

  // A missing count defaults; an absurd count clamps so a typo cannot run away.
  assert.match(loop.buildPrompt("run the test suite"), /up to 3 attempts/);
  assert.match(loop.buildPrompt("999 run the test suite"), /up to 10 attempts/);

  const expanded = expandWebSlashCommand("/loop 2 fix the flake");
  assert.equal(expanded.kind, "expand");
  if (expanded.kind === "expand") assert.match(expanded.prompt, /up to 2 attempts/);

  assert.equal(expandWebSlashCommand("/loop ").kind, "usage-error");
});
