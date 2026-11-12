/**
 * ompweb's outbox correlation (`clientMessageId`) on the pinned, unpatched omp.
 *
 * omp's own support is an unmerged branch (`fix/client-message-correlation`) that patches AgentSession and
 * SessionManager. This reproduces its wire contract from public API only:
 *
 * - Message identity. A queued prompt's message object comes from `onPromptQueued`; an idle prompt's is the first
 *   user-authored `message_start` after its `onPromptAdmitted` (input is serialized, so nothing else can start first).
 * - Events. {@link stampClientMessageId} adds `clientMessageId` to `message_start`/`message_end` and aligned
 *   `clientMessageIds` to `queue_update`. omp emits `queue_update` before `onPromptQueued` names the message, so
 *   {@link onClientQueueChange} hands the bridge the identity-only `queue_update` that follows.
 * - Journal. omp's entries cannot carry an extra field, so a `client-message-entry` custom entry
 *   `{clientMessageId, entryId}` names the message (or custom_message) entry a correlated message persisted as.
 *   Withdrawn or locally consumed IDs get the branch's own `client-message-resolution` entry. Both force the journal
 *   onto disk, as the branch does.
 *
 * Differences from the branch:
 * - Reuse is checked once, when the command arrives, against the session current then; the branch re-checks in the
 *   destination journal when a session change lands between acceptance and dispatch.
 * - A withdrawal is noticed when a queued message leaves every queue without reaching the transcript (checked after
 *   each `queue_update` and before a status read), not inside omp's removal paths. An abort that requeues and then
 *   records live-steered input in the same tick can be reported resolved instead of persisted; the transcript still
 *   shows the message.
 * - Message identity is in-process only (as on the branch), and a message that was delivered but never persisted
 *   (a session change dropped it) is simply unresolved.
 */
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { isUserAuthoredQueuedMessage } from "@oh-my-pi/pi-coding-agent/session/queued-messages";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { CommandTable } from "./commands/types";

type AgentMessage = AgentSession["messages"][number];

export const CLIENT_MESSAGE_ENTRY_CUSTOM_TYPE = "client-message-entry";
export const CLIENT_MESSAGE_RESOLUTION_CUSTOM_TYPE = "client-message-resolution";
/** The branch's v1 frame budget: native messages past it are omitted whole, and ompweb falls back to history. */
const STATUS_MAX_BYTES = 1024 * 1024;

export interface QueuedClientMessageIds {
	steering: (string | null)[];
	followUp: (string | null)[];
}

export interface ClientMessageStatus {
	messages: { clientMessageId: string; message: AgentMessage }[];
	queuedMessages: { steering: string[]; followUp: string[]; liveSteered: number; clientMessageIds?: QueuedClientMessageIds };
	resolvedClientMessageIds: string[];
	persistedClientMessageIds: string[];
	unresolvedClientMessageIds: string[];
}

/** Options to spread into `prompt`/`promptCustomMessage`/`steer`/`followUp`. */
export interface SubmitHooks {
	onPromptAdmitted?: () => void;
	onPromptQueued?: (queued: readonly AgentMessage[]) => void;
}

export function isClientMessageId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 128;
}

/** One submitted ID until it is journaled (persisted or resolved) or dropped. */
export class ClientMessageClaim {
	readonly id: string;
	readonly #owner: Correlation;
	admitted = false;
	message: AgentMessage | undefined;

	constructor(id: string, owner: Correlation) {
		this.id = id;
		this.#owner = owner;
	}

	hooks(onPromptAdmitted?: () => void): Required<SubmitHooks> {
		return {
			onPromptQueued: queued => {
				const message = queued.findLast(isUserAuthoredQueuedMessage);
				if (message && !this.message) this.#owner.map(this, message, true);
			},
			onPromptAdmitted: () => {
				this.admitted = true;
				if (!this.message) this.#owner.arm(this);
				onPromptAdmitted?.();
			},
		};
	}

