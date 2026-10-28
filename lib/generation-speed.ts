import type { AgentMessage, AssistantMessage } from "./types";

const RATE_PREFIXES = ["", "k", "M", "G", "T", "P", "E", "Z", "Y", "R", "Q"];

/** A five-character number and at most four-character SI token-rate unit. */
export function formatGenerationSpeed(rate: number | null | undefined): { value: string; unit: string } | null {
  if (rate == null || !Number.isFinite(rate) || rate < 0) return null;
  let prefix = 0;
  while (Math.round(rate * 10) >= 10_000) {
    // No SI prefix beyond quetta can represent this rate within the fixed slots.
    if (++prefix === RATE_PREFIXES.length) return null;
    rate /= 1000;
  }
  return { value: rate.toFixed(1), unit: `${RATE_PREFIXES[prefix]}t/s` };
}

/** omp's own floor for a meaningful generation span (`token-rate.ts`). */
export const MIN_MESSAGE_SPAN_MS = 100;

/** Live estimate settings: window, minimum span/tokens for a reading, and the
 * silence after which the stream counts as idle. */
export const STREAM_WINDOW_MS = 3000;
export const STREAM_MIN_SPAN_MS = 700;
export const STREAM_MIN_TOKENS = 12;
export const STREAM_STALE_MS = 2000;
/** Upper bound on retained samples — a long turn streams thousands of deltas. */
export const STREAM_MAX_SAMPLES = 256;

export interface MessageSpeed {
  tokensPerSecond: number;
  outputTokens: number;
  spanMs: number;
}

type SpeedMessage = Pick<AssistantMessage, "usage" | "duration" | "ttft" | "completedAt" | "timestamp" | "stopReason">;

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Final generation rate of one assistant message from omp's own fields:
 * `usage.output` over the generation span, with TTFT removed. Returns null
 * for errors, empty output and sub-100 ms spans (a 4-token answer whose
 * provider reported 0.95 ms of generation would otherwise read as 4232 t/s).
 */
export function messageSpeed(message: SpeedMessage): MessageSpeed | null {
  if (message.stopReason === "error") return null;
  const output = message.usage?.output;
  if (!finiteNumber(output) || output <= 0) return null;

  let spanMs: number | null = null;
  if (positiveFinite(message.duration)) {
    spanMs = message.duration;
    const { ttft } = message;
    if (finiteNumber(ttft) && ttft >= 0 && ttft < message.duration) spanMs = message.duration - ttft;
  } else if (finiteNumber(message.completedAt) && finiteNumber(message.timestamp) && message.completedAt > message.timestamp) {
    // Providers without `duration` (omp names gitlab-duo): the message's own
    // wall-clock span. Never estimate from neighbouring timestamps — that
    // would count tool execution as generation.
    spanMs = message.completedAt - message.timestamp;
  }
  if (spanMs == null || spanMs < MIN_MESSAGE_SPAN_MS) return null;

  const tokensPerSecond = (output * 1000) / spanMs;
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return null;
  return { tokensPerSecond, outputTokens: output, spanMs };
}

/** The streaming snapshot is a `Partial<AgentMessage>`; only role and content matter. */
export interface StreamMessageSnapshot {
  role?: AgentMessage["role"];
  content?: unknown;
}

/**
 * Rough token count of the streamed text so far: ASCII code points / 4 plus
 * one token per non-ASCII code point. Only `text` and `thinking` blocks —
 * tool-call JSON is bursty and its cost is already inside `usage.output`.
 */
export function estimateStreamTokens(message: StreamMessageSnapshot | null | undefined): number {
  if (!message || message.role !== "assistant") return 0;
  const content: unknown = message.content;
  if (!Array.isArray(content)) return 0;
  let ascii = 0;
  let nonAscii = 0;
  const count = (text: unknown) => {
    if (typeof text !== "string" || text.length === 0) return;
    for (const char of text) {
      const codePoint = char.codePointAt(0);
      if (codePoint === undefined) continue;
      if (codePoint <= 0x7f) ascii += 1;
      else nonAscii += 1;
    }
  };
  for (const block of content) {
    if (!block || typeof block !== "object" || !("type" in block)) continue;
    if (block.type === "text" && "text" in block) count(block.text);
    else if (block.type === "thinking" && "thinking" in block) count(block.thinking);
  }
  return ascii / 4 + nonAscii;
}

interface StreamSample {
  at: number;
  tokens: number;
}

/**
 * Rolling live-rate estimator over cumulative streamed token counts. The
 * clock starts at the first non-empty snapshot (TTFT excluded), the window
 * keeps one sample before its start as the anchor, and a shrinking count
 * (new message, retry, reconnect) restarts the baseline.
 */
export class StreamRateTracker {
  private samples: StreamSample[] = [];

  reset(): void {
    this.samples = [];
  }

  /** `totalTokens` is the cumulative estimate of the current snapshot. */
  observe(totalTokens: number, at: number = Date.now()): void {
    if (!Number.isFinite(totalTokens) || totalTokens <= 0 || !Number.isFinite(at)) return;
    const last = this.samples[this.samples.length - 1];
    if (last) {
      // Non-monotonic observations are ignorable noise, not a new baseline.
      if (at <= last.at) return;
      // No new tokens: keep the original delta timestamp so a stalled stream
      // correctly ages out instead of being kept alive by repeated polls.
      if (totalTokens === last.tokens) return;
      if (totalTokens < last.tokens) this.samples = [];
    }
    this.samples.push({ at, tokens: totalTokens });
    if (this.samples.length > STREAM_MAX_SAMPLES) this.samples.splice(0, this.samples.length - STREAM_MAX_SAMPLES);
    this.compact();
  }

  /** Rate over the window ending at the newest sample, or null when the
   * stream stalled / the span and delta are still too small. */
  rate(at: number = Date.now()): number | null {
    const newest = this.samples[this.samples.length - 1];
    if (!newest) return null;
    if (!Number.isFinite(at) || at - newest.at > STREAM_STALE_MS) return null;
    const oldest = this.samples[0];
    const spanMs = newest.at - oldest.at;
    const tokenDelta = newest.tokens - oldest.tokens;
    if (spanMs < STREAM_MIN_SPAN_MS || tokenDelta < STREAM_MIN_TOKENS) return null;
    const rate = (tokenDelta * 1000) / spanMs;
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  }

  /** Keep the oldest sample before the window as the anchor. */
  private compact(): void {
    const newestAt = this.samples[this.samples.length - 1].at;
    while (this.samples.length > 2 && this.samples[1].at <= newestAt - STREAM_WINDOW_MS) this.samples.shift();
  }
}
