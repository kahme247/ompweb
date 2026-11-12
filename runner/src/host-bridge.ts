/**
 * The session-side halves of host tools, host URI schemes, `/btw`, dictation and live voice, built on
 * omp's own engines (session tool registry, `InternalUrlRouter`, btw turns, `STTController`,
 * `LiveSessionController`) and speaking the channel's `{t}` frames directly. Frame shapes: see
 * `commands/tools.ts`.
 */
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import type { InternalResource, InternalUrl, ProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import { LiveSessionController } from "@oh-my-pi/pi-coding-agent/live/controller";
import { resolveLiveVoice } from "@oh-my-pi/pi-coding-agent/live/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	type BtwHistoryRecord,
	type BtwHistoryTurn,
	BtwHistoryConflictError,
	BtwHistoryStore,
	getBtwLatestTurn,
} from "@oh-my-pi/pi-coding-agent/session/btw-history";
import { beginBtwTurn, patchLatestBtwTurn, runBtwTurn } from "@oh-my-pi/pi-coding-agent/session/btw-turn";
import { STTController, type SttCallbacks, type SttTarget } from "@oh-my-pi/pi-coding-agent/stt/stt-controller";
import { isRecord, logger, Snowflake, toError } from "@oh-my-pi/pi-utils";
import type { CommandContext } from "./commands/types";

type Send = CommandContext["send"];

// ---------------------------------------------------------------------------------------------
// Requests omp makes of the host (host tool calls, host URI reads/writes)
// ---------------------------------------------------------------------------------------------

interface PendingRequest<T> {
	resolve(value: T): void;
	reject(error: Error): void;
	onUpdate?: AgentToolUpdateCallback<unknown>;
}

/** Frames sent under a fresh id that wait for the host's answer; an abort sends `{t: cancelType, targetId}`. */
class HostRequests<T> {
	readonly #send: Send;
	readonly #cancelType: string;
	readonly #pending = new Map<string, PendingRequest<T>>();
	#closed: Error | undefined;

	constructor(send: Send, cancelType: string) {
		this.#send = send;
		this.#cancelType = cancelType;
	}

	request(frame: { t: string } & Record<string, unknown>, abortMessage: string, signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback<unknown>): Promise<T> {
		if (signal?.aborted) return Promise.reject(new Error(abortMessage));
		if (this.#closed) return Promise.reject(this.#closed);
		const id: string = Snowflake.next();
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const onAbort = () => {
			if (!this.#pending.delete(id)) return;
			this.#send({ t: this.#cancelType, id: Snowflake.next(), targetId: id });
			reject(new Error(abortMessage));
		};
		const done = () => signal?.removeEventListener("abort", onAbort);
		signal?.addEventListener("abort", onAbort, { once: true });
		this.#pending.set(id, {
			resolve: value => {
				done();
				resolve(value);
			},
			reject: error => {
				done();
				reject(error);
			},
			onUpdate,
		});
		this.#send({ ...frame, id });
		return promise;
	}

	get(id: string): PendingRequest<T> | undefined {
		return this.#pending.get(id);
	}

	/** Removes and returns request `id` so the host's answer settles it once. */
	take(id: string): PendingRequest<T> | undefined {
		const pending = this.#pending.get(id);
		this.#pending.delete(id);
		return pending;
	}

	/** Fails every pending request; `forever` also fails later ones (their adapters outlive this host). */
	close(message: string, forever: boolean): void {
		let error = new Error(message);
		if (forever) error = this.#closed ??= error;
		const pending = [...this.#pending.values()];
		this.#pending.clear();
		for (const entry of pending) entry.reject(error);
	}
}

export interface HostToolDefinition {
	name: string;
	label: string;
	description: string;
	parameters: Record<string, unknown>;
	hidden: boolean;
	loadMode: ToolLoadMode;
	readsSkillUris?: boolean;
}

function isToolResult(value: unknown): value is AgentToolResult<unknown> {
	return isRecord(value) && Array.isArray(value.content);
}

export class HostToolBridge {
	readonly #calls: HostRequests<AgentToolResult<unknown>>;

