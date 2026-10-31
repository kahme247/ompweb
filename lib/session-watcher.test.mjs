import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("session watcher watches the lister's sessions directory, not ~/.omp/agent/sessions", () => {
  const source = readFileSync(new URL("./session-watcher.ts", import.meta.url), "utf8");
  // Every other session consumer uses getSessionsDir(), which honors the
  // XDG layout ($XDG_DATA_HOME/omp/sessions when that opt-in exists). The
  // watcher previously derived the path from getAgentDir(), so under XDG it
  // watched a directory the lister never reads and external session changes
  // never reached the sidebar.
  assert.match(source, /const sessionsDir = getSessionsDir\(\);/);
  assert.doesNotMatch(source, /join\(getAgentDir\(\), "sessions"\)/);
});
