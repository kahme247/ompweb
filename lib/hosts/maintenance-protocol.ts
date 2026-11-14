// Maintenance API v1: a small request/reply WebSocket between a host daemon and the server, versioned apart from the
// application link (link-protocol.ts) so an upgrade still reaches a host whose application protocol differs.
// Self-contained: no application-link imports. Everything the peer sends is untrusted input.
import { isRecord } from "../type-guards";

export const MAINTENANCE_API_VERSION = 1;
export const MAINTENANCE_PATH = "/api/hosts/maintenance";
export const MAINTENANCE_OPS = ["status", "listSessions", "checkUpdates", "updateSoftware"] as const;
export type MaintenanceOp = (typeof MAINTENANCE_OPS)[number];

/** The host's first frame. `protocolVersion` (the application link's) is advisory: nothing here depends on it. */
export type MaintenanceHello = {
  type: "hello";
  apiVersion: number;
  protocolVersion: number;
  ompwebVersion: string;
  ompVersion: string | null;
  platform: string;
  capabilities: MaintenanceOp[];
};

/** `apiMismatch`: the hello's apiVersion is not the server's; its reason is JSON `{"apiVersion": <server's>}`. */
export const MAINTENANCE_CLOSE = { goingAway: 1001, policy: 1008, tooBig: 1009, tryLater: 1013, replaced: 4409, apiMismatch: 4426 } as const;

/** `frameBytes`: one frame, so a request's args or a result (session inventory metadata, never file contents).
 * `inFlight`: requests open at once on one link. */
export const MAINTENANCE_LIMITS = { frameBytes: 1024 * 1024, inFlight: 8 };

/** Mutable so tests shorten them. */
export const maintenanceTimings = { pingMs: 15_000, offlineMs: 45_000, helloMs: 10_000, requestMs: 30_000, retryMs: 1_000, retryMaxMs: 15_000 };

/** A failure the peer reports, or this side raises. Statuses are HTTP's; codes are lowercase snake_case. */
export class MaintenanceError extends Error {
  readonly name = "MaintenanceError";
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** One frame as a text line; a MaintenanceError (413) when it is over the frame limit. */
export function encodeFrame(frame: object): string {
  const line = JSON.stringify(frame);
  if (Buffer.byteLength(line) > MAINTENANCE_LIMITS.frameBytes) throw new MaintenanceError(413, "too_large", `A maintenance frame is limited to ${MAINTENANCE_LIMITS.frameBytes} bytes`);
  return line;
}

export const PING = encodeFrame({ type: "ping" });
export const PONG = encodeFrame({ type: "pong" });
export const WELCOME = encodeFrame({ type: "welcome", apiVersion: MAINTENANCE_API_VERSION });

/** A received frame's JSON object (which has a string `type`); anything else is a protocol violation: a MaintenanceError. */
export function decodeFrame(data: unknown): Record<string, unknown> {
  if (typeof data !== "string") throw new MaintenanceError(400, "bad_frame", "Maintenance frames are text");
  if (Buffer.byteLength(data) > MAINTENANCE_LIMITS.frameBytes) throw new MaintenanceError(413, "too_large", `A maintenance frame is limited to ${MAINTENANCE_LIMITS.frameBytes} bytes`);
  let frame: unknown;
  try {
    frame = JSON.parse(data);
  } catch {
    throw new MaintenanceError(400, "bad_frame", "A maintenance frame is not JSON");
  }
  if (!isRecord(frame) || typeof frame.type !== "string") throw new MaintenanceError(400, "bad_frame", "A maintenance frame is an object with a type");
  return frame;
}

const short = (value: unknown): value is string => typeof value === "string" && value.length <= 100;

/** A hello's fields once its apiVersion is known to be this API's, else null. Capabilities this side does not know are
 * dropped, so a later revision of API 1 may add operations without breaking the handshake. */
export function parseHello(frame: Record<string, unknown>): MaintenanceHello | null {
  const { apiVersion, protocolVersion, ompwebVersion, ompVersion, platform, capabilities } = frame;
  if (apiVersion !== MAINTENANCE_API_VERSION || typeof protocolVersion !== "number" || !Number.isInteger(protocolVersion)) return null;
  if (!short(ompwebVersion) || !short(platform) || !(ompVersion === null || short(ompVersion)) || !Array.isArray(capabilities)) return null;
  return { type: "hello", apiVersion: MAINTENANCE_API_VERSION, protocolVersion, ompwebVersion, ompVersion, platform, capabilities: MAINTENANCE_OPS.filter((op) => capabilities.includes(op)) };
}

/** The wire form of a failure, read from an Error or a `res` frame alike: a status in 400..599 (`status`, or the
 * `httpStatus` of a HostUpdateError) and a lowercase code are kept; anything else is a 500 `internal`. */
export function failure(error: unknown): { status: number; code: string; message: string } {
  const e: Record<string, unknown> = isRecord(error) ? error : {};
  const raw = e.status ?? e.httpStatus;
  const status = typeof raw === "number" && Number.isInteger(raw) && raw >= 400 && raw <= 599 ? raw : 500;
  const code = typeof e.code === "string" && /^[a-z0-9_]{1,64}$/.test(e.code) ? e.code : status === 500 ? "internal" : "host_error";
  return { status, code, message: (typeof e.message === "string" ? e.message : "The host reported an error").slice(0, 500) };
}
