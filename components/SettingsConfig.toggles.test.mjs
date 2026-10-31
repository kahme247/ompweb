import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// AutoResumeSessionsSetting and AgentToolsSetting are module-private and
// SettingsConfig has no render harness, so this test asserts the guard in
// source, following the AppShell.test.mjs precedent. It fails pre-fix: the
// toggles rendered with disabled={enabled === null} only, so two overlapping
// PUTs could resolve out of order and leave the UI showing the opposite of
// the server value (for the agent-tools toggle, a security boundary).
const source = await readFile(new URL("./SettingsConfig.tsx", import.meta.url), "utf8");

function bodyOf(name) {
  const start = source.indexOf(`function ${name}()`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}

for (const name of ["AutoResumeSessionsSetting", "AgentToolsSetting"]) {
  test(`${name} disables its toggle while a save is in flight`, () => {
    const body = bodyOf(name);
    assert.match(body, /const \[saving, setSaving\] = useState\(false\)/);
    assert.match(body, /if \(saving\) return;/);
    assert.match(body, /setSaving\(true\)/);
    assert.match(body, /disabled=\{enabled === null \|\| saving\}/);
    assert.match(body, /finally \{\s*setSaving\(false\);/);
  });
}