	constructor(send: Send) {
		this.#calls = new HostRequests(send, "host_tool_cancel");
	}

	/** Session tools whose every call runs on the host as a `host_tool_call`. */
	tools(definitions: HostToolDefinition[]): AgentTool[] {
		return definitions.map(definition => ({
			...definition,
			strict: true,
			concurrency: "shared",
			execute: (toolCallId, params, signal, onUpdate) =>
				this.#calls.request(
					{ t: "host_tool_call", toolCallId, toolName: definition.name, arguments: params },
					`Host tool "${definition.name}" was aborted`,
					signal,
					onUpdate,
				),
		}));
	}

	result(frame: Record<string, unknown>): void {
		const { id, result, isError } = frame;
		if (typeof id !== "string" || !isToolResult(result)) throw new Error("host_tool_result: needs a string id and a result with content[]");
		const pending = this.#calls.take(id);
		if (!pending) return;
		if (isError !== true) return pending.resolve(result);
		const text = result.content
			.flatMap(item => (item.type === "text" && typeof item.text === "string" ? [item.text] : []))
			.join("\n")
			.trim();
		pending.reject(new Error(text || "Host tool execution failed"));
	}

	update(frame: Record<string, unknown>): void {
		const { id, partialResult } = frame;
		if (typeof id !== "string" || !isToolResult(partialResult)) throw new Error("host_tool_update: needs a string id and a partialResult with content[]");
		this.#calls.get(id)?.onUpdate?.(partialResult);
	}

	close(message: string): void {
		this.#calls.close(message, true);
	}
}

export interface HostUriSchemeDefinition {
	scheme: string;
	description?: string;
	writable: boolean;
	immutable: boolean;
}

type ContentType = InternalResource["contentType"];
const CONTENT_TYPES: Record<ContentType, true> = { "text/markdown": true, "application/json": true, "text/plain": true };

function isContentType(value: unknown): value is ContentType {
	return typeof value === "string" && Object.hasOwn(CONTENT_TYPES, value);
}

/** Lets the host own URI schemes: each is a handler in the process-wide router that asks the host. */
export class HostUriBridge {
	readonly #requests: HostRequests<Record<string, unknown>>;
	readonly #router = InternalUrlRouter.instance();
	#schemes = new Set<string>();

	constructor(send: Send) {
		this.#requests = new HostRequests(send, "host_uri_cancel");
	}

