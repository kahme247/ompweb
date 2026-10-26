import { randomUUID } from "node:crypto";
import type { SttAfter, SttConfig } from "@/lib/stt";
import { authGatewayRequest } from "@/lib/omp/auth-gateway";

/**
 * Server-owned transcription jobs. POST /api/stt starts one and returns its id
 * at once; browsers poll GET /api/stt/[jobId]. The server holds the slow
 * upstream request and keeps the recording in memory, so a job survives the
 * recording browser disconnecting: any browser showing the same composer
 * scope (session id or `new:<cwd>` draft key) can find it, play the audio,
 * retry a failure, and claim the transcript exactly once.
 */
export type SttJobStatus = "pending" | "done" | "error" | "gone";

interface SttJob {
  id: string;
  scope: string | null;
  /** Null once the job is closed: the tombstone holds no audio. */
  audio: File | null;
  status: SttJobStatus;
  text?: string;
  error?: string;
  /** Aborts the running upstream attempt when the job is closed. */
  attempt?: AbortController;
  /** Claim token of the browser that took the transcript; lets it repeat a lost claim. */
  claimedBy?: string;
  /** Claim token of the recording browser: it alone may claim during OWNER_GRACE_MS. */
  owner?: string;
  after?: SttAfter;
  doneAt?: number;
  expiry?: NodeJS.Timeout;
}

/** What pollers see. The transcript is never here: only a claim returns it. */
export interface SttJobView {
  id: string;
  status: SttJobStatus;
  error?: string;
}

export interface SttClaim extends SttJobView {
  text?: string;
  after?: SttAfter;
}

/**
 * Cap on how long the server waits on the STT endpoint. Kept under undici's
 * default 300s headersTimeout so a slow upstream ends as "timed out", not
 * an opaque "fetch failed".
 */
const STT_UPSTREAM_TIMEOUT_MS = 290_000;
/** Unclaimed results and failures (with their audio) stay retrievable this long. */
const SETTLED_JOB_TTL_MS = 60 * 60_000;
/** Claimed/discarded jobs answer "gone" this long so other browsers stand down. */
const GONE_JOB_TTL_MS = 10 * 60_000;
/**
 * After a job finishes, only the recording browser may claim it for this
 * long, so it keeps the transcript and its send/queue intent; other browsers
 * take over only if it has gone away.
 */
const OWNER_GRACE_MS = 15_000;
/** Each pending job runs an upstream request; refuse new ones past this. */
const MAX_PENDING_JOBS = 4;
/** Each live job holds up to 25MB of audio; refuse new ones past this. */
const MAX_LIVE_JOBS = 20;
/**
 * Tombstones hold no audio but would otherwise keep a slot for
 * GONE_JOB_TTL_MS, so an upload/discard loop would grow the store at the
 * client's request rate. Keep at most this many; live jobs are never evicted.
 */
const MAX_TOMBSTONES = 20;

declare global {
  // globalThis survives Next.js hot reload and is shared by the separately
  // bundled /api/stt route handlers; a module-level Map is neither.
  var __ompSttJobs: Map<string, SttJob> | undefined;
}

const store = (globalThis.__ompSttJobs ??= new Map<string, SttJob>());

function view(job: SttJob): SttJobView {
  return { id: job.id, status: job.status, error: job.error };
}

function expireIn(job: SttJob, ms: number): void {
  clearTimeout(job.expiry);
  job.expiry = setTimeout(() => store.delete(job.id), ms);
  job.expiry.unref?.();
}

function extractUpstreamErrorMessage(data: unknown, rawText: string, status: number): string {
  if (data && typeof data === "object" && "error" in data) {
    const error: unknown = data.error;
    if (typeof error === "string" && error.trim()) return error;
    if (error && typeof error === "object" && "message" in error) {
      const message: unknown = error.message;
      if (typeof message === "string" && message.trim()) return message;
    }
  }
  if (rawText.trim()) return rawText.trim().slice(0, 500);
  return `Transcription failed (upstream ${status})`;
}

const MAX_GATEWAY_AUDIO_BYTES = 18 * 1024 * 1024;

/** One upstream round trip: the configured endpoint, or omp's auth gateway when only a model is set. */
async function requestTranscription({ endpoint, apiKey, model }: SttConfig, audio: File, signal: AbortSignal): Promise<{ ok: boolean; status: number; rawText: string }> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(STT_UPSTREAM_TIMEOUT_MS)]);
  if (!endpoint) {
    // The gateway caps its JSON body at 25MB and base64 grows audio by 4/3.
    if (audio.size > MAX_GATEWAY_AUDIO_BYTES) {
      return { ok: false, status: 413, rawText: "Recording too large for omp's transcription gateway (max 18MB)" };
    }
    const ext = audio.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "webm";
    const data = Buffer.from(await audio.arrayBuffer()).toString("base64");
    const res = await authGatewayRequest("/v1/audio/transcriptions", { model, input_audio: { data, format: ext } }, signal);
    const rawText = typeof res.body === "string" ? res.body : JSON.stringify(res.body ?? {});
    return { ok: res.status >= 200 && res.status < 300, status: res.status, rawText };
  }
  const formData = new FormData();
  formData.append("file", audio, audio.name);
  if (model) formData.append("model", model);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    body: formData,
    signal,
  });
  return { ok: res.ok, status: res.status, rawText: await res.text() };
}

