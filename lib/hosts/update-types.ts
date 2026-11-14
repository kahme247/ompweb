import type { NpmUpdateStatus } from "../npm-update";

/** omp is not a target: it updates with ompweb, whose release ships its runner. */
export type HostUpdateTarget = "ompweb";

/** The running web server's supported daemon protocol range. Supplied by the hub, never by the browser. */
export interface HostUpdateCompatibility {
  min: number;
  max: number;
}

/**
 * Why an update cannot start now, for a UI that must not infer permission from English text.
 * `forceable`: only activity (running sessions, uploads, operations); an explicit force ends it.
 * `coordination: "server"`: only a coordinated web-server cutover resolves it (a shared installation, a protocol range the
 * server does not speak yet); the host cannot do it alone, force or not.
 * Everything else (disabled updates, unverified or damaged releases, ownership, an uncontrollable supervisor, a local
 * maintenance drain) is never forceable.
 */
export interface HostUpdateBlocker {
  code: "updates_disabled" | "check_failed" | "protocol_unverified" | "protocol_incompatible" | "update_in_progress" | "unsupported_install" | "shared_install" | "supervisor_unsupported" | "host_drained" | "host_busy";
  message: string;
  forceable: boolean;
  coordination?: "server";
}

export interface HostSoftwareUpdate {
  currentVersion: string | null;
  availableVersion: string | null;
  updateAvailable: boolean;
  canUpdate: boolean;
  /** Every blocker, so a UI can tell forceable ones (see HostUpdateBlocker) from final ones. Empty when `canUpdate`. Absent from a daemon that predates force. */
  blockers?: HostUpdateBlocker[];
  /** An available update is blocked only by forceable blockers: an update request with `force` would be accepted, ending this host's sessions. Absent from a daemon that predates force; never infer it. */
  canForceUpdate?: boolean;
  /** How a force would be carried out. A native daemon sets "native" whenever `canForceUpdate`; the web server adds "recovery" for an older daemon it can recover through its recovery path instead. */
  forceMethod?: "native" | "recovery";
  /** The first blocker's message, human-readable. Never infer compatibility or permission from it or from a version number. */
  blockedReason: string | null;
  updateCommand: string;
}

export interface HostUpdateOperation {
  /** The operation id the caller supplied (HostUpdateRequest.operationId), else a generated one; the same id names the attempt, its worker and every acknowledgement. */
  id: string;
  /** "omp": an `omp update` a host recorded before omp updated with ompweb. */
  target: HostUpdateTarget | "omp";
  version: string;
  state: "running" | "succeeded" | "failed";
  error?: string;
  /** The update was explicitly forced past this host's activity: its sessions end at the commit. */
  force?: true;
  /** A forced update's commit has begun: this host accepts no new work (sessions, project preparation) any more. */
  committing?: true;
  /** Sessions running on this host when a forced update was accepted: the work the commit interrupts (resumed from the preserved manifest only where auto-resume is on). */
  interruptedSessions?: number;
  /** The candidate's application protocol is outside the current server's range: it is acknowledged through a maintenance receipt, and its application link awaits the web server's cutover. */
  awaitingServerCutover?: true;
}

/** Optional parts of a start request, all supplied by the web server and never by the browser. */
export interface HostUpdateRequest {
  /** Explicit operator approval to end this host's activity (sessions included) once the release is staged and preflighted. Never bypasses integrity, ownership, the disable setting or process identity. */
  force?: boolean;
  /** The protocol range of the web server this host is going to be linked with after a coordinated cutover. A candidate within it, but outside the current range, installs and is acknowledged through maintenance. */
  targetCompatibility?: HostUpdateCompatibility;
  /** A UUID naming this operation, so a coordinator can correlate retries and health: the attempt, worker descriptor and acknowledgements carry it. Starting an id again returns that operation's state and starts nothing. */
  operationId?: string;
}

export interface HostUpdateInfo {
  ompweb: HostSoftwareUpdate & Pick<NpmUpdateStatus, "installMethod"> & { protocolVersion: number | null; activeSessions?: number };
  omp: { currentVersion: string | null };
  operation: HostUpdateOperation | null;
}