	/** Replaces the host's schemes; returns their normalized names. */
	setSchemes(definitions: HostUriSchemeDefinition[]): string[] {
		const normalized = new Map<string, HostUriSchemeDefinition>();
		for (const definition of definitions) {
			const scheme = definition.scheme.trim().toLowerCase();
			if (!scheme) throw new Error("Host URI scheme must be a non-empty string");
			if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) throw new Error(`Host URI scheme contains invalid characters: ${definition.scheme}`);
			// Built-in schemes are omp's: shadowing one changes it process-wide, and close() would delete it.
			if (this.#router.isBuiltin(scheme)) throw new Error(`Host URI scheme is reserved by OMP: ${scheme}://`);
			normalized.set(scheme, { ...definition, scheme });
		}
		for (const previous of this.#schemes) if (!normalized.has(previous)) this.#router.unregister(previous);
		for (const definition of normalized.values()) this.#router.register(this.#handler(definition));
		this.#schemes = new Set(normalized.keys());
		return [...this.#schemes];
	}

	result(frame: Record<string, unknown>): void {
		if (typeof frame.id !== "string") throw new Error("host_uri_result: needs a string id");
		this.#requests.take(frame.id)?.resolve(frame);
	}

	/** Takes the schemes out of the router and fails pending requests. */
	close(message: string): void {
		for (const scheme of this.#schemes) this.#router.unregister(scheme);
		this.#schemes.clear();
		this.#requests.close(message, false);
	}

	#handler({ scheme, writable, immutable }: HostUriSchemeDefinition): ProtocolHandler {
		return {
			scheme,
			spec: {
				backing: "remote",
				selectors: "none",
				immutable,
				write: writable ? { via: "handler", payload: "text", scope: "workspace", tier: () => "write" } : undefined,
			},
			resolve: async (url, context) => {
				const result = await this.#dispatch("read", url, undefined, context?.signal);
				const content = typeof result.content === "string" ? result.content : "";
				const notes = Array.isArray(result.notes) ? result.notes.filter(note => typeof note === "string") : [];
				return {
					url: url.href,
					content,
					contentType: isContentType(result.contentType) ? result.contentType : "text/plain",
					size: Buffer.byteLength(content, "utf-8"),
					notes: notes.length > 0 ? notes : undefined,
					immutable: typeof result.immutable === "boolean" ? result.immutable : immutable,
				};
			},
			write: writable
				? async (url, content, context) => {
						await this.#dispatch("write", url, content, context?.signal);
					}
				: undefined,
		};
	}

	async #dispatch(operation: "read" | "write", url: InternalUrl, content: string | undefined, signal: AbortSignal | undefined): Promise<Record<string, unknown>> {
		const frame: { t: string } & Record<string, unknown> = { t: "host_uri_request", operation, url: url.href };
		if (operation === "write") frame.content = content ?? "";
		const result = await this.#requests.request(frame, `Host URI ${operation} for ${url.href} was aborted`, signal);
		if (result.isError === true) {
			const reason = [result.error, result.content].find(value => typeof value === "string" && value);
			throw new Error(typeof reason === "string" ? reason : `Host URI ${operation} failed for ${url.href}`);
		}
		return result;
	}
}

// ---------------------------------------------------------------------------------------------
// `/btw` side questions
// ---------------------------------------------------------------------------------------------

interface RunningBtw {
	record: BtwHistoryRecord;
	store: BtwHistoryStore;
	abort: AbortController;
}

const CANCELLED_WHILE_STARTING = "The /btw question was cancelled before it started";

/** The TUI-only `title` heading stays off the wire; hosts head a topic by its question. */
function wireRecord({ title: _title, ...record }: BtwHistoryRecord): Omit<BtwHistoryRecord, "title"> {
	return record;
}

/**
 * One side question at a time against the main session, mirroring the TUI's `BtwController` without
 * its panels: answers stream as `btw_delta`, every turn is checkpointed into the session's BTW
 * history sidecar (shared with the TUI), and each lifecycle change sends a `btw_record` snapshot.
 */
export class BtwBridge {
	readonly #session: AgentSession;
	readonly #send: Send;
	#store: BtwHistoryStore | undefined;
	/** `sessionId \0 artifactsDir` the store was opened for. */
	#storeKey: string | undefined;
	#running: RunningBtw | undefined;
	/** Topic of the `btw` command between validation and its first checkpoint (`null`: a new topic). */
	#startingTopic: string | null | undefined;
	/** Bumped by every cancel and session change; a `btw` still starting from before gives up. */
	#epoch = 0;
	/** Terminal checkpoint writes still in flight. */
	readonly #writes = new Set<Promise<void>>();
	/** Terminal checkpoints that failed, keyed by record id (latest wins); retried before any move. */
	readonly #unsaved = new Map<string, RunningBtw>();

	constructor(session: AgentSession, send: Send) {
		this.#session = session;
		this.#send = send;
	}

