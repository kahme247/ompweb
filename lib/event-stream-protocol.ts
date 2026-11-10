// Wire contract for the multiplexed live-event stream (`/api/events`).
//
// Browsers cap HTTP/1.1 connections at 6 per host across ALL tabs, and every
// long-lived SSE response pins one of them. One tab used to hold up to three
// (running badges, the attached chat, the watched file), so three tabs froze
// every other request. Now one SharedWorker per browser holds a single
// `/api/events` stream and multiplexes every tab's subscriptions over it.
//
// Stream framing (SSE):
//   event: mux      data: MuxControlFrame       connection/subscription control
//   event: <subId>  data: <channel payload>     one subscription's frames
// Every frame also carries `id: <server ms at emit>`, read as `lastEventId`.
// Subscriptions are added/removed with POST /api/events (EventStreamRequest).
//
// The browser link (`browserTransport` "ws"; lib/browser-link.ts, docs/specs/2026-11-01-browser-link-design.md):
// one WebSocket per browser at GET /api/events/link, carrying every subscription and every agent command with the
// host link's sequencing, pieces and fair queues (lib/hosts/link-protocol.ts). Its `e` messages carry exactly the
// SSE frames above (name, emit time, data).
// Every hello and the `transport` control frame carry the setting; the worker switches on it.
//
// lib/event-stream-worker.ts imports this module (bundled by server/client-env.ts).

import { isValidNotificationId } from "./notification-events";
import type { DiagnosticStat } from "./transport-stats";

export const EVENT_STREAM_PATH = "/api/events";
export const MUX_CONTROL_EVENT = "mux";
/** Subscription ids double as SSE event names: no whitespace, never "mux"/"message". */
export const SUBSCRIPTION_ID_RE = /^s[0-9]{1,15}$/;
export const UNKNOWN_CONNECTION_CODE = "unknown_connection";

export type EventStreamChannel =
  | { kind: "running" }
  /** Notifications the server routes to the tab with this notification client id. */
  | { kind: "notifications"; clientId: string }
  | { kind: "session"; sessionId: string }
  | { kind: "file"; path: string; hostId?: string; sessionId: string | null }
  /** Host tool calls (open_url, notify, open_file) from sessions no tab is watching. */
  | { kind: "host-tools" }
  /** Settings → Hosts: the `GET /api/hosts` body on subscribe and after every change. */
  | { kind: "hosts" };

/** How the browser's shared worker reaches the server: SSE + HTTP POST, or the browser link (one WebSocket). */
export type BrowserTransport = "sse" | "ws";

export const BROWSER_TRANSPORTS: readonly BrowserTransport[] = ["sse", "ws"];

/** The setting every hello and `transport` frame carries. */
export interface BrowserTransportState {
  transport: BrowserTransport;
}

/** The worker's answer to a `diag` poll (the right panel's Connection tab). Times are the browser's epoch ms. */
/** Why the worker fell back to SSE: proxies refused the upgrade, or the server speaks another link version. */
export type FallbackReason = "refused" | "version";

export interface ConnectionDiagnostics {
  /** The server's setting. */
  setting: BrowserTransport;
  /** In effect in this browser now: `sse` with `fallback` set while the WebSocket link is unusable. */
  mode: BrowserTransport;
  fallback: FallbackReason | null;
  /** `idle`: no connection intended; `down`: no connection for long enough that commands fail. */
  status: "idle" | "connected" | "connecting" | "down";
  /** When the current connection attempt or outage began; null while idle or connected. */
  since: number | null;
  lastReconnect: { at: number; trigger: string; outageMs: number; resumed: boolean | null } | null;
  /** Within `windowMs`; resumes and resyncs are the browser link's. */
  reconnects: number;
  resumes: number;
  resyncs: number;
  clockRttMs: number | null;
  effectiveType: string | null;
  windowMs: number;
  stats: DiagnosticStat[];
}

export const BROWSER_LINK_PATH = "/api/events/link";
export const BROWSER_LINK_VERSION = 1;
/** How long the server keeps a link whose socket is gone, so the browser can resume it. */
export const LINK_RESUME_MS = 120_000;
/** How long the server remembers a command's reply by (session, rid): a resend within it is answered, not run again.
 * Longer than LINK_RESUME_MS, so a command resent after a resync to the same server still finds it. */