async function transcribe(config: SttConfig, audio: File, signal: AbortSignal): Promise<Pick<SttJob, "status" | "text" | "error">> {
  const { apiKey } = config;
  // Everything, including building the request, stays inside the try: a
  // rejection here would leave the job pending forever with no expiry timer.
  try {
    const { ok, status, rawText } = await requestTranscription(config, audio, signal);
    let data: unknown = null;
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = null;
    }
    if (!ok) {
      return { status: "error", error: extractUpstreamErrorMessage(data, rawText, status) };
    }
    // Plain-text upstreams (response_format=text) return the transcript as the body.
    const text = data === null
      ? rawText
      : typeof data === "object" && "text" in data && typeof data.text === "string" ? data.text : "";
    // Empty text stays an error so the audio is kept for playback and retry.
    return text.trim() ? { status: "done", text } : { status: "error", error: "No speech detected" };
  } catch (error) {
    const message = error instanceof DOMException && error.name === "TimeoutError"
      ? "Transcription timed out"
      : error instanceof Error ? error.message : String(error);
    return { status: "error", error: apiKey ? message.replaceAll(apiKey, "[REDACTED]") : message };
  }
}

function launch(config: SttConfig, job: SttJob, audio: File): void {
  const attempt = new AbortController();
  job.attempt = attempt;
  job.status = "pending";
  job.error = undefined;
  clearTimeout(job.expiry);
  void transcribe(config, audio, attempt.signal).then((result) => {
    // Closed meanwhile: the attempt was aborted and its answer is stale.
    if (attempt.signal.aborted) return;
    job.attempt = undefined;
    Object.assign(job, result);
    if (result.status === "done") job.doneAt = Date.now();
    expireIn(job, SETTLED_JOB_TTL_MS);
  });
}

function countLive(): { pending: number; live: number } {
  let pending = 0;
  let live = 0;
  for (const job of store.values()) {
    if (job.status === "pending") pending++;
    if (job.status !== "gone") live++;
  }
  return { pending, live };
}

/**
 * Drops the oldest tombstones beyond MAX_TOMBSTONES (Map order is insertion
 * order). Tombstones never count as live: counting them would turn an
 * upload/discard loop into a recording outage for GONE_JOB_TTL_MS.
 */
function pruneTombstones(): void {
  let tombstones = 0;
  for (const job of store.values()) if (job.status === "gone") tombstones++;
  for (const [id, job] of store) {
    if (tombstones <= MAX_TOMBSTONES) return;
    if (job.status !== "gone") continue;
    clearTimeout(job.expiry);
    store.delete(id);
    tombstones--;
  }
}

/** Starts a job; null when the pending or live job caps are reached. */
export function startSttJob(
  config: SttConfig,
  input: { audio: File; scope: string | null; owner: string | undefined; after: SttAfter | undefined },
): string | null {
  // The only entry point that adds to the store, so the only one a loop can grow.
  pruneTombstones();
  const { pending, live } = countLive();
  if (pending >= MAX_PENDING_JOBS || live >= MAX_LIVE_JOBS) return null;
  const job: SttJob = { id: randomUUID(), ...input, status: "pending" };
  store.set(job.id, job);
  launch(config, job, input.audio);
  return job.id;
}

/** Re-runs a failed job with its stored audio; the retrying browser becomes its owner. */
export function retrySttJob(config: SttConfig, id: string, owner: string | undefined): SttJobView | "busy" | null {
  const job = store.get(id);
  if (!job) return null;
  if (job.status !== "error" || !job.audio) return view(job);
  if (countLive().pending >= MAX_PENDING_JOBS) return "busy";
  job.owner = owner;
  launch(config, job, job.audio);
  return view(job);
}

export function getSttJob(id: string): SttJobView | null {
  const job = store.get(id);
  return job ? view(job) : null;
}

export function getSttJobAudio(id: string): File | null {
  return store.get(id)?.audio ?? null;
}

/** Jobs a browser showing this scope should pick up, newest first. */
export function listSttJobs(scope: string): SttJobView[] {
  return [...store.values()].filter((job) => job.scope === scope && job.status !== "gone").reverse().map(view);
}

/**
 * With a claim token, claims a finished job: only the first claim token gets
 * the text, so exactly one composer inserts it, and the same claim token may
 * repeat the claim if its response was lost. A claim token is per composer
 * instance; `ownerToken` is the tab's lasting identity (it survives remounts
 * but is copied into duplicated tabs, so it must never stand in for the claim
 * token). Only the owner may claim during OWNER_GRACE_MS, and only the owner
 * gets the send/queue `after` choice: another browser's composer holds its own
 * draft and attachments, so it just inserts the text.
 * A claim token on an unfinished job changes nothing. Without a claim token,
 * discards the job. Either way a closed job frees its audio, aborts its
 * upstream attempt, and answers "gone" afterwards.
 */
export function closeSttJob(id: string, claimToken?: string, ownerToken?: string): SttClaim | null {
  const job = store.get(id);
  if (!job) return null;
  if (job.status === "gone") {
    return claimToken && job.claimedBy === claimToken
      ? { id, status: "done", text: job.text, after: job.after }
      : view(job);
  }
  if (claimToken && job.status !== "done") return view(job);
  const isOwner = job.owner !== undefined && ownerToken === job.owner;
  // Not yet claimable by this browser: "done" without text means "ask again".
  if (claimToken && job.owner && !isOwner && Date.now() - (job.doneAt ?? 0) < OWNER_GRACE_MS) {
    return view(job);
  }
  // The tombstone keeps exactly what this claim delivered, for repeats.
  job.after = claimToken && isOwner ? job.after : undefined;
  const before: SttClaim = claimToken ? { ...view(job), text: job.text, after: job.after } : view(job);
  if (claimToken) job.claimedBy = claimToken;
  else job.text = undefined;
  job.attempt?.abort();
  job.attempt = undefined;
  job.status = "gone";
  job.error = undefined;
  job.audio = null;
  expireIn(job, GONE_JOB_TTL_MS);
  return before;
}
