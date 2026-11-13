import type { NpmUpdateStatus } from "../npm-update";

/** omp is not a target: it updates with ompweb, whose release ships its runner. */
export type HostUpdateTarget = "ompweb";

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
  /** "omp": an `omp update` a host recorded before omp updated with ompweb. */
  target: HostUpdateTarget | "omp";
  version: string;
  state: "running" | "succeeded" | "failed";
  error?: string;
}

export interface HostUpdateInfo {
  ompweb: HostSoftwareUpdate & Pick<NpmUpdateStatus, "installMethod"> & { protocolVersion: number | null };
  omp: { currentVersion: string | null };
  operation: HostUpdateOperation | null;
}
