import type { HostUpdateCompatibility } from "./hosts/update-types";

export interface UpgradeParticipant {
  id: string;
  label: string;
  currentVersion: string | null;
  protocolVersion: number | null;
  targetVersion: string | null;
  needsUpgrade: boolean;
  recovery: "maintenance" | "legacy" | "local" | "shared-local" | "none";
  sessionProcesses: number | null;
  activeTurns: number | null;
  blockedReason: string | null;
  stage: "unchanged" | "pending" | "updating" | "ready" | "failed";
  operationId?: string;
  error?: string;
}

/** A server-owned snapshot. Commit approval names its id, never browser-selected hosts or protocols. */
export interface UpgradePlan {
  id: string;
  fromVersion: string;
  targetVersion: string;
  compatibility: HostUpdateCompatibility;
  hosts: UpgradeParticipant[];
  requiresForce: boolean;
  blockedReason: string | null;
  preparedAt: string;
  expiresAt: string;
  state: "prepared" | "updating-hosts" | "ready" | "updating-server" | "succeeded" | "failed" | "recovery-required";
  approved?: { force: boolean; at: string };
  error?: string;
}

export interface UpgradeApproval {
  planId: string;
  force: boolean;
}
