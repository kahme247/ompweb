import type { SessionInfo } from "./types";

// NOTE: this module used to also record the last-open session per project
// (get/set/clearLastOpenSession, localStorage key "omp-web:last-open-by-project").
// No caller ever read the recorded value back — project activation is
// deliberately "without opening a session" (see activateProject in
// SessionSidebar) — so the helpers were dead writes on every selection and
// were removed rather than wired into a behavior change.

export function workspaceKeyOf(session: Pick<SessionInfo, "cwd" | "projectRoot" | "projectKey">): string {
  // Empty strings count as missing, not as a key: hand-edited or partially
  // written session headers can carry "" where a field is absent, and ??
  // would keep the empty string, grouping the session under no project.
  return session.projectKey || session.projectRoot || session.cwd || "";
}
