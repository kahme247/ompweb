import type { HostToolDefinition } from "./pi-types";
import { isRecord } from "./type-guards";

/**
 * Server-side agent tools for issue #275: tools an agent running inside
 * omp-web can call to reach *other* top-level omp-web sessions. omp's own
 * `task` tool and `write agent://<id>` only work inside one omp process,
 * so cross-session work has to be answered by the omp-web server itself —
 * never by an attached browser tab (the issue's key requirement: these
 * tools keep working with no tab open).
 *
 * This module is deliberately pure: it knows nothing about RpcProcess,
 * the session registry, or the session files. The caller (lib/rpc-manager)
 * supplies those through AgentToolSessionOps, which keeps the validation,
 * gating, attribution and loop-guard logic unit-testable without a live
 * omp child. The only omp-web surface this module touches is the
 * HostToolDefinition shape omp already understands for set_host_tools.
 */

/** Tools the server answers itself. Browser-routed tools are unaffected. */
export const AGENT_TOOL_NAMES = new Set(["list_sessions", "new_session", "send_to_session"]);

export const AGENT_TOOL_DEFINITIONS: HostToolDefinition[] = [
  {
    name: "list_sessions",
    description:
      "List omp-web sessions (ID, name, working directory, running or idle) so send_to_session can address one without the user copying IDs.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "new_session",
    description:
      "Start a new omp-web session. The new session appears in the omp-web sidebar like any other session. Returns its session ID.",
    parameters: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Project directory. Defaults to the calling session's directory." },
        prompt: { type: "string", description: "First message for the new session. If omitted, the session is created idle." },
        model: { type: "string", description: "Model as \"provider/modelId\", e.g. \"anthropic/claude-sonnet-4-5\"." },
        provider: { type: "string", description: "Model provider, used with modelId instead of model." },
        modelId: { type: "string", description: "Model ID, used with provider instead of model." },
        name: { type: "string", description: "Display name for the new session." },
      },
    },
  },
  {
    name: "send_to_session",
    description:
      "Send a message to another omp-web session by ID. If the target is not running it is resumed first, as when a user opens it. The delivered message is prefixed with the sending session's ID so the target transcript shows where it came from.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Target session ID (see list_sessions)." },
        message: { type: "string", description: "Message to deliver to the target session." },
        delivery: {
          type: "string",
          description:
            "How to deliver while the target is running: \"prompt\" starts a new turn (only when the target is idle), \"steer\" steers the running turn, \"followUp\" queues after it. Defaults to \"prompt\".",
          enum: ["prompt", "steer", "followUp"],
        },
        wait: {
          type: "boolean",
          description:
            "When true, wait for the target turn to finish (up to waitTimeoutMs) and return its final assistant text. When false, return as soon as the target accepts the message.",
        },
        waitTimeoutMs: { type: "number", description: "Maximum wait for a waited delivery, in milliseconds. Defaults to 120000, capped at 300000." },
      },
      required: ["sessionId", "message"],
    },
  },
];

/** A message that would also be rejected by the HTTP body limit is too big to relay. */
export const MAX_AGENT_TOOL_MESSAGE_CHARS = 100_000;
/** Per-source rate cap: a runaway agent cannot spam sessions faster than this. */
export const MAX_AGENT_TOOL_CALLS_PER_MINUTE = 20;
/**
 * Chain-depth cap: a delivery from session A to session B makes B's depth
 * A's depth + 1. A ping-pong (A→B→A→B…) therefore stops at the cap instead
 * of looping forever. A session never touched by an agent tool has depth 0.
 */
export const MAX_AGENT_TOOL_CHAIN_DEPTH = 5;
export const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
export const MAX_WAIT_TIMEOUT_MS = 300_000;

export interface AgentToolSessionSummary {
  id: string;
  name?: string;
  cwd?: string;
  running: boolean;
}

export interface AgentToolCreateSessionInput {
  cwd: string;
  /** Already sender-attributed by executeAgentTool, or null for an idle session. */
  prompt: string | null;
  provider?: string;
  modelId?: string;
  name?: string;
}

export interface AgentToolDeliverInput {
  sessionId: string;
  /** Already sender-attributed by executeAgentTool. */
  message: string;
  delivery: "prompt" | "steer" | "followUp";
  wait: boolean;
  waitTimeoutMs: number;
}

