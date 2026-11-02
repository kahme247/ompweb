import type { NpmUpdateStatus } from "../npm-update";
import type { OmpUpdateStatus } from "../omp/updates";

export type HostUpdateTarget = "ompweb" | "omp";

/** The running web server's supported daemon protocol range. Supplied by the hub, never by the browser. */
export interface HostUpdateCompatibility {
  min: number;
  max: number;
}

export interface HostSoftwareUpdate {
  currentVersion: string | null;
  availableVersion: string | null;
  updateAvailable: boolean;
  canUpdate: boolean;
  /** A human-readable reason the available update cannot be installed. Never infer compatibility from a version number. */
  blockedReason: string | null;
  updateCommand: string;
}

export interface HostUpdateOperation {
  id: string;
  target: HostUpdateTarget;
  version: string;
  state: "running" | "succeeded" | "failed";
  error?: string;
}

export interface HostUpdateInfo {
  ompweb: HostSoftwareUpdate & Pick<NpmUpdateStatus, "installMethod"> & { protocolVersion: number | null };
  omp: HostSoftwareUpdate & Pick<OmpUpdateStatus, "updatesDisabled">;
  operation: HostUpdateOperation | null;
}
