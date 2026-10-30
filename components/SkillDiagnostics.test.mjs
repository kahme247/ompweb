import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
const { cleanup, render, screen, waitFor } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");

const { SkillDiagnosticsDialog, SkillDiagnosticsNotice } = await import("./SkillDiagnostics.tsx");
afterEach(cleanup);

const snapshot = {
  cwd: "/project",
  showStartupDiagnostics: true,
  diagnostics: [{
    name: "review", reason: "source-order",
    skills: [
      { name: "review", filePath: "/first/review/SKILL.md", source: "native:user" },
      { name: "second/review", filePath: "/second/review/SKILL.md", source: "agents:project" },
    ], duplicates: [],
  }],
};

test("diagnostic display neutralizes path-spoofing controls without discarding ordinary Unicode", () => {
  const hostile = {
    cwd: "/project\u202E",
    showStartupDiagnostics: true,
    diagnostics: [{
      name: "調査\u202E", reason: "source-order",
      skills: [{ name: "調査\u202E", filePath: "/技能/\u202Eevil\u0007/SKILL.md", source: "custom:user\u2066", pluginName: "補助\u2069" }],
      duplicates: [{
        skill: { name: "調査\u202E", filePath: "/mirror\u0085/SKILL.md", source: "custom:user" },
        retained: { name: "調査\u202E", filePath: "/技能/\u202Eevil\u0007/SKILL.md", source: "custom:user" },
      }],
    }],
  };
  render(React.createElement(SkillDiagnosticsDialog, { open: true, onOpenChange: () => {}, snapshot: hostile }));
  const text = screen.getByRole("dialog", { name: "Skill diagnostics" }).textContent;
  assert.doesNotMatch(text, /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u);
  assert.ok(text.includes("/技能/evil/SKILL.md"));
  assert.ok(text.includes("補助"));
  assert.ok(text.includes("調査"));
});

test("losing a diagnostic snapshot closes details instead of reopening them on recovery", async () => {
  const user = userEvent.setup();
  const props = { snapshot, onDisable: async () => snapshot };
  const view = render(React.createElement(SkillDiagnosticsNotice, props));
  await user.click(screen.getByRole("button", { name: "Details" }));
  assert.ok(screen.getByRole("dialog", { name: "Skill diagnostics" }));
  view.rerender(React.createElement(SkillDiagnosticsNotice, { ...props, snapshot: null }));
  view.rerender(React.createElement(SkillDiagnosticsNotice, props));
  await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "Skill diagnostics" }) === null, true));
  assert.ok(screen.getByRole("button", { name: "Details" }));
});

test("dismissing the notice hides that report until the diagnostics change", async () => {
  const user = userEvent.setup();
  const props = { snapshot, onDisable: async () => snapshot };
  const view = render(React.createElement(SkillDiagnosticsNotice, props));
  await user.click(screen.getByRole("button", { name: "Dismiss skill notice" }));
  assert.equal(screen.queryByRole("status"), null);
  view.rerender(React.createElement(SkillDiagnosticsNotice, { ...props, snapshot: structuredClone(snapshot) }));
  assert.equal(screen.queryByRole("status"), null);
  const changed = structuredClone(snapshot);
  changed.diagnostics[0].name = "audit";
  view.rerender(React.createElement(SkillDiagnosticsNotice, { ...props, snapshot: changed }));
  assert.ok(screen.getByRole("status"));
});
