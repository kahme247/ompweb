import type { UpgradeApproval, UpgradePlan } from "@/lib/upgrade-types";
import type { AppUpdateInfo } from "./AppUpdateDialog";

export const DISMISSED_APP_UPDATE_KEY = "omp-web:dismissed-app-update";
export const COMPLETED_APP_UPDATE_KEY = "omp-web:completed-app-update";
export const APP_UPDATE_POLL_MS = 500;
export const APP_UPDATE_STOPPING_POLL_MS = 200;
// Longer than the backend's 30-minute coordinator lease, so the browser never gives up before the server does.
export const APP_UPDATE_TIMEOUT_MS = 35 * 60 * 1_000;
export const APP_UPDATE_PREPARING_MIN_MS = 1_000;
export const APP_UPDATE_VISIBLE_STAGE_MIN_MS = 1_000;
export const APP_UPDATE_COMPLETED_RELOAD_MS = 3_000;
export const APP_UPDATE_ERROR_MAX_LENGTH = 240;

/**
 * Dismissed-update versions, remembered per notification. Closing an update
 * toast must survive the visibilitycheck that re-runs the update checks, and
 * localStorage throws in private mode / at quota.
 */
export function readDismissedVersion(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function rememberDismissedVersion(key: string, version: string): void {
  try {
    window.localStorage.setItem(key, version);
  } catch {
    // Dismissal is best-effort: the toast stays closed for this page anyway.
  }
}

export async function waitForAppUpdateDwell(startedAt: number | null, minimumMs: number): Promise<void> {
  if (startedAt == null) return;
  const remainingMs = minimumMs - (Date.now() - startedAt);
  if (remainingMs <= 0) return;
  await new Promise<void>((resolve) => window.setTimeout(resolve, remainingMs));
}

const CONTROL_CHARS_PATTERN = "[\\u0000-\\u001F\\u007F]+";

export function sanitizeAppUpdateError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return raw
    .replace(new RegExp(CONTROL_CHARS_PATTERN, "g"), " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, APP_UPDATE_ERROR_MAX_LENGTH);
}

export function isExactLegacyTargetCompletion(update: AppUpdateInfo | null, targetVersion: string): boolean {
  return update?.selfUpdateStatus == null && update?.currentVersion === targetVersion;
}

export class AppUpdateTransportError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Update service connection failed");
    this.name = "AppUpdateTransportError";
  }
}

export class AppUpdateApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "AppUpdateApiError";
  }
}

export async function fetchAppUpdateJson<T>(input: string, init?: RequestInit, expectedStatus?: number): Promise<T> {
  let response: Response;
  let responseBody: string;
  try {
    response = await fetch(input, init);
    responseBody = await response.text();
  } catch (error) {
    throw new AppUpdateTransportError(error);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseBody);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Malformed JSON";
    const prefix = response.ok ? "Invalid update response" : `HTTP ${response.status}: invalid update response`;
    throw new Error(`${prefix}: ${detail}`);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(response.ok ? "Invalid update response" : `HTTP ${response.status}: invalid update response`);
  }

  const data = payload as T & { error?: unknown };
  if (typeof data.error === "string" && data.error.trim()) throw new AppUpdateApiError(data.error, response.status);
  if (data.error != null) throw new Error("Invalid update error response");
  if (!response.ok) throw new AppUpdateApiError(`HTTP ${response.status}`, response.status);
  if (expectedStatus !== undefined && response.status !== expectedStatus) {
    throw new Error(`Expected HTTP ${expectedStatus}, received HTTP ${response.status}`);
  }
  return data;
}

const JSON_POST = { method: "POST", headers: { "Content-Type": "application/json" } } as const;

export interface PreparedAppUpdate {
  attemptId: string;
  targetVersion: string;
  plan: UpgradePlan;
}

/** Asks the server for a plan. This never commits: committing needs a separate, explicit approval. */
export async function prepareAppUpdate(): Promise<PreparedAppUpdate> {
  const prepared = await fetchAppUpdateJson<{ attemptId?: unknown; targetVersion?: unknown; plan?: UpgradePlan }>(
    "/api/app-update",
    { ...JSON_POST, body: JSON.stringify({ action: "prepare" }) },
  );
  const { attemptId, targetVersion, plan } = prepared;
  if (typeof attemptId !== "string" || typeof targetVersion !== "string" || typeof plan?.id !== "string" || !Array.isArray(plan.hosts)) {
    throw new Error("Invalid update response");
  }
  return { attemptId, targetVersion, plan };
}

/** Commits a prepared attempt with the approval the user gave for exactly this plan. */
export function commitAppUpdate(attemptId: string, approval: UpgradeApproval): Promise<{ error?: string }> {
  return fetchAppUpdateJson<{ error?: string }>(
    "/api/app-update",
    { ...JSON_POST, body: JSON.stringify({ action: "commit", attemptId, approval }), keepalive: true },
    202,
  );
}

/** The server refused the commit because the plan expired or the candidate/hosts changed: review a new plan, never reuse the approval. */
export function isStaleAppUpdatePlanError(error: unknown): boolean {
  return error instanceof AppUpdateApiError && (error.status === 409 || error.status === 410 || error.status === 412);
}

/** A prepared attempt is still a proposal, even if a previous commit failed after recording approval. */
export function isAwaitingAppUpdateApproval(update: AppUpdateInfo | null): boolean {
  return update?.selfUpdateStatus?.state === "prepared";
}