	/** Starts a side question (or a follow-up in topic `recordId`); resolves once it is checkpointed as running. */
	async ask(question: string, recordId?: string): Promise<Omit<BtwHistoryRecord, "title">> {
		const trimmed = question.trim();
		if (!trimmed) throw new Error("btw requires a non-empty question");
		if (this.#startingTopic !== undefined || this.#running) throw new Error("A /btw question is still running; cancel it first");
		this.#startingTopic = recordId ?? null;
		const epoch = this.#epoch;
		try {
			await this.#settleWrites();
			const store = await this.#openStore(true);
			if (epoch !== this.#epoch) throw new Error(CANCELLED_WHILE_STARTING);
			const previous = recordId === undefined ? undefined : store.getRecords().find(r => r.id === recordId);
			if (recordId !== undefined && !previous) throw new Error(`Unknown /btw topic: ${recordId}`);
			if (!this.#session.model) throw new Error("No active model available for /btw.");
			const manager = this.#session.sessionManager;
			await manager.ensureOnDisk();
			if (epoch !== this.#epoch) throw new Error(CANCELLED_WHILE_STARTING);
			const { record, history, conversationKey } = beginBtwTurn(trimmed, manager.getLeafId(), previous);
			try {
				await store.upsert(record);
			} catch (error) {
				throw new Error(`Could not save /btw history: ${toError(error).message}`, { cause: error });
			}
			const running: RunningBtw = { record, store, abort: new AbortController() };
			this.#running = running;
			this.#send({ t: "btw_record", record: wireRecord(record) });
			if (epoch !== this.#epoch) {
				// Cancelled or the session changed while the first checkpoint was written.
				this.#finish(running, { status: "cancelled", updatedAt: Date.now() });
				throw new Error(CANCELLED_WHILE_STARTING);
			}
			// A macrotask: the `btw` result is written first, so it never trails this turn's frames.
			setTimeout(() => void this.#run(running, trimmed, history, conversationKey), 0);
			return wireRecord(record);
		} finally {
			this.#startingTopic = undefined;
		}
	}

	/** Cancels the running or starting question (only if it is topic `recordId`, when given). */
	cancel(recordId?: string): boolean {
		const running = this.#running;
		if (running) {
			if (recordId !== undefined && running.record.id !== recordId) return false;
			this.#epoch++;
			this.#finish(running, { status: "cancelled", updatedAt: Date.now() });
			running.abort.abort();
			return true;
		}
		const starting = this.#startingTopic;
		if (starting === undefined || (recordId !== undefined && starting !== recordId)) return false;
		this.#epoch++;
		return true;
	}

	/** Newest first, re-read from disk when idle; a running topic carries its live partial answer. */
	async history(): Promise<Omit<BtwHistoryRecord, "title">[]> {
		const store = await this.#openStore(this.#running === undefined && this.#startingTopic === undefined);
		const running = this.#running;
		const records = new Map(store.getRecords().map(record => [record.id, record]));
		for (const unsaved of this.#unsaved.values()) {
			if (unsaved.store === store) records.set(unsaved.record.id, unsaved.record);
		}
		if (running?.store === store) records.set(running.record.id, running.record);
		return [...records.values()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)).map(wireRecord);
	}

	/**
	 * Before the session is replaced or the process exits: cancels the running or starting question
	 * and lands every terminal checkpoint. Throws, after one retry, when a checkpoint still cannot be
	 * saved, so the caller keeps the session instead of losing that answer.
	 */
	async close(): Promise<void> {
		this.#epoch++;
		this.cancel();
		await this.#settleWrites();
	}

	/**
	 * Awaits terminal checkpoints, retrying failed ones once against their original revision. A retry
	 * that conflicts (the topic changed or was removed on disk) can never succeed: the record is
	 * reported lost and dropped instead of blocking every later session change.
	 */
	async #settleWrites(): Promise<void> {
		while (this.#writes.size > 0) await Promise.all(this.#writes);
		for (const [id, failed] of this.#unsaved) {
			try {
				await failed.store.retry(failed.record);
				this.#unsaved.delete(id);
			} catch (error) {
				if (error instanceof BtwHistoryConflictError) {
					this.#unsaved.delete(id);
					const message = `/btw answer ${id} was not saved: ${error.message}; it changed or was removed on disk`;
					logger.error(message);
					this.#send({ t: "notice", level: "error", message, source: "btw-history" });
					continue;
				}
				throw new Error(`/btw history could not be saved: ${toError(error).message}. Fix the storage and retry; unsaved answers remain in this session.`, {
					cause: error,
				});
			}
		}
	}

	/**
	 * The current session's store with every queued checkpoint landed. `fresh` re-reads a persisted
	 * store from disk, picking up topics another process (the TUI) wrote; callers pass it only while
	 * nothing runs here. A store whose write failed (already reported) is replaced by a fresh read.
	 */
	async #openStore(fresh: boolean): Promise<BtwHistoryStore> {
		const manager = this.#session.sessionManager;
		const artifactsDir = manager.getArtifactsDir() ?? undefined;
		const key = `${manager.getSessionId()}\0${artifactsDir ?? ""}`;
		const cached = this.#storeKey === key ? this.#store : undefined;
		if (cached) {
			try {
				await cached.flush();
				// Without an artifacts dir the store is the only copy: never drop it.
				if (!fresh || artifactsDir === undefined) return cached;
			} catch {
				// A failed checkpoint was already reported as a `notice`; re-read from disk below.
				if ([...this.#unsaved.values()].some(unsaved => unsaved.store === cached)) return cached;
			}
		} else if (this.#running) {
			// Replaced outside a host command (an extension switched sessions): the old session's
			// question must not keep streaming into this one's view.
			this.cancel();
		}
		const store = await BtwHistoryStore.open(artifactsDir);
		// A concurrent open for the same session already replaced the cache: keep one store.
		if (this.#storeKey === key && this.#store && this.#store !== cached) return this.#store;
		this.#store = store;
		this.#storeKey = key;
		return store;
	}

	async #run(running: RunningBtw, question: string, history: readonly BtwHistoryTurn[] | undefined, conversationKey: string): Promise<void> {
		if (this.#running !== running) return;
		try {
			const { replyText } = await runBtwTurn(this.#session, {
				question,
				history,
				conversationKey,
				signal: running.abort.signal,
				onTextDelta: delta => {
					if (this.#running !== running) return;
					const latest = getBtwLatestTurn(running.record);
					running.record = patchLatestBtwTurn(running.record, { answer: latest.answer + delta, updatedAt: Date.now() });
					this.#send({ t: "btw_delta", recordId: running.record.id, delta });
				},
			});
			this.#finish(running, { answer: replyText, status: "complete", updatedAt: Date.now() });
		} catch (error) {
			this.#finish(running, { status: "error", error: toError(error).message, updatedAt: Date.now() });
		}
	}

	/** Records the turn's terminal state once; later outcomes of the same turn are ignored. */
	#finish(running: RunningBtw, patch: Partial<BtwHistoryTurn>): void {
		if (this.#running !== running) return;
		this.#running = undefined;
		running.record = patchLatestBtwTurn(running.record, patch);
		this.#send({ t: "btw_record", record: wireRecord(running.record) });
		const write = running.store.upsert(running.record).then(
			() => {
				this.#unsaved.delete(running.record.id);
			},
			error => {
				this.#unsaved.set(running.record.id, running);
				const message = `Could not save /btw history: ${toError(error).message}`;
				logger.error(message);
				this.#send({ t: "notice", level: "error", message, source: "btw-history" });
			},
		);
		this.#writes.add(write);
		void write.finally(() => this.#writes.delete(write));
	}
}

// ---------------------------------------------------------------------------------------------
// Dictation: a draft-only microphone capture
// ---------------------------------------------------------------------------------------------

interface Capture {
	id: string;
	controller: STTController;
	committed: string;
	volatile: string;
	lastPreview: string;
	error?: string;
	stopping: boolean;
	ended: boolean;
	startDone: Promise<void>;
	stopPromise?: Promise<{ text: string }>;
}

export class DictationBridge {
	readonly #session: AgentSession;
	readonly #send: Send;
	#capture: Capture | undefined;
	#disposed = false;
	/** The latest `dictation_end` error, so a session change can tell an already-reported failure apart. */
	lastError: string | undefined;

	constructor(session: AgentSession, send: Send) {
		this.#session = session;
		this.#send = send;
	}

	get active(): boolean {
		return this.#capture !== undefined;
	}

	/** Resolves only when the microphone is recording; stopping a pending start cancels it. */
	async start(id: string): Promise<void> {
		if (id.length > 128 || !id.trim()) throw new Error("captureId must be a non-blank string of at most 128 characters");
		if (this.#disposed) throw new Error("Dictation is unavailable");
		if (this.#capture) throw new Error("A dictation capture is already active");
		const { promise: startDone, resolve: resolveStart } = Promise.withResolvers<void>();
		const session = this.#session;
		const capture: Capture = {
			id,
			controller: new STTController({ settings: session.settings, registry: session.modelRegistry, getSessionId: () => session.sessionId }),
			committed: "",
			volatile: "",
			lastPreview: "",
			stopping: false,
			ended: false,
			startDone,
		};
		this.#capture = capture;
		const preview = () => {
			if (capture.ended) return;
			const text = capture.committed + capture.volatile;
			if (text === capture.lastPreview) return;
			capture.lastPreview = text;
			this.#send({ t: "dictation_transcript", captureId: id, text });
		};
		const target: SttTarget = {
			setVolatileText: text => {
				if (capture.ended) return;
				capture.volatile = text;
				preview();
			},
			clearVolatileText: () => {
				if (capture.ended) return;
				capture.volatile = "";
				preview();
			},
			commitVolatileText: text => {
				if (capture.ended) return;
				capture.committed += text;
				capture.volatile = "";
				preview();
			},
			submit: () => {
				throw new Error("Dictation cannot submit a prompt");
			},
			deleteBeforeCursor: () => {
				throw new Error("Dictation cannot edit a prompt");
			},
		};
		const callbacks: SttCallbacks = {
			manualSubmit: true,
			showStatus: () => {},
			showWarning: message => {
				if (!capture.ended) capture.error = message;
			},
			onStateChange: state => {
				if (capture.ended) return;
				if (state === "idle") {
					// Capture errors report idle right before their warning: let both land before the one terminal frame.
					queueMicrotask(() => {
						if (!capture.stopping && !capture.ended) this.#finish(capture);
					});
				} else {
					this.#send({ t: "dictation_state", captureId: id, state });
				}
			},
		};
		this.#send({ t: "dictation_state", captureId: id, state: "starting" });
		try {
			if (!capture.stopping && !capture.ended) await capture.controller.start(target, callbacks);
			if (capture.stopping || this.#disposed) throw new Error("Dictation start cancelled");
			if (capture.ended || capture.controller.state !== "recording") throw new Error(capture.error || "Failed to start dictation");
		} catch (cause) {
			const error = toError(cause);
			if (!capture.stopping && !capture.ended) {
				capture.error ??= error.message;
				this.#finish(capture);
			}
			throw error;
		} finally {
			resolveStart();
		}
	}

	/** Stops the mic and flushes transcription, or returns empty text with no capture. */
	stop(): Promise<{ text: string }> {
		const capture = this.#capture;
		if (!capture) return Promise.resolve({ text: "" });
		if (capture.stopPromise) return capture.stopPromise;
		capture.stopping = true;
		capture.stopPromise = (async () => {
			try {
				// stop() cancels a pending preflight but returns before start settles; wait for that (and any flush) too.
				await capture.controller.stop();
				await capture.startDone;
				if (!capture.ended && capture.controller.state === "recording") await capture.controller.stop();
			} catch (cause) {
				capture.error ??= toError(cause).message;
			}
			const text = capture.committed + capture.volatile;
			this.#finish(capture);
			if (capture.error) throw new Error(capture.error);
			return { text };
		})();
		return capture.stopPromise;
	}

	/** Closes the microphone at once when the host goes away. */
	dispose(): void {
		this.#disposed = true;
		const capture = this.#capture;
		if (!capture) return;
		capture.stopping = true;
		this.#finish(capture);
	}

	#finish(capture: Capture): void {
		if (capture.ended) return;
		capture.ended = true;
		capture.controller.dispose();
		if (this.#capture === capture) this.#capture = undefined;
		if (capture.error) this.lastError = capture.error;
		this.#send({ t: "dictation_end", captureId: capture.id, text: capture.committed + capture.volatile, ...(capture.error ? { error: capture.error } : {}) });
	}
}

// ---------------------------------------------------------------------------------------------
// Live voice
// ---------------------------------------------------------------------------------------------

/** Minimum spacing between `live_levels` frames. */
const LIVE_LEVELS_INTERVAL_MS = 100;

/** Visible assistant text: text blocks only, no thinking or tool calls. */
function visibleAssistantText(message: AssistantMessage): string {
	let text = "";
	for (const content of message.content) if (content.type === "text") text += content.text;
	return text.trim();
}

/** At most one GPT live voice session, bound to the session so delegated work runs with the host's tools. */
export class LiveBridge {
	readonly #session: AgentSession;
	readonly #send: Send;
	/** Set from construction until the controller has fully stopped (connecting, active, closing). */
	#controller: LiveSessionController | undefined;
	#closing: Promise<void> | undefined;
	#pendingLevels: { input: number; output: number } | undefined;
	#levelsTimer: NodeJS.Timeout | undefined;
	#lastLevelsAt = Number.NEGATIVE_INFINITY;

	constructor(session: AgentSession, send: Send) {
		this.#session = session;
		this.#send = send;
	}

	get active(): boolean {
		return this.#controller !== undefined;
	}

	/** Resolves once recording (or, with `sdpOffer`, once the call is signaled, with its SDP answer). */
	async start(options: { voice?: string; instructions?: string; sdpOffer?: string }): Promise<{ voice: string; sdpAnswer?: string }> {
		if (this.#controller) throw new Error("A live session is already active");
		const voice = resolveLiveVoice(this.#session.settings, options.voice);
		let terminated = false;
		const controller = new LiveSessionController({
			session: this.#session,
			extractAssistantText: visibleAssistantText,
			voice,
			instructions: options.instructions,
			sdpOffer: options.sdpOffer,
			callbacks: {
				onPhase: phase => this.#send({ t: "live_phase", phase }),
				onLevels: (input, output) => {
					if (!terminated) this.#queueLevels(input, output);
				},
				onTranscript: transcript => {
					if (!transcript) return;
					this.#send({ t: "live_transcript", role: transcript.role, turn: transcript.turn, text: transcript.text, final: transcript.final });
				},
				onTerminal: error => {
					if (terminated) return;
					terminated = true;
					this.#flushLevels();
					this.#send(error ? { t: "live_end", error: error.message } : { t: "live_end" });
					void this.#retire(controller);
				},
			},
		});
		this.#controller = controller;
		try {
			await controller.start();
		} catch (cause) {
			await this.#retire(controller);
			throw toError(cause);
		}
		if (options.sdpOffer === undefined) return { voice };
		const sdpAnswer = controller.sdpAnswer;
		if (sdpAnswer === undefined) {
			await this.#retire(controller);
			throw new Error("The live session stopped before its SDP answer was available");
		}
		return { voice, sdpAnswer };
	}

	async stop(): Promise<void> {
		if (this.#controller) await this.#retire(this.#controller);
	}

	/** Sets (or toggles when omitted) microphone mute. */
	setMuted(muted?: boolean): { muted: boolean } {
		const controller = this.#controller;
		if (!controller || this.#closing) throw new Error("No live session is active");
		if (muted === undefined || muted !== controller.muted) controller.toggleMute();
		return { muted: controller.muted };
	}

	/** Stops `controller` and releases the slot once it has fully stopped. Idempotent. */
	#retire(controller: LiveSessionController): Promise<void> {
		if (this.#controller !== controller) return Promise.resolve();
		this.#closing ??= controller.stop().finally(() => {
			if (this.#controller !== controller) return;
			this.#controller = undefined;
			this.#closing = undefined;
			// Levels never follow `live_end`.
			clearTimeout(this.#levelsTimer);
			this.#levelsTimer = undefined;
			this.#pendingLevels = undefined;
		});
		return this.#closing;
	}

	#queueLevels(input: number, output: number): void {
		this.#pendingLevels = { input, output };
		if (this.#levelsTimer) return;
		const wait = this.#lastLevelsAt + LIVE_LEVELS_INTERVAL_MS - Date.now();
		if (wait <= 0) return this.#flushLevels();
		this.#levelsTimer = setTimeout(() => {
			this.#levelsTimer = undefined;
			this.#flushLevels();
		}, wait);
	}

	#flushLevels(): void {
		clearTimeout(this.#levelsTimer);
		this.#levelsTimer = undefined;
		const levels = this.#pendingLevels;
		if (!levels) return;
		this.#pendingLevels = undefined;
		this.#lastLevelsAt = Date.now();
		this.#send({ t: "live_levels", input: levels.input, output: levels.output });
	}
}