export interface AgentToolDeliverResult {
  accepted: boolean;
  targetSessionId: string;
  delivery: "prompt" | "steer" | "followUp";
  /** True only when wait was requested and the turn actually finished. */
  waited: boolean;
  /** Final assistant text of the waited turn, or null when wait was false. */
  responseText: string | null;
}

/** Session operations supplied by lib/rpc-manager; fakes replace them in tests. */
export interface AgentToolSessionOps {
  listSessions(): Promise<AgentToolSessionSummary[]>;
  createSession(input: AgentToolCreateSessionInput): Promise<{ sessionId: string }>;
  deliver(input: AgentToolDeliverInput): Promise<AgentToolDeliverResult>;
}

export interface AgentToolContext {
  sourceSessionId: string;
  sourceCwd: string;
  /** The off-by-default Settings gate (lib/web-settings agentToolsEnabled). */
  enabled: boolean;
  guard: AgentToolGuard;
}

/**
 * Loop + spam guard. Two independent mechanisms, because neither alone
 * stops every loop: the rate cap stops a fast ping-pong, and the chain
 * depth stops a slow one that would otherwise run for hours.
 */
export class AgentToolGuard {
  private callsBySource = new Map<string, number[]>();
  private depthBySession = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Throws when the source already used its per-minute budget. */
  checkRate(sourceSessionId: string): void {
    const now = this.now();
    const recent = (this.callsBySource.get(sourceSessionId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= MAX_AGENT_TOOL_CALLS_PER_MINUTE) {
      throw new Error(
        `Agent tool rate limit exceeded for this session (${MAX_AGENT_TOOL_CALLS_PER_MINUTE} calls per minute).`,
      );
    }
    recent.push(now);
    this.callsBySource.set(sourceSessionId, recent);
  }

  depthFor(sessionId: string): number {
    return this.depthBySession.get(sessionId) ?? 0;
  }

  /**
   * Depth a delivery from `source` to `target` would give `target`.
   * Throws when that depth would exceed the cap. The depth is only
   * recorded (setDepth) after a successful delivery, so a rejected or
   * failed call never advances the chain.
   */
  checkChainDepth(sourceSessionId: string): number {
    const depth = this.depthFor(sourceSessionId) + 1;
    if (depth > MAX_AGENT_TOOL_CHAIN_DEPTH) {
      throw new Error(
        `Agent tool chain depth limit exceeded (${MAX_AGENT_TOOL_CHAIN_DEPTH}): sessions messaging each other in a loop are stopped here.`,
      );
    }
    return depth;
  }

  setDepth(sessionId: string, depth: number): void {
    this.depthBySession.set(sessionId, depth);
  }

  reset(): void {
    this.callsBySource.clear();
    this.depthBySession.clear();
  }
}

/** Attribution that lands in the target transcript itself, so any reader
 * (user or target agent) can see where the message came from. The full
 * source ID is kept so it can be found in the sidebar. */
export function formatAttributedMessage(sourceSessionId: string, message: string): string {
  return `[From session ${sourceSessionId} via omp-web agent tools]: ${message}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Agent tool arguments must be an object.");
  return value;
}

function requiredString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Agent tool argument "${field}" is required and must be a non-empty string.`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`Agent tool argument "${field}" must be a non-empty string when provided.`);
  return value.trim();
}

function parseSessionId(value: string): string {
  if (value.length > 200 || /[\s/\\]/.test(value)) {
    throw new Error("Agent tool argument \"sessionId\" is not a valid session ID.");
  }
  return value;
}

function parseModel(args: Record<string, unknown>): { provider?: string; modelId?: string } {
  const model = optionalString(args, "model");
  const provider = optionalString(args, "provider");
  const modelId = optionalString(args, "modelId");
  if (model) {
    const slash = model.indexOf("/");
    if (slash <= 0 || slash === model.length - 1) {
      throw new Error("Agent tool argument \"model\" must be \"provider/modelId\".");
    }
    if (provider && provider !== model.slice(0, slash)) {
      throw new Error("Agent tool arguments \"model\" and \"provider\" disagree.");
    }
    if (modelId && modelId !== model.slice(slash + 1)) {
      throw new Error("Agent tool arguments \"model\" and \"modelId\" disagree.");
    }
    return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
  }
  if ((provider && !modelId) || (!provider && modelId)) {
    throw new Error("Agent tool arguments \"provider\" and \"modelId\" must be provided together.");
  }
  return { provider, modelId };
}

