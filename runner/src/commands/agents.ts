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
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	RpcSubagentRegistry,
	readRpcSubagentTranscript,
	resolveOwnedLiveSubagent,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import type { RpcSubagentSubscriptionLevel } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { listLogoutAccounts, logoutCredential } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/logout";
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { logger } from "@oh-my-pi/pi-utils";
import type { CommandContext, CommandTable, FrameTable } from "./types";

const LOGIN_INPUT_TIMEOUT_MS = 600_000;

interface Roster {
	registry: RpcSubagentRegistry;
	/** The session the roster belongs to; a new/switched/forked session starts an empty roster, as RPC does. */
	sessionId: string;
}

const rosters = new WeakMap<AgentSession, Roster>();
const pendingInputs = new Map<number, (value: string) => void>();
let nextInputId = 1;

/**
 * Track `session`'s subagents from now on and forward the subscribed frames to the host. Call once
 * when the channel connects: the roster only knows subagents whose lifecycle it saw.
 */
export function watchSubagents(ctx: CommandContext, bus: EventBus): () => void {
	const registry = new RpcSubagentRegistry(bus, frame => ctx.send({ t: frame.type, payload: frame.payload }));
	rosters.set(ctx.session, { registry, sessionId: ctx.session.sessionId });
	return () => {
		registry.dispose();
		rosters.delete(ctx.session);
	};
}

function subagents(session: AgentSession, op: string): RpcSubagentRegistry {
	const roster = rosters.get(session);
	if (!roster) throw new Error(`${op}: Subagent event bus is unavailable`);
	if (roster.sessionId !== session.sessionId) {
		roster.registry.clear();
		roster.sessionId = session.sessionId;
	}
	return roster.registry;
}

function subagentId(op: string, args: Record<string, unknown>): string {
	if (typeof args.subagentId !== "string" || args.subagentId.length === 0) {
		throw new Error(`${op}: subagentId must be a non-empty string`);
	}
	return args.subagentId;
}

function isSubscriptionLevel(value: unknown): value is RpcSubagentSubscriptionLevel {
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
	get_subagents: async ({ session }) => ({ subagents: subagents(session, "get_subagents").getSubagents() }),

	get_subagent_messages: async ({ session }, args) => {
		const registry = subagents(session, "get_subagent_messages");
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
		return readRpcSubagentTranscript(registry.resolveSessionFile({ subagentId, sessionFile }), fromByte);
	},

	set_subagent_subscription: async ({ session }, args) => {
		const registry = subagents(session, "set_subagent_subscription");
		if (!isSubscriptionLevel(args.level)) {
			throw new Error(`set_subagent_subscription: invalid level ${String(args.level)}`);
		}
		registry.setSubscriptionLevel(args.level);
		return { level: registry.getSubscriptionLevel() };
	},

	/** Hard-kill a running subagent, as the Agent Hub `kill` does; `cancelled:false` when it is already gone. */
	cancel_subagent: async ({ session }, args) => {
		const registry = subagents(session, "cancel_subagent");
		const id = subagentId("cancel_subagent", args);
		const owned = resolveOwnedLiveSubagent(registry, id);
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
		const registry = subagents(session, "steer_subagent");
		const id = subagentId("steer_subagent", args);
		const { message } = args;
		if (typeof message !== "string" || !message.trim()) throw new Error("steer_subagent: message is required");
		const notRunning = `steer_subagent: subagent not running: ${id}`;
		const owned = resolveOwnedLiveSubagent(registry, id);
		if (!owned) throw new Error(notRunning);
		let live: AgentSessionHandle;
		try {
			live = await AgentLifecycleManager.global().ensureLive(id);
		} catch {
			throw new Error(notRunning);
		}
		// ensureLive awaits: the id may now name another agent, or the subagent may have finished.
		const current = resolveOwnedLiveSubagent(registry, id);
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