	/** Consumed without reaching the agent (an input hook, empty text, a builtin): journaled as resolved. */
	consumed(): void {
		if (!this.message && this.#owner.drop(this)) this.#owner.resolve([this.id]);
	}

	/** Cancelled, dropped or failed before it reached the agent: the ID is free again. */
	release(): void {
		if (!this.message) this.#owner.drop(this);
	}
}

class Correlation {
	readonly #session: AgentSession;
	readonly ids = new WeakMap<AgentMessage, string>();
	readonly #claims = new Map<string, ClientMessageClaim>();
	readonly queueListeners = new Set<(event: AgentSessionEvent) => void>();
	#armed: ClientMessageClaim | undefined;
	#writes: Promise<void> = Promise.resolve();
	#sweepTimer: Timer | undefined;

	constructor(session: AgentSession) {
		this.#session = session;
		session.subscribe(event => {
			if (event.type === "message_start") this.idOf(event.message, true);
			else if (event.type === "message_end") this.#ended(event.message);
			else if (event.type === "queue_update") {
				clearTimeout(this.#sweepTimer);
				// After the mutation that emitted it settles: a held or dequeued message is briefly in neither place.
				this.#sweepTimer = setTimeout(() => this.#sweep(), 0);
			}
		});
	}

	claim(id: string): ClientMessageClaim {
		const journal = journalIds(this.#session);
		if (this.#claims.has(id) || journal.submitted.has(id)) throw new Error(`clientMessageId already submitted: ${id}`);
		if (journal.resolved.has(id)) throw new Error(`clientMessageId already resolved: ${id}`);
		const claim = new ClientMessageClaim(id, this);
		this.#claims.set(id, claim);
		return claim;
	}

	/** The ID of `message`; at its `message_start`, an armed idle prompt claims the first user-authored message. */
	idOf(message: AgentMessage, starting = false): string | undefined {
		const id = this.ids.get(message);
		if (id !== undefined || !starting || !this.#armed || !isUserAuthoredQueuedMessage(message)) return id;
		return this.map(this.#armed, message, false);
	}

	map(claim: ClientMessageClaim, message: AgentMessage, queued: boolean): string {
		claim.message = message;
		this.ids.set(message, claim.id);
		if (this.#armed === claim) this.#armed = undefined;
		if (queued && this.queueListeners.size > 0) {
			const event = queueUpdate(this.#session);
			for (const listener of this.queueListeners) listener(event);
		}
		return claim.id;
	}

	arm(claim: ClientMessageClaim): void {
		this.#armed = claim;
	}

	drop(claim: ClientMessageClaim): boolean {
		if (this.#armed === claim) this.#armed = undefined;
		return this.#claims.get(claim.id) === claim && this.#claims.delete(claim.id);
	}

	resolve(ids: string[]): void {
		if (ids.length === 0) return;
		this.#write(() => this.#session.sessionManager.appendCustomEntry(CLIENT_MESSAGE_RESOLUTION_CUSTOM_TYPE, { clientMessageIds: ids }));
	}

	#ended(message: AgentMessage): void {
		const id = this.ids.get(message);
		const claim = id === undefined ? undefined : this.#claims.get(id);
		if (claim?.message !== message) return;
		this.#write(async () => {
			// omp persists message_end on its own queue; the entry exists once that settles.
			await this.#session.settleInFlightMessagePersistence();
			if (this.#claims.get(claim.id) !== claim) return;
			this.#claims.delete(claim.id);
			const entryId = persistedEntryId(this.#session, message);
			if (entryId) {
				this.#session.sessionManager.appendCustomEntry(CLIENT_MESSAGE_ENTRY_CUSTOM_TYPE, { clientMessageId: claim.id, entryId });
			}
		});
	}

	/** Queued messages that left every queue without reaching the transcript were withdrawn. */
	#sweep(): void {
		const session = this.#session;
		const { agent } = session;
		const pending = new Set([
			...agent.peekSteeringQueue(),
			...agent.peekFollowUpQueue(),
			...agent.peekUndeliveredQueuedMessages(),
			...session.heldQueuedMessages,
		]);
		const withdrawn: string[] = [];
		for (const claim of this.#claims.values()) {
			const message = claim.message;
			if (!message || pending.has(message) || session.messages.includes(message)) continue;
			this.#claims.delete(claim.id);
			withdrawn.push(claim.id);
		}
		this.resolve(withdrawn);
	}

	#write(work: () => unknown): void {
		this.#writes = this.#writes
			.then(async () => {
				await work();
				// Correlated acceptance must survive a reconnect before the first assistant reply.
				await this.#session.sessionManager.ensureOnDisk();
			})
			.catch((error: unknown) => logger.warn("ompweb: client message journal write failed", { error: String(error) }));
	}

	async status(ids: string[], maxBytes: number): Promise<ClientMessageStatus> {
		const session = this.#session;
		const manager = session.sessionManager;
		const journalId = manager.getSessionId();
		await session.settleInFlightMessagePersistence();
		await this.#writes;
		clearTimeout(this.#sweepTimer);
		this.#sweep();
		await this.#writes;
		// Only entries journaled before this flush are confirmed by it.
		const journal = journalIds(session);
		const persisted = ids.filter(id => journal.submitted.has(id));
		const resolved = ids.filter(id => journal.resolved.has(id));
		await manager.flush();
		if (manager.getSessionId() !== journalId) throw new Error("Session changed during client message reconciliation");

		const requested = new Set(ids);
		const candidates: ClientMessageStatus["messages"] = [];
		for (const message of session.messages) {
			const id = this.ids.get(message);
			if (id !== undefined && requested.has(id)) candidates.push({ clientMessageId: id, message });
		}
		const queue = queueUpdate(session);
		const queuedMessages: ClientMessageStatus["queuedMessages"] = {
			steering: queue.steering,
			followUp: queue.followUp,
			liveSteered: queue.liveSteered,
			...(queue.clientMessageIds ? { clientMessageIds: queue.clientMessageIds } : {}),
		};
		const queued = new Set([...(queue.clientMessageIds?.steering ?? []), ...(queue.clientMessageIds?.followUp ?? [])]);
		const build = (messages: ClientMessageStatus["messages"]): ClientMessageStatus => {
			const represented = new Set([...queued, ...persisted, ...resolved, ...messages.map(m => m.clientMessageId)]);
			return {
				messages,
				queuedMessages,
				resolvedClientMessageIds: resolved,
				persistedClientMessageIds: persisted,
				unresolvedClientMessageIds: ids.filter(id => !represented.has(id)),
			};
		};
		// Measured with no messages, the unresolved list is at its longest; each message added only shortens it.
		// shortcut: queue chip texts are never blanked to fit, unlike the branch; add that if huge chips appear.
		let remaining = maxBytes - Buffer.byteLength(JSON.stringify(build([])), "utf8");
		const messages: ClientMessageStatus["messages"] = [];
		for (const envelope of candidates) {
			const bytes = Buffer.byteLength(JSON.stringify(envelope), "utf8") + 1;
			if (bytes > remaining) continue;
			remaining -= bytes;
			messages.push(envelope);
		}
		return build(messages);
	}
}

const states = new WeakMap<AgentSession, Correlation>();

function correlation(session: AgentSession): Correlation {
	let state = states.get(session);
	if (!state) {
		state = new Correlation(session);
		states.set(session, state);
	}
	return state;
}

/** IDs the journal already holds: persisted (`client-message-entry`) and resolved. */
function journalIds(session: AgentSession): { submitted: Set<string>; resolved: Set<string> } {
	const submitted = new Set<string>();
	const resolved = new Set<string>();
	for (const entry of session.sessionManager.getEntries()) {
		if (entry.type !== "custom" || !isRecord(entry.data)) continue;
		if (entry.customType === CLIENT_MESSAGE_ENTRY_CUSTOM_TYPE && isClientMessageId(entry.data.clientMessageId)) {
			submitted.add(entry.data.clientMessageId);
		} else if (entry.customType === CLIENT_MESSAGE_RESOLUTION_CUSTOM_TYPE && Array.isArray(entry.data.clientMessageIds)) {
			for (const id of entry.data.clientMessageIds) if (isClientMessageId(id)) resolved.add(id);
		}
	}
	return { submitted, resolved };
}

/** The entry omp persisted `message` as: the same object for a message entry, customType + timestamp for a custom one. */
function persistedEntryId(session: AgentSession, message: AgentMessage): string | undefined {
	const branch = session.sessionManager.getBranchView();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "message" && entry.message === message) return entry.id;
		if (
			message.role === "custom" &&
			entry.type === "custom_message" &&
			entry.customType === message.customType &&
			Date.parse(entry.timestamp) === message.timestamp
		) {
			return entry.id;
		}
	}
	return undefined;
}

/** Queue IDs aligned with `getQueuedMessages()` slots (legacy slots `null`); undefined when none is correlated. */
export function queuedClientMessageIds(session: AgentSession): QueuedClientMessageIds | undefined {
	const state = states.get(session);
	if (!state) return undefined;
	const { agent } = session;
	const steering = [...agent.peekLiveSteeredMessages(), ...agent.peekSteeringQueue()].filter(isUserAuthoredQueuedMessage);
	const followUp = agent.peekFollowUpQueue().filter(isUserAuthoredQueuedMessage);
	const ids = {
		steering: steering.map(message => state.ids.get(message) ?? null),
		followUp: followUp.map(message => state.ids.get(message) ?? null),
	};
	return [...ids.steering, ...ids.followUp].some(id => id !== null) ? ids : undefined;
}

function queueUpdate(session: AgentSession) {
	const queue = session.getQueuedMessages();
	const clientMessageIds = queuedClientMessageIds(session);
	return {
		type: "queue_update" as const,
		steering: [...queue.steering],
		followUp: [...queue.followUp],
		liveSteered: queue.liveSteered,
		...(clientMessageIds ? { clientMessageIds } : {}),
	};
}

/**
 * Reserve a command's `clientMessageId` when it arrives; undefined when it has none.
 * @throws when the ID is invalid or already submitted, persisted or resolved in this session
 */
export function claimClientMessage(session: AgentSession, value: unknown): ClientMessageClaim | undefined {
	if (value === undefined) return undefined;
	if (!isClientMessageId(value)) throw new Error("clientMessageId must be a nonempty string of at most 128 characters");
	return correlation(session).claim(value);
}

/**
 * Run one submission with `claim`'s hooks (just `onPromptAdmitted` without a claim). Afterwards an input that never
 * reached a message is released, or, with `localWhenFalse` (`session.prompt`'s "handled locally"), resolved when the
 * call admitted it and returned `false`.
 */
export async function submitCorrelated<T>(
	claim: ClientMessageClaim | undefined,
	onPromptAdmitted: (() => void) | undefined,
	submit: (hooks: SubmitHooks) => Promise<T>,
	localWhenFalse = false,
): Promise<T> {
	if (!claim) return submit({ onPromptAdmitted });
	try {
		const result = await submit(claim.hooks(onPromptAdmitted));
		if (result === false && localWhenFalse && claim.admitted) claim.consumed();
		else claim.release();
		return result;
	} catch (error) {
		claim.release();
		throw error;
	}
}

/** Stamp correlation onto a session event before it is forwarded; call synchronously in the subscriber. */
export function stampClientMessageId(session: AgentSession, event: AgentSessionEvent): AgentSessionEvent {
	const state = states.get(session);
	if (!state) return event;
	if (event.type === "message_start" || event.type === "message_end") {
		const id = state.idOf(event.message, event.type === "message_start");
		if (id === undefined) return event;
		const stamped = { ...event, clientMessageId: id };
		return stamped;
	}
	if (event.type === "queue_update") {
		const clientMessageIds = queuedClientMessageIds(session);
		if (!clientMessageIds) return event;
		const stamped = { ...event, clientMessageIds };
		return stamped;
	}
	return event;
}

/** The identity-only `queue_update` omp does not emit: `listener` gets it, already stamped, after a correlated enqueue. */
export function onClientQueueChange(session: AgentSession, listener: (event: AgentSessionEvent) => void): () => void {
	const state = correlation(session);
	state.queueListeners.add(listener);
	return () => state.queueListeners.delete(listener);
}

export async function getClientMessageStatus(
	session: AgentSession,
	value: unknown,
	maxBytes = STATUS_MAX_BYTES,
): Promise<ClientMessageStatus> {
	if (!Array.isArray(value) || value.length === 0 || value.length > 32 || !value.every(isClientMessageId)) {
		throw new Error("clientMessageIds must contain between 1 and 32 unique IDs");
	}
	if (new Set(value).size !== value.length) throw new Error("clientMessageIds must be unique");
	return correlation(session).status(value, maxBytes);
}

export const correlationCommands: CommandTable = {
	async get_client_message_status({ session }, args) {
		return getClientMessageStatus(session, args.clientMessageIds);
	},
};
