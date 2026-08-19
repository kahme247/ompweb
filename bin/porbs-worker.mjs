#!/usr/bin/env node
import { createJiti } from "jiti";
import { join } from "node:path";
import { homedir } from "node:os";
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { parseHostId } = jiti("../lib/porbs/types.ts");
const { WorkerAuthenticator } = jiti("../lib/porbs/worker-auth.ts");
const { WorkerSessionManager, assertWorkspacePrincipalIsolation } = jiti("../lib/porbs/worker-sessions.ts");
const { createWorkerServer } = jiti("../lib/porbs/worker-server.ts");

const hostId = parseHostId(process.env.PORBS_HOST_ID);
const secret = process.env.PORBS_WORKER_SECRET;
if (!secret) throw new Error("PORBS_WORKER_SECRET is required");
const workspaces = JSON.parse(process.env.PORBS_WORKSPACES || "{}");
const stateDir = process.env.PORBS_STATE_DIR || join(homedir(), ".omp", "porbs-worker");
const uid = process.env.PORBS_SESSION_UID === undefined ? undefined : Number(process.env.PORBS_SESSION_UID);
const gid = process.env.PORBS_SESSION_GID === undefined ? undefined : Number(process.env.PORBS_SESSION_GID);
const workspaceRoot = process.env.PORBS_WORKSPACE_ROOT;
if (process.env.NODE_ENV === "production" && (!Number.isInteger(uid) || !Number.isInteger(gid) || uid === process.getuid?.() || !workspaceRoot)) {
  throw new Error("production requires distinct PORBS_SESSION_UID/GID and PORBS_WORKSPACE_ROOT");
}
const workspaceIdentities = process.env.NODE_ENV === "production" ? await assertWorkspacePrincipalIsolation(workspaceRoot, workspaces, uid, gid) : undefined;
const auth = new WorkerAuthenticator({ hostId, secret, noncePath: join(stateDir, "nonces.json") });
const manager = new WorkerSessionManager({ hostId, workspaces, workspaceRoot, workspaceIdentities, operationPath: join(stateDir, "operations.json"), uid, gid });
const server = createWorkerServer({ auth, manager });
server.listen(Number(process.env.PORBS_PORT || 30179), process.env.PORBS_BIND || "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`porbs worker ${hostId} listening on ${typeof address === "object" && address ? address.port : "unknown"}\n`);
});
