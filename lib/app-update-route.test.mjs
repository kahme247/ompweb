import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { mock } from "bun:test";

const agent = mkdtempSync(join(tmpdir(), "ompweb-app-update-get-"));
const previousAgent = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agent;
const badId = "12345678-1234-4234-8234-123456789012";
const missingId = "12345678-1234-4234-8234-123456789099";
const planDir = join(agent, "omp-web", "server-upgrades", badId);
mkdirSync(join(agent, "omp-web", "server-upgrades"), { recursive: true, mode: 0o700 });
mkdirSync(planDir, { mode: 0o700 });
writeFileSync(join(planDir, "plan.json"), JSON.stringify({ id: "not-a-plan" }), { mode: 0o600 });

const realNpm = await import("./npm-update.ts");
const realSelf = await import("./self-update.ts");
let checkThrows = false;
let statusThrows = false;
let attemptId = badId;
mock.module("@/lib/npm-update", () => ({
  ...realNpm,
  checkNpmUpdate: async () => {
    if (checkThrows) throw new Error("registry down");
    return {
      currentVersion: "0.7.1", availableVersion: "0.7.2", updateAvailable: true,
      installMethod: "npm", updateCommand: "npm install -g @kahme247/ompweb", updatesDisabled: false,
    };
  },
}));
mock.module("@/lib/self-update", () => ({
  ...realSelf,
  getSelfUpdateStatus: () => {
    if (statusThrows) throw new Error("status unreadable");
    return { attemptId, state: "prepared", fromVersion: "0.7.1", targetVersion: "0.7.2", preparedAt: "2026-11-14T00:00:00.000Z" };
  },
}));
const { GET } = await import("../app/api/app-update/route.ts?fresh=unreadable-plan");
after(() => {
  mock.module("@/lib/npm-update", () => realNpm);
  mock.module("@/lib/self-update", () => realSelf);
  if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgent;
  rmSync(agent, { recursive: true, force: true });
});

test("GET omits an unreadable upgrade plan and still returns status", async () => {
  checkThrows = false;
  statusThrows = false;
  attemptId = badId;
  const response = await GET(new Request("http://localhost/api/app-update"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.currentVersion, "0.7.1");
  assert.equal(body.updateAvailable, true);
  assert.equal(body.selfUpdateStatus.attemptId, badId);
  assert.equal(body.selfUpdateStatus.state, "prepared");
  assert.equal(Object.hasOwn(body, "upgradePlan"), false);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("GET still returns a missing upgrade plan as null", async () => {
  checkThrows = false;
  statusThrows = false;
  attemptId = missingId;
  const response = await GET(new Request("http://localhost/api/app-update"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.selfUpdateStatus.state, "prepared");
  assert.equal(body.upgradePlan, null);
});

test("GET still fails when the update check or stored status throws", async () => {
  statusThrows = false;
  checkThrows = true;
  await assert.rejects(() => GET(new Request("http://localhost/api/app-update")));
  checkThrows = false;
  statusThrows = true;
  await assert.rejects(() => GET(new Request("http://localhost/api/app-update")));
});
