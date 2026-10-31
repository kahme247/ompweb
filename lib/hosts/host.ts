import type { RpcTransport } from "../omp/rpc-transport";
import type { SessionOps } from "./session-ops";

export type HostStatus = "online" | "offline" | "needs-upgrade" | "omp-missing";

/** The link carries traffic: sends, ops and children work. An omp-missing host
 * is linked too; only spawning there fails, with its own error. */
export function isLinkUp(status: HostStatus): boolean {
  return status === "online" || status === "omp-missing";
}

export interface SpawnRequest {
  cwd: string;
  recordedCwd: string | null;
  sessionFile: string;
  toolNames?: string[];
  advisor: boolean;
  /** `provider/modelId` bound at spawn (--model); resume only. */
  spawnModel?: string;
}

export interface SpawnResult {
  transport: RpcTransport;
  cwd: string;
  fellBack: boolean;
  /** The host's project launch config forces --advisor. */
  launchAdvisor: boolean;
}

/** A machine omp sessions run on. Every machine-local action of a session goes through it. */
export interface Host {
  readonly id: string;
  readonly label: string;
  status(): HostStatus;
  onStatus(listener: (status: HostStatus) => void): () => void;
  spawnRpc(request: SpawnRequest): Promise<SpawnResult>;
  sessionFileExists(path: string): Promise<boolean>;
  invalidateSessionLists(sessionFile?: string): void;
  autoApproveExtension(): boolean;
  /** Session and project file operations, run on this host. */
  readonly sessionOps: SessionOps;
}
