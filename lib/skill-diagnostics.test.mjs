import assert from "node:assert/strict";
import test from "node:test";

const { parseSkillDiagnosticsSnapshot } = await import("./skill-diagnostics.ts");

const publicSnapshot = {
  cwd: "/workspace",
  showStartupDiagnostics: false,
  diagnostics: [{
    name: "review",
    reason: "authored-over-installed",
    skills: [{
      name: "review",
      filePath: "/workspace/.agents/skills/review/SKILL.md",
      source: "project",
      pluginName: "tools",
    }],
    duplicates: [{
      skill: {
        name: "review",
        filePath: "/mirror/review/SKILL.md",
        source: "custom",
      },
      retained: {
        name: "review",
        filePath: "/workspace/.agents/skills/review/SKILL.md",
        source: "project",
      },
    }],
  }],
};

test("constructs a public skill diagnostics DTO and strips every unlisted field", () => {
  const wire = {
    ...publicSnapshot,
    prompt: "private",
    diagnostics: [{
      ...publicSnapshot.diagnostics[0],
      internal: true,
      skills: publicSnapshot.diagnostics[0].skills.map((skill) => ({
        ...skill,
        body: "private prompt",
        frontmatter: { version: 4 },
        _source: { kind: "internal" },
        containRoot: "/workspace",
      })),
      duplicates: publicSnapshot.diagnostics[0].duplicates.map((duplicate) => ({
        ...duplicate,
        privatePair: true,
        skill: { ...duplicate.skill, body: "private" },
        retained: { ...duplicate.retained, frontmatter: { version: 4 } },
      })),
    }],
  };

  assert.deepEqual(parseSkillDiagnosticsSnapshot(wire), publicSnapshot);
  assert.notEqual(parseSkillDiagnosticsSnapshot(wire), wire, "the parser constructs a new allowlisted object");
});

test("keeps an explicit clean snapshot distinct from absent or malformed support", () => {
  assert.deepEqual(parseSkillDiagnosticsSnapshot({
    cwd: "/workspace",
    showStartupDiagnostics: true,
    diagnostics: [],
  }), {
    cwd: "/workspace",
    showStartupDiagnostics: true,
    diagnostics: [],
  });

  for (const value of [
    undefined,
    null,
    {},
    { cwd: "/workspace", showStartupDiagnostics: true },
    { cwd: "/workspace", showStartupDiagnostics: "yes", diagnostics: [] },
    { cwd: "/workspace", showStartupDiagnostics: true, diagnostics: "clean" },
    { cwd: "/workspace", showStartupDiagnostics: true, diagnostics: [{ ...publicSnapshot.diagnostics[0], reason: "new-reason" }] },
    { cwd: "/workspace", showStartupDiagnostics: true, diagnostics: [{ ...publicSnapshot.diagnostics[0], skills: [{ name: "review", filePath: 42, source: "project" }] }] },
    { cwd: "/workspace", showStartupDiagnostics: true, diagnostics: [{ ...publicSnapshot.diagnostics[0], skills: [{ ...publicSnapshot.diagnostics[0].skills[0], pluginName: 42 }] }] },
    { cwd: "/workspace", showStartupDiagnostics: true, diagnostics: [{ ...publicSnapshot.diagnostics[0], duplicates: [{ skill: publicSnapshot.diagnostics[0].skills[0] }] }] },
  ]) {
    assert.equal(parseSkillDiagnosticsSnapshot(value), undefined);
  }
});