export const COMMAND_DEDUPE_MS = 600_000;

/** Commands whose successful reply does not confirm an omp round trip, so their reply times say nothing about omp:
 * answered by the web app itself when no omp child is alive (lib/agent-command.ts NO_SPAWN_REPLIES), or forwarded to
 * omp without awaiting its reply (lib/rpc-manager.ts dispatchCommand). */
export const NO_OMP_REPLY_COMMANDS: ReadonlySet<string> = new Set([
  "predict_word", "predict_word_feedback", "get_btw_history", "btw_cancel",
  "host_tool_result", "host_uri_result", "extension_ui_response",
  "outbox_add", "outbox_remove", "outbox_scope",
]);

const REPEATABLE_COMMANDS = ["predict_word", "predict_word_feedback", "set_host_tools", "set_host_uri_schemes", "outbox_add", "outbox_remove", "outbox_scope"];

/** Commands that are repeatable by nature: `get_*` and `predict_word` only read, the outbox commands are idempotent by
 * their message id (lib/message-outbox.ts), and the others register or record the same thing again. Safe to send again
 * after a resync, and not worth remembering for the (session, rid) dedupe, where they would only take room from
 * commands that change something (and be refused at the cap). Never `abort`: a resent one could stop a prompt that ran
 * after it. */
export function isIdempotentCommand(type: string): boolean {
  return type.startsWith("get_") || REPEATABLE_COMMANDS.includes(type);
}

export type MuxControlFrame =
  | ({ type: "hello"; connectionId: string; serverId: string } & BrowserTransportState)
  | { type: "open"; sub: string }
  | { type: "end"; sub: string }
  | { type: "refused"; sub: string; status: number; error: string; code: string }
  /** The setting changed; the worker switches transport. */
  | ({ type: "transport" } & BrowserTransportState);

export type EventStreamRequest =
  | { connectionId: string; subscribe: { id: string; channel: EventStreamChannel } }
  | { connectionId: string; unsubscribe: string };

const MAX_ID_LENGTH = 512;
const MAX_PATH_LENGTH = 8192;

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function parseEventStreamChannel(value: unknown): EventStreamChannel | null {
  if (!value || typeof value !== "object") return null;
  const channel = value as Record<string, unknown>;
  switch (channel.kind) {
    case "running":
      return { kind: "running" };
    case "notifications":
      return isValidNotificationId(channel.clientId) ? { kind: "notifications", clientId: channel.clientId } : null;
    case "host-tools":
      return { kind: "host-tools" };
    case "hosts":
      return { kind: "hosts" };
    case "session":
      return isBoundedString(channel.sessionId, MAX_ID_LENGTH) ? { kind: "session", sessionId: channel.sessionId } : null;
    case "file": {
      if (!isBoundedString(channel.path, MAX_PATH_LENGTH)) return null;
      const sessionId = channel.sessionId ?? null;
      if (sessionId !== null && !isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      if (channel.hostId !== undefined && !isBoundedString(channel.hostId, MAX_ID_LENGTH)) return null;
      return { kind: "file", path: channel.path, sessionId, ...(channel.hostId === undefined ? {} : { hostId: channel.hostId as string }) };
    }
    default:
      return null;
  }
}

export function parseEventStreamRequest(value: unknown): EventStreamRequest | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (!isBoundedString(body.connectionId, MAX_ID_LENGTH)) return null;
  if (typeof body.unsubscribe === "string") {
    return SUBSCRIPTION_ID_RE.test(body.unsubscribe) ? { connectionId: body.connectionId, unsubscribe: body.unsubscribe } : null;
  }
  const subscribe = body.subscribe as Record<string, unknown> | undefined;
  if (!subscribe || typeof subscribe.id !== "string" || !SUBSCRIPTION_ID_RE.test(subscribe.id)) return null;
  const channel = parseEventStreamChannel(subscribe.channel);
  return channel ? { connectionId: body.connectionId, subscribe: { id: subscribe.id, channel } } : null;
}
