import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
const { createJiti } = createRequire(import.meta.url)("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { WorkerRegistry } = jiti("./worker-client.ts");

test("configured workers expose only safe remote project metadata", () => {
  const registry = WorkerRegistry.fromEnvironment(JSON.stringify([{ hostId: "golden", origin: "http://127.0.0.1:30179", secret: "s".repeat(32), workspaceId: "dev" }]));
  assert.deepEqual(registry.projects(), [{ path: "porbs:dev", remote: true, label: "Remote dev · dev" }]);
  const encoded = JSON.stringify(registry.projects());
  assert.equal(encoded.includes("origin"), false);
  assert.equal(encoded.includes("secret"), false);
});
const { groupSessionsByProject } = jiti("../project-ordering.ts");
const { createRemoteSession, remoteEventsResponse, resetPorbsControllerForTests, getPlacementStore } = jiti("./controller.ts");
const { parseHostId, makeRemoteSessionId } = jiti("./types.ts");

test("new-session UI selects remote explicitly with a stable browser operation", async () => {
  const source = await readFile(new URL("../../hooks/useAgentSession.ts", import.meta.url), "utf8");
  assert.match(source, /newSessionCwd\.startsWith\("porbs:"\)/);
  assert.match(source, /remoteCreateOperationRef\.current = crypto\.randomUUID\(\)/);
  assert.match(source, /remote: true, operationId: remoteCreateOperationRef\.current/);
  assert.match(source, /const requestBody = remote[\s\S]+:[\s\S]+toolNames/);
});

test("projects route merges safe Porbs projects and sidebar uses their label", async () => {
  const route = await readFile(new URL("../../app/api/projects/route.ts", import.meta.url), "utf8");
  const sidebar = await readFile(new URL("../../components/SessionSidebar.tsx", import.meta.url), "utf8");
  assert.match(route, /\.\.\.getPorbsRegistry\(\)\.projects\(\)/);
  assert.match(sidebar, /project\.label \?\? projectLabel\(project\.path\)/);
});

test("browser-facing projects route returns the configured remote workspace", async () => {
  const previous = process.env.PORBS_WORKERS;
  process.env.PORBS_WORKERS = JSON.stringify([{ hostId: "golden", origin: "http://127.0.0.1:30179", secret: "s".repeat(32), workspaceId: "dev" }]);
  try {
    const { resetPorbsControllerForTests } = jiti("./controller.ts");
    resetPorbsControllerForTests();
    const routeJiti = createJiti(import.meta.url, { interopDefault: true, alias: { "@": new URL("../../", import.meta.url).pathname } });
    const { GET } = routeJiti("../../app/api/projects/route.ts");
    const response = await GET();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.projects.some((project) => project.path === "porbs:dev" && project.label === "Remote dev · dev"));
  } finally {
    if (previous === undefined) delete process.env.PORBS_WORKERS;
    else process.env.PORBS_WORKERS = previous;
  }
});

test("remote session identity joins the configured sidebar project", async () => {
  const project = WorkerRegistry.fromEnvironment(JSON.stringify([{ hostId: "golden", origin: "http://127.0.0.1:30179", secret: "s".repeat(32), workspaceId: "default" }])).projects()[0];
  const session = { path: "", id: "w:golden:00000000-0000-4000-8000-000000000001", cwd: "porbs:default", created: "", modified: "", messageCount: 0, firstMessage: "", projectRoot: "porbs:default", projectKey: "porbs:default" };
  assert.deepEqual(groupSessionsByProject([project], [session]).get(project.path)?.map((entry) => entry.id), [session.id]);
  const route = await readFile(new URL("../../app/api/sessions/route.ts", import.meta.url), "utf8");
  assert.equal(route.split("`porbs:${placement.workspaceId}`").length - 1, 3);
  assert.equal(route.includes("projectKey: `porbs:${placement.hostId}:"), false);
});

test("local UI create body bypasses remote-only schema validation", async () => {
  const localBody = { cwd: "/tmp/local", type: "ensure_session", toolNames: ["read"], provider: "openai", modelId: "gpt", thinkingLevel: "high", advisor: true };
  assert.equal(await createRemoteSession(localBody), undefined);
});

test("remote event connection failures return a stable browser response", async () => {
  const previousWorkers = process.env.PORBS_WORKERS;
  const previousPlacements = process.env.PORBS_PLACEMENTS_PATH;
  const dir = await mkdtemp(join(tmpdir(), "porbs-events-"));
  process.env.PORBS_WORKERS = JSON.stringify([{ hostId: "golden", origin: "http://127.0.0.1:1", secret: "s".repeat(32), workspaceId: "default" }]);
  process.env.PORBS_PLACEMENTS_PATH = join(dir, "placements.json");
  resetPorbsControllerForTests();
  try {
    const host = parseHostId("golden");
    const id = makeRemoteSessionId(host);
    await getPlacementStore().createPending(id, host, "default");
    const response = await remoteEventsResponse(id, new Request(`http://localhost/api/agent/${id}/events`));
    assert.equal(response.status, 502);
    assert.equal(await response.text(), "Worker stream unavailable");
  } finally {
    if (previousWorkers === undefined) delete process.env.PORBS_WORKERS; else process.env.PORBS_WORKERS = previousWorkers;
    if (previousPlacements === undefined) delete process.env.PORBS_PLACEMENTS_PATH; else process.env.PORBS_PLACEMENTS_PATH = previousPlacements;
    resetPorbsControllerForTests();
  }
});

test("controller recovery uses durable create and stop identities and reset reconciliation",async()=>{const controller=await readFile(new URL("./controller.ts",import.meta.url),"utf8"),hook=await readFile(new URL("../../hooks/useAgentSession.ts",import.meta.url),"utf8");assert.ok(controller.includes('placement.lifecycle==="creating"||placement.lifecycle==="failed"'));assert.ok(controller.includes(".stop(parsed.id,state.session.revision,parsed.uuid)"));assert.ok(controller.includes("sanitizeSafeAgentEvent(record.event)"));assert.ok(controller.includes("streamId=record.streamId;lastSeq=0"));assert.ok(hook.includes("event.reset === true) resetReconcileRef.current"));});

test("prompt retries retain identity and stream budgets are globally bounded",async()=>{const client=await readFile(new URL("../agent-client.ts",import.meta.url),"utf8"),controller=await readFile(new URL("./controller.ts",import.meta.url),"utf8"),server=await readFile(new URL("./worker-server.ts",import.meta.url),"utf8");assert.ok(client.includes("remoteOperationIds.get(operationKey) ?? crypto.randomUUID()"));assert.ok(client.includes("{ ...command, operationId }"));assert.ok(controller.includes("buffer.length>300_000"));assert.ok(server.includes("globalSubscribers>=MAX_GLOBAL_SUBSCRIBERS"));});
