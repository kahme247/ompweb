/**
 * Subagents and provider login.
 *
 * Unsolicited frames omp sends:
 *   omp → host  {t:"subagent_lifecycle", payload}   a subagent started or settled (subscription "progress" or "events")
 *   omp → host  {t:"subagent_progress", payload}    a subagent's progress (subscription "progress" or "events")
 *   omp → host  {t:"subagent_event", payload}       one subagent session event (subscription "events")
 *   omp → host  {t:"login_open_url", url, launchUrl?, instructions?}   open the provider's sign-in page
 *   omp → host  {t:"login_progress", message}       a login status line
 *   omp → host  {t:"login_input", id, prompt, placeholder?, secret}    ask the user for a value (secret: mask it)
 *   omp → host  {t:"login_input_end", id}           close that prompt: it timed out or the login ended first
 *
 * Host frames:
 *   host → omp  {t:"login_input_response", id, value}   value: string, or null/absent for cancelled
 */
import * as fs from "node:fs/promises";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import type { FileEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { listLogoutAccounts, logoutCredential } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/logout";
import {
	type SubagentEventPayload,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { CommandContext, CommandTable, FrameTable } from "./types";

const LOGIN_INPUT_TIMEOUT_MS = 600_000;
/** Settled subagents whose transcript stays readable, and ids remembered from a previous session. */
const MAX_RETAINED_SUBAGENTS = 256;

type SubscriptionLevel = "off" | "progress" | "events";
type Progress = SubagentProgressPayload["progress"];

/** A `get_subagents` row. */
interface SubagentSnapshot {
	id: string;
	index: number;
	agent: string;
	agentSource: Progress["agentSource"];
	description?: string;
	status: Progress["status"];
	task?: string;
	assignment?: string;
	sessionFile?: string;
	lastUpdate: number;
	progress?: Progress;
	parentToolCallId?: string;
}

function prune(keys: Set<string> | Map<string, string>): void {
	for (const key of keys.keys()) {
		if (keys.size <= MAX_RETAINED_SUBAGENTS) return;
		keys.delete(key);
	}
}

/** Agent ids repeat across parent sessions, so a frame only updates the row of the same spawn. */
function sameOwner(payload: SubagentLifecyclePayload | SubagentProgressPayload, row: SubagentSnapshot): boolean {
	if (payload.parentToolCallId !== undefined && row.parentToolCallId !== undefined) {
		return payload.parentToolCallId === row.parentToolCallId;
	}
	if (payload.sessionFile !== undefined && row.sessionFile !== undefined) return payload.sessionFile === row.sessionFile;
	return true;
}

/** The running subagents of one session, as the task tool reports them on the event bus. */
class Roster {
	readonly #running = new Map<string, SubagentSnapshot>();
	/** Transcript file per subagent id, kept after it settles. */
	readonly #transcripts = new Map<string, string>();
	/** Ids from a previous session: their late events must not reach the host. */
	readonly #stale = new Set<string>();
	readonly #unsubscribe: Array<() => void>;
	readonly #send: CommandContext["send"];
	level: SubscriptionLevel = "off";
	/** A new/switched/forked session starts an empty roster. */
	sessionId: string;

	constructor(ctx: CommandContext, bus: EventBus) {
		this.#send = ctx.send;
		this.sessionId = ctx.session.sessionId;
		this.#unsubscribe = [
			bus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => this.#lifecycle(data as SubagentLifecyclePayload)),
			bus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => this.#progress(data as SubagentProgressPayload)),
			bus.on(TASK_SUBAGENT_EVENT_CHANNEL, data => this.#event(data as SubagentEventPayload)),
		];
	}

	dispose(): void {
		for (const unsubscribe of this.#unsubscribe) unsubscribe();
	}

	clear(): void {
		for (const id of [...this.#running.keys(), ...this.#transcripts.keys()]) {
			this.#stale.delete(id);
			this.#stale.add(id);
		}
		prune(this.#stale);
		this.#running.clear();
		this.#transcripts.clear();
	}

	list(): SubagentSnapshot[] {
		return [...this.#running.values()].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
	}

	transcriptFile(subagentId: string | undefined, sessionFile: string | undefined): string {
		if (subagentId) {
			const file = this.#running.get(subagentId)?.sessionFile ?? this.#transcripts.get(subagentId);
			if (!file) throw new Error(`Unknown subagent or session file unavailable: ${subagentId}`);
			return file;
		}
		if (!sessionFile) throw new Error("get_subagent_messages requires subagentId or sessionFile");
		// Only transcripts of this session's subagents: the host must not read arbitrary files.
		if ([...this.#transcripts.values()].includes(sessionFile) || this.list().some(row => row.sessionFile === sessionFile)) {
			return sessionFile;
		}
		throw new Error("Unknown subagent session file");
	}

	/**
	 * The live registry ref of a running subagent in this roster, or undefined when the host must not reach it
	 * (unknown, finished, accepted, parked, aborted, or another session's agent). The process-global registry keeps
	 * the latest ref per id, so it must carry this roster's transcript file; and it goes `idle` once the parent
	 * accepts the result, before the terminal lifecycle frame prunes the roster.
	 */
	owned(subagentId: string) {
		const row = this.#running.get(subagentId);
		// Progress can report a terminal status just before the terminal lifecycle frame.
		if ((row?.status !== "running" && row?.status !== "pending") || !row.sessionFile) return undefined;
		const ref = AgentRegistry.global().get(subagentId);
		if (ref?.kind !== "sub" || ref.status !== "running" || !ref.session || ref.sessionFile !== row.sessionFile) {
			return undefined;
		}
		return { ref, session: ref.session };
	}

	#remember(id: string, sessionFile: string | undefined): void {
		if (!sessionFile) return;
		this.#transcripts.delete(id);
		this.#transcripts.set(id, sessionFile);
		prune(this.#transcripts);
	}

	#lifecycle(payload: SubagentLifecyclePayload): void {
		const existing = this.#running.get(payload.id);
		if (existing ? !sameOwner(payload, existing) : payload.status !== "started") return;
		const sessionFile = payload.sessionFile ?? existing?.sessionFile;
		this.#remember(payload.id, sessionFile);
		if (payload.status === "started") {
			this.#stale.delete(payload.id);
			this.#running.set(payload.id, {
				...existing,
				id: payload.id,
				index: payload.index,
				agent: payload.agent,
				agentSource: payload.agentSource,
				description: payload.description ?? existing?.description,
				status: "running",
				sessionFile,
				parentToolCallId: payload.parentToolCallId ?? existing?.parentToolCallId,
				lastUpdate: Date.now(),
			});
		} else {
			this.#running.delete(payload.id);
		}
		if (this.level !== "off") this.#send({ t: "subagent_lifecycle", payload });
	}

	#progress(payload: SubagentProgressPayload): void {
		const { progress } = payload;
		const existing = this.#running.get(progress.id);
		if (!existing || !sameOwner(payload, existing)) return;
		const sessionFile = payload.sessionFile ?? existing.sessionFile;
		this.#remember(progress.id, sessionFile);
		this.#running.set(progress.id, {
			id: progress.id,
			index: payload.index,
			agent: payload.agent,
			agentSource: payload.agentSource,
			description: progress.description ?? existing.description,
			status: progress.status,
			task: payload.task,
			assignment: payload.assignment,
			sessionFile,
			lastUpdate: Date.now(),
			parentToolCallId: payload.parentToolCallId ?? existing.parentToolCallId,
			progress,
		});
		if (this.level !== "off") this.#send({ t: "subagent_progress", payload });
	}

	#event(payload: SubagentEventPayload): void {
		if (this.level === "events" && !this.#stale.has(payload.id)) this.#send({ t: "subagent_event", payload });
	}
}

/** Complete transcript lines from `fromByte` on; a `fromByte` past the end (file rewritten) restarts at 0. */
async function readTranscript(sessionFile: string, fromByte = 0) {
	let start = Number.isFinite(fromByte) ? Math.max(0, Math.trunc(fromByte)) : 0;
	let size: number;
	try {
		({ size } = await fs.stat(sessionFile));
	} catch (err) {
		if (!isEnoent(err)) throw err;
		return { sessionFile, fromByte: start, nextByte: start, reset: false, entries: [], messages: [] };
	}
	const reset = start > size;
	if (reset) start = 0;
	const text = start >= size ? "" : await Bun.file(sessionFile).slice(start).text();
	const complete = text.slice(0, text.lastIndexOf("\n") + 1);
	const entries: FileEntry[] = complete ? parseSessionEntries(complete) : [];
	return {
		sessionFile,
		fromByte: start,
		nextByte: start + Buffer.byteLength(complete, "utf8"),
		reset,
		entries,
		messages: entries.filter((entry): entry is SessionMessageEntry => entry.type === "message").map(entry => entry.message),
	};
}

const rosters = new WeakMap<AgentSession, Roster>();
const pendingInputs = new Map<number, (value: string) => void>();
let nextInputId = 1;

/**
 * Track `session`'s subagents from now on and forward the subscribed frames to the host. Call once
 * when the channel connects: the roster only knows subagents whose lifecycle it saw.
 */
export function watchSubagents(ctx: CommandContext, bus: EventBus): () => void {
	const roster = new Roster(ctx, bus);
	rosters.set(ctx.session, roster);
	return () => {
		roster.dispose();
		rosters.delete(ctx.session);
	};
}

function subagents(session: AgentSession, op: string): Roster {
	const roster = rosters.get(session);
	if (!roster) throw new Error(`${op}: Subagent event bus is unavailable`);
	if (roster.sessionId !== session.sessionId) {
		roster.clear();
		roster.sessionId = session.sessionId;
	}
	return roster;
}

function subagentId(op: string, args: Record<string, unknown>): string {
	if (typeof args.subagentId !== "string" || args.subagentId.length === 0) {
		throw new Error(`${op}: subagentId must be a non-empty string`);
	}
	return args.subagentId;
}

function isSubscriptionLevel(value: unknown): value is SubscriptionLevel {
	return value === "off" || value === "progress" || value === "events";
}

/** Close an open host prompt, answering it with "" as a cancelled input. */
function endInput(ctx: CommandContext, id: number): void {
	const resolve = pendingInputs.get(id);
	if (!resolve) return;
	pendingInputs.delete(id);
	ctx.send({ t: "login_input_end", id });
	resolve("");
}

/** Ask the host for a value; resolves "" when cancelled or unanswered, like RPC's input dialog. */
function askHost(ctx: CommandContext, open: Set<number>, prompt: string, placeholder: string | undefined, secret: boolean): Promise<string> {
	const id = nextInputId++;
	const { promise, resolve } = Promise.withResolvers<string>();
	const timer = setTimeout(() => endInput(ctx, id), LOGIN_INPUT_TIMEOUT_MS);
	pendingInputs.set(id, resolve);
	open.add(id);
	ctx.send({ t: "login_input", id, prompt, placeholder, secret });
	return promise.finally(() => {
		clearTimeout(timer);
		pendingInputs.delete(id);
		open.delete(id);
	});
}

export const agentsCommands: CommandTable = {
	get_subagents: async ({ session }) => ({ subagents: subagents(session, "get_subagents").list() }),

	get_subagent_messages: async ({ session }, args) => {
		const roster = subagents(session, "get_subagent_messages");
		const { subagentId, sessionFile, fromByte } = args;
		if (subagentId !== undefined && typeof subagentId !== "string") {
			throw new Error("get_subagent_messages: subagentId must be a string");
		}
		if (sessionFile !== undefined && typeof sessionFile !== "string") {
			throw new Error("get_subagent_messages: sessionFile must be a string");
		}
		if (fromByte !== undefined && (typeof fromByte !== "number" || !Number.isFinite(fromByte))) {
			throw new Error("get_subagent_messages: fromByte must be a finite number");
		}
		return readTranscript(roster.transcriptFile(subagentId, sessionFile), fromByte);
	},

	set_subagent_subscription: async ({ session }, args) => {
		const roster = subagents(session, "set_subagent_subscription");
		if (!isSubscriptionLevel(args.level)) {
			throw new Error(`set_subagent_subscription: invalid level ${String(args.level)}`);
		}
		roster.level = args.level;
		return { level: roster.level };
	},

	/** Hard-kill a running subagent, as the Agent Hub `kill` does; `cancelled:false` when it is already gone. */
	cancel_subagent: async ({ session }, args) => {
		const id = subagentId("cancel_subagent", args);
		const owned = subagents(session, "cancel_subagent").owned(id);
		if (!owned) return { cancelled: false };
		// Release first: its synchronous `aborted` tombstone keeps the executor from accepting the result mid-abort.
		const [released, aborted] = await Promise.allSettled([
			AgentLifecycleManager.global().release(id, owned.ref, { tombstone: true }),
			owned.session.abort({ reason: USER_INTERRUPT_LABEL }),
		]);
		if (released.status === "rejected") throw released.reason;
		if (aborted.status === "rejected") throw aborted.reason;
		return { cancelled: released.value };
	},

	/** Send a message to a running subagent as its user (Agent Hub chat); resolves once the subagent accepts it. */
	steer_subagent: async ({ session }, args) => {
		const roster = subagents(session, "steer_subagent");
		const id = subagentId("steer_subagent", args);
		const { message } = args;
		if (typeof message !== "string" || !message.trim()) throw new Error("steer_subagent: message is required");
		const notRunning = `steer_subagent: subagent not running: ${id}`;
		const owned = roster.owned(id);
		if (!owned) throw new Error(notRunning);
		let live: AgentSessionHandle;
		try {
			live = await AgentLifecycleManager.global().ensureLive(id);
		} catch {
			throw new Error(notRunning);
		}
		// ensureLive awaits: the id may now name another agent, or the subagent may have finished.
		const current = roster.owned(id);
		if (current?.ref !== owned.ref || current.session !== live) throw new Error(notRunning);

		const accepted = Promise.withResolvers<void>();
		const unsubscribe = live.subscribe(event => {
			if (event.type === "agent_start") accepted.resolve();
		});
		live.prompt(message, { streamingBehavior: "steer", throwOnDrop: true }).then(
			() => accepted.resolve(),
			(err: unknown) => {
				accepted.reject(err);
				logger.warn("steer_subagent message failed", { subagentId: id, error: String(err) });
			},
		);
		try {
			await accepted.promise;
		} catch (err) {
			throw new Error(`steer_subagent: subagent refused the message: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			unsubscribe();
		}
	},

	get_login_providers: async ({ session }) => ({
		providers: getOAuthProviders().map(provider => ({
			id: provider.id,
			name: provider.name,
			available: provider.available,
			authenticated: session.modelRegistry.authStorage.keys.source(provider.storeCredentialsAs ?? provider.id) !== undefined,
		})),
	}),

	login: async (ctx, args) => {
		const { session } = ctx;
		const { providerId } = args;
		if (typeof providerId !== "string") throw new Error("login: providerId must be a string");
		const provider = getOAuthProviders().find(p => p.id === providerId);
		if (!provider) throw new Error(`login: unknown OAuth provider: ${providerId}`);
		// The host is a UI, so unlike RPC it answers secret prompts and prompts before the sign-in URL.
		const open = new Set<number>();
		try {
			await session.modelRegistry.authStorage.oauth.login(providerId, {
				onAuth: info =>
					ctx.send({ t: "login_open_url", url: info.url, launchUrl: info.launchUrl, instructions: info.instructions }),
				onProgress: message => ctx.send({ t: "login_progress", message }),
				onPrompt: prompt => askHost(ctx, open, prompt.message, prompt.placeholder, prompt.secret === true),
			});
		} finally {
			for (const id of open) endInput(ctx, id);
		}
		// Online refresh so the new credential re-runs discovery instead of reusing a fresh cache row.
		await session.modelRegistry.refreshProvider(provider.storeCredentialsAs ?? provider.id, "online");
		await session.refreshScopedModels();
		return { providerId };
	},

	get_logout_accounts: async ({ session }, args) => {
		// An absent provider would list every provider's credentials.
		if (typeof args.providerId !== "string") throw new Error("get_logout_accounts: providerId must be a string");
		return {
			accounts: await listLogoutAccounts(session.modelRegistry.authStorage, args.providerId, session.sessionId),
		};
	},

	logout: async ({ session }, args) => {
		const { providerId, credentialId } = args;
		if (typeof providerId !== "string" || typeof credentialId !== "number" || !Number.isInteger(credentialId)) {
			throw new Error("logout: providerId must be a string and credentialId an integer");
		}
		const { removed, remainingSource } = await logoutCredential(session, providerId, credentialId);
		if (!removed) throw new Error(`logout: credential ${credentialId} is not stored for ${providerId}`);
		return { remainingSource };
	},
};

export const agentsFrames: FrameTable = {
	login_input_response: (_ctx, frame) => {
		const { id, value } = frame;
		if (typeof id !== "number") throw new Error("login_input_response: id must be a number");
		if (value !== undefined && value !== null && typeof value !== "string") {
			throw new Error("login_input_response: value must be a string");
		}
		pendingInputs.get(id)?.(value ?? "");
	},
};
