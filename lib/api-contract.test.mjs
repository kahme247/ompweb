import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("agent command routes reject malformed commands and map RPC failures to 400", async () => {
  const route = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const newRoute = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");
  assert.match(route, /command_type_required/);
  assert.match(route, /instanceof RpcCommandError/);
  assert.match(route, /status: 400/);
  assert.match(newRoute, /command_type_required/);
  assert.match(newRoute, /newSessionErrorResponse/);
});

test("interactive login negotiates RPC v2 before sending the login command", async () => {
  const route = await readFile(new URL("../app/api/auth/login/[provider]/route.ts", import.meta.url), "utf8");
  const waitReady = route.indexOf("await child.waitReady(READY_TIMEOUT_MS)");
  const negotiate = route.indexOf("await child.negotiateProtocol(ready)");
  const login = route.indexOf('await child.sendCommand({ type: "login"');

  assert.ok(waitReady >= 0);
  assert.ok(negotiate > waitReady);
  assert.ok(login > negotiate);
});

test("session archive route stops live children and maps missing sessions", async () => {
  const route = await readFile(new URL("../app/api/sessions/[id]/archive/route.ts", import.meta.url), "utf8");
  const utils = await readFile(new URL("../lib/api-utils.ts", import.meta.url), "utf8");
  assert.match(route, /destroyAndWait/);
  assert.match(route, /archiveSessionFileWithArtifacts/);
  // Missing-session responses now come from the shared helper.
  assert.match(route, /resolveSessionPathOr404/);
  assert.match(utils, /session_not_found/);
  assert.match(route, /session_archive_failed/);
  assert.match(route, /session_has_children/);
});

test("session archive remains keyboard-discoverable with an ARIA label", async () => {
  const source = await readFile(new URL("../components/SessionSidebar.tsx", import.meta.url), "utf8");
  assert.match(source, /api\/sessions\/\$\{encodeURIComponent\(session\.id\)\}\/archive/);
  assert.match(source, /sessionSidebar\.archiveLeafOnly/);
  assert.match(source, /sessionSidebar\.archiveConfirm/);
});

test("prompt controls preserve abort, steer, and follow-up RPC commands", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(source, /case "abort":/);
  assert.match(source, /case "steer":/);
  assert.match(source, /case "follow_up":/);
  assert.match(source, /streamingBehavior/);
});

test("worktree discovery filters prunable entries and identifies the main checkout", async () => {
  const source = await readFile(new URL("./worktree.ts", import.meta.url), "utf8");
  assert.match(source, /current\.prunable/);
  assert.match(source, /isMain:\s*samePath\(worktreePath,\s*repoRoot\)/);
  assert.match(source, /"worktree", "list", "--porcelain"/);
});