function parseDelivery(args: Record<string, unknown>): "prompt" | "steer" | "followUp" {
  const delivery = args.delivery;
  if (delivery === undefined || delivery === null) return "prompt";
  if (delivery === "prompt" || delivery === "steer" || delivery === "followUp") return delivery;
  throw new Error("Agent tool argument \"delivery\" must be \"prompt\", \"steer\", or \"followUp\".");
}

function parseWait(args: Record<string, unknown>): { wait: boolean; waitTimeoutMs: number } {
  const wait = args.wait;
  if (wait !== undefined && typeof wait !== "boolean") {
    throw new Error("Agent tool argument \"wait\" must be a boolean.");
  }
  const timeout = args.waitTimeoutMs;
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)) {
    throw new Error("Agent tool argument \"waitTimeoutMs\" must be a positive number.");
  }
  return {
    wait: wait === true,
    waitTimeoutMs: Math.min(MAX_WAIT_TIMEOUT_MS, Math.floor(timeout ?? DEFAULT_WAIT_TIMEOUT_MS)),
  };
}

function checkMessageLength(message: string, field: string): void {
  if (message.length > MAX_AGENT_TOOL_MESSAGE_CHARS) {
    throw new Error(`Agent tool argument "${field}" exceeds ${MAX_AGENT_TOOL_MESSAGE_CHARS} characters.`);
  }
}

/**
 * Execute one server-side agent tool. Returns a plain JSON-able result the
 * caller renders as the host_tool_result text payload. Throws on every
 * rejection (disabled gate, validation, rate/chain limits, unknown tool,
 * or an ops failure) so the agent gets an explicit error, never a hang.
 */
export async function executeAgentTool(
  toolName: string,
  args: unknown,
  ops: AgentToolSessionOps,
  ctx: AgentToolContext,
): Promise<unknown> {
  if (!ctx.enabled) {
    throw new Error("Agent tools are disabled. Enable \"Agent tools\" in omp-web Settings (System & Updates) first.");
  }
  if (!AGENT_TOOL_NAMES.has(toolName)) throw new Error(`Unknown agent tool: ${toolName}.`);
  const record = asRecord(args);

  if (toolName === "list_sessions") {
    ctx.guard.checkRate(ctx.sourceSessionId);
    return { sessions: await ops.listSessions() };
  }

  if (toolName === "new_session") {
    ctx.guard.checkRate(ctx.sourceSessionId);
    const depth = ctx.guard.checkChainDepth(ctx.sourceSessionId);
    const cwd = optionalString(record, "cwd") ?? ctx.sourceCwd;
    if (!cwd) throw new Error("Agent tool argument \"cwd\" is required when the calling session has no directory.");
    const prompt = optionalString(record, "prompt");
    if (prompt) checkMessageLength(prompt, "prompt");
    const { provider, modelId } = parseModel(record);
    const name = optionalString(record, "name");
    if (name && name.length > 200) throw new Error("Agent tool argument \"name\" exceeds 200 characters.");
    const created = await ops.createSession({
      cwd,
      prompt: prompt ? formatAttributedMessage(ctx.sourceSessionId, prompt) : null,
      provider,
      modelId,
      name,
    });
    ctx.guard.setDepth(created.sessionId, depth);
    return { sessionId: created.sessionId };
  }

  // send_to_session
  ctx.guard.checkRate(ctx.sourceSessionId);
  const sessionId = parseSessionId(requiredString(record, "sessionId"));
  if (sessionId === ctx.sourceSessionId) {
    throw new Error("Agent tool \"send_to_session\" cannot target the calling session itself.");
  }
  const message = requiredString(record, "message");
  checkMessageLength(message, "message");
  const delivery = parseDelivery(record);
  const { wait, waitTimeoutMs } = parseWait(record);
  const depth = ctx.guard.checkChainDepth(ctx.sourceSessionId);
  const result = await ops.deliver({
    sessionId,
    message: formatAttributedMessage(ctx.sourceSessionId, message),
    delivery,
    wait,
    waitTimeoutMs,
  });
  ctx.guard.setDepth(sessionId, depth);
  return result;
}