test("OMP update route permits fixed-purpose check and restart actions with force support", async () => {
  const route = await readFile(new URL("../app/api/omp-update/route.ts", import.meta.url), "utf8");
  const settings = await readFile(new URL("../components/SettingsConfig.tsx", import.meta.url), "utf8");
  const appShell = await readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8");

  assert.match(route, /body\.action === "check"/);
  assert.match(route, /checkOmpUpdate\(body\.force === true\)/);
  assert.match(route, /body\.action === "restart"/);
  assert.match(route, /restartAllRpcSessions/);
  const manualCheck = settings.slice(settings.indexOf("const checkForUpdate"), settings.indexOf("const checkForAppUpdate"));
  assert.match(manualCheck, /body:\s*JSON\.stringify\(\{[\s\S]*action:\s*"check"[\s\S]*force:\s*true/);
  const automaticCheck = appShell.slice(appShell.indexOf('fetch("/api/omp-update"'), appShell.indexOf("}, []);", appShell.indexOf('fetch("/api/omp-update"')));
  assert.match(automaticCheck, /body:\s*JSON\.stringify\(\{\s*action:\s*"check"\s*\}\)/);
  assert.doesNotMatch(automaticCheck, /force|cache:/);
});

test("app self-update API exposes only fixed-purpose prepare, commit, and acknowledge actions", async () => {
  const route = await readFile(new URL("../app/api/app-update/route.ts", import.meta.url), "utf8");
  const rpcManager = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  assert.match(route, /body\.action === "prepare" && keys\.length === 1/);
  assert.match(route, /body\.action === "commit" && keys\.length === 2 && typeof body\.attemptId === "string"/);
  assert.match(route, /body\.action === "acknowledge" && keys\.length === 2 && typeof body\.attemptId === "string"/);
  assert.doesNotMatch(route, /body\.(?:package|packageName|version|command|args)\b/);
  assert.match(route, /parseJsonWithinLimit<Record<string, unknown> \| null>\(request, 4_096\)/);
  assert.match(route, /isApiRequestOriginAllowed/);
  assert.match(route, /Content-Type must be application\/json/);
  assert.match(route, /__ompAppUpdateCommitTransitions/);
  assert.match(route, /commitTransitions\.set\(attemptId, promise\)/);
  const transition = route.slice(
    route.indexOf("async function finishCommitTransition"),
    route.indexOf("function commitAppUpdate"),
  );
  assert.match(transition, /await beginAppUpdateDrain\(\)[\s\S]*await armSelfUpdateLauncher\(attemptId\)[\s\S]*commitSelfUpdate\(attemptId\)/);
  assert.match(route, /selfUpdateStatus = getSelfUpdateStatus\(\)/);
  assert.match(rpcManager, /__ompAppUpdateDrainPromise/);
  assert.match(rpcManager, /Cannot start an OMP session while the application is preparing to update/);
  assert.match(rpcManager, /APP_UPDATE_DRAIN_TIMEOUT_MS/);
});

test("release notes API checks the exact target without affecting update status", async () => {
  const notesRoute = await readFile(new URL("../app/api/app-update/notes/route.ts", import.meta.url), "utf8");
  const updateRoute = await readFile(new URL("../app/api/app-update/route.ts", import.meta.url), "utf8");

  assert.match(notesRoute, /import \{ checkNpmUpdate \} from "@\/lib\/npm-update"/);
  assert.match(notesRoute, /export async function GET\(\)/);
  assert.match(notesRoute, /checkNpmUpdate\(false\)/);
  assert.match(notesRoute, /getGitHubReleaseNotes\(status\.availableVersion\)/);
  assert.match(notesRoute, /status: 204/);
  assert.match(notesRoute, /"Cache-Control": "no-store"/);
  assert.doesNotMatch(notesRoute, /searchParams|request\.(?:url|json|headers)|Authorization/);
  assert.doesNotMatch(updateRoute, /github-release-notes|getGitHubReleaseNotes/);
});

test("replayed app-update commit returns before drain and launcher arm", async () => {
  const route = await readFile(new URL("../app/api/app-update/route.ts", import.meta.url), "utf8");
  const ownerStart = route.indexOf("function commitAppUpdate");
  const ownerEnd = route.indexOf("function errorResponse", ownerStart);
  const owner = route.slice(ownerStart, ownerEnd);
  const validation = owner.indexOf("const commitState = validateCommitSelfUpdate(attemptId)");
  const replayBranch = owner.indexOf('if (commitState === "replay")', validation);
  const transition = owner.indexOf("finishCommitTransition(attemptId)", replayBranch);

  assert.ok(validation >= 0);
  assert.ok(replayBranch > validation);
  assert.ok(transition > replayBranch);
  assert.match(owner.slice(replayBranch, transition), /resolve\(\{ accepted: true, attemptId \}\)/);
  assert.doesNotMatch(owner.slice(replayBranch, transition), /beginAppUpdateDrain|armSelfUpdateLauncher|cancelAppUpdateDrain/);
});

test("AppShell exclusively owns the fixed-purpose self-update lifecycle", async () => {
  const appShell = await readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8");
  const settings = await readFile(new URL("../components/SettingsConfig.tsx", import.meta.url), "utf8");

  assert.equal((appShell.match(/<AppUpdateDialog\b/g) ?? []).length, 1);
  assert.equal((settings.match(/<AppUpdateDialog\b/g) ?? []).length, 0);
  assert.equal((appShell.match(/action: "prepare"/g) ?? []).length, 1);
  assert.equal((appShell.match(/action: "commit"/g) ?? []).length, 1);
  assert.equal((appShell.match(/action: "acknowledge"/g) ?? []).length, 1);
  assert.doesNotMatch(settings, /action: "(?:prepare|commit|acknowledge)"/);
});

test("settings groups runtime preferences and resource managers behind tabs", async () => {
  const settings = await readFile(new URL("../components/SettingsConfig.tsx", import.meta.url), "utf8");
  const models = await readFile(new URL("../components/ModelsConfig.tsx", import.meta.url), "utf8");
  assert.match(settings, /currentTab === "models"/);
  assert.match(settings, /currentTab === "skills"/);
  assert.match(settings, /currentTab === "plugins"/);
  assert.doesNotMatch(settings, /visitedTabs/);
  assert.match(settings, /<ModelsConfig embedded/);
  assert.match(models, /fetch\("\/api\/models", \{ cache: "no-store" \}\)/);
  assert.match(models, /OMP runtime models/);
});

test("model endpoint invalidates cached runtime models after external config edits", async () => {
  const route = await readFile(new URL("../app/api/models/route.ts", import.meta.url), "utf8");
  assert.match(route, /statSync/);
  assert.match(route, /__ompModelsConfigFingerprint/);
  assert.match(route, /invalidateModelsCache\(\)/);
  assert.match(route, /disposeUtilityRpc\(\)/);
});

test("agent project discovery requires an explicit workspace", async () => {
  const route = await readFile(new URL("../app/api/agents/route.ts", import.meta.url), "utf8");
  assert.match(route, /scope === "project" && !cwdParam/);
  assert.match(route, /cwd is required for project scope/);
});

test("agent mutations bound JSON input before parsing", async () => {
  const route = await readFile(new URL("../app/api/agents/route.ts", import.meta.url), "utf8");
  assert.match(route, /parseJsonWithinLimit/);
  assert.match(route, /MAX_AGENT_REQUEST_BYTES/);
  assert.match(route, /RequestBodyTooLargeError/);
  assert.match(route, /status: 413/);
  assert.doesNotMatch(route, /request\.json\(\)/);
});

test("mutating agent and MCP routes bound JSON input", async () => {
  const newAgent = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");
  const agent = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const mcp = await readFile(new URL("../app/api/mcp/route.ts", import.meta.url), "utf8");
  for (const route of [newAgent, agent, mcp]) {
    assert.match(route, /parseJsonWithinLimit/);
    assert.match(route, /RequestBodyTooLargeError/);
  }
  assert.match(newAgent, /status: 413/);
  assert.match(agent, /status: 413/);
  assert.match(mcp, /\? 413 : 400/);
});

test("agent routes bound requests with the shared attachment budget", async () => {
  const newAgent = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");
  const agent = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const budget = await readFile(new URL("./image-attachments.ts", import.meta.url), "utf8");

  // One source of truth: the composer preflights against the same constant, so
  // a per-route literal would let the client send bodies the route rejects.
  for (const route of [newAgent, agent]) {
    assert.match(route, /import \{ MAX_AGENT_COMMAND_REQUEST_BYTES \} from "@\/lib\/image-attachments"/);
    assert.match(route, /parseJsonWithinLimit<[^>]*>\(req, MAX_AGENT_COMMAND_REQUEST_BYTES\)/);
    assert.doesNotMatch(route, /REQUEST_BYTES = /);
  }
  // Below Next's 10 MB proxy buffering boundary, with base64 headroom for the
  // aggregate image cap.
  assert.match(budget, /MAX_AGENT_COMMAND_REQUEST_BYTES = 8 \* 1024 \* 1024/);
  assert.match(budget, /MAX_TOTAL_ATTACHED_IMAGE_BYTES = 5 \* 1024 \* 1024/);
});

test("MCP route redacts project server credentials", async () => {
  const route = await readFile(new URL("../app/api/mcp/route.ts", import.meta.url), "utf8");
  assert.match(route, /redactMcpServer\(config\)/);
  assert.doesNotMatch(route, /config }\)\), user: safeUser/);
});

test("event streams observe only existing web-managed sessions", async () => {
  const route = await readFile(new URL("../app/api/agent/[id]/events/route.ts", import.meta.url), "utf8");
  assert.match(route, /getRpcSession\(id\)/);
  assert.match(route, /Session is not managed by omp-web/);
  assert.doesNotMatch(route, /startRpcSession/);
});

test("agent command route forwards the advisor choice to lazy spawns via query param", async () => {
  const route = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  assert.match(route, /searchParams\.get\("advisor"\) === "1"/);
  assert.match(route, /startRpcSession\(id, filePath, cwd, undefined, advisor/);
  // The RPC body goes to omp verbatim; the flag must never ride inside it.
  assert.match(route, /existing\.send\(body\)/);
});
