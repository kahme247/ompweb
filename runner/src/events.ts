/**
 * Session events to the host as `{t:"event", event}`, ported from RPC's event layer (rpc-mode.ts subscribe path).
 *
 * Every `AgentSession` event is forwarded through RPC's `RpcSessionEventForwarder`, so
 * `message_start` / `message_update` / `message_end` carry a `messageId` ("msg-N", unique per process) and
 * `message_update` is a delta by default:
 *   {type:"message_update", messageId, message:{role}, assistantMessageEvent}
 * where `assistantMessageEvent` drops the accumulated `partial` (see rpc-session-events.ts `toDelta`).
 * `set_event_filter {messageUpdates:"full"}` sends the whole partial instead; a host that lost a delta base
 * switches to full until the message ends, then back to delta (RPC has no other recovery command).
 *
 * Events that are not plain AgentSession events:
 *   session_settled            {type}                              the session went quiet after activity (RpcSessionSettleWatcher)
 *   available_commands_update  {type, commands}                    at subscribe, on command-metadata change, after a session change
 *   session_info_update        {type, title?, sessionId}           the session name changed (TUI /rename, auto title, host rename)
 *   notice (source "session-persistence")  {type, level, message, source}  store failure (error) or session moved to a new file (warning)
 *
 * Stamped fields (correlation.ts): `clientMessageId` on message_start/message_end of a host-submitted message, and
 * `clientMessageIds` on queue_update; an extra identity-only queue_update follows once a queued message is named.
 */
import { formatPersistenceFailure, formatPersistenceNotice } from "@oh-my-pi/pi-coding-agent/modes/persistence-failure";
import { RpcSessionEventForwarder } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-events";
import {
	type RpcScheduledTurnProbe,
	RpcSessionSettleWatcher,
	watchedScheduledTurnProbe,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-settle";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { buildAvailableSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import type { CommandContext, CommandTable } from "./commands/types";
import { onClientQueueChange, stampClientMessageId } from "./correlation";

interface HostEvents {
	forwarder: RpcSessionEventForwarder;
	settle: RpcSessionSettleWatcher;
	emitCommands(): Promise<void>;
}

const bridges = new WeakMap<AgentSession, HostEvents>();
/** A host-scheduled turn not yet admitted (a goal continuation); set by the prompting commands, possibly before the bridge exists. */
const scheduledTurns = new WeakMap<AgentSession, () => boolean>();

export function subscribeHostEvents(session: AgentSession, send: CommandContext["send"]): () => void {
	const event = (frame: object) => send({ t: "event", event: frame });
	const forwarder = new RpcSessionEventForwarder(event);
	forwarder.setFilter(null, "delta");
	const settle = new RpcSessionSettleWatcher(session, event, () => scheduledTurns.get(session)?.() ?? false);
	const emitCommands = async () => {
		event({ type: "available_commands_update", commands: await buildAvailableSlashCommands(session) });
	};
	bridges.set(session, { forwarder, settle, emitCommands });

	const unsubscribers = [
		session.subscribe(sessionEvent => {
			// Synchronous: the stamp reads the live queues.
			forwarder.forward(stampClientMessageId(session, sessionEvent));
			settle.observe(sessionEvent);
		}),
		onClientQueueChange(session, queueEvent => forwarder.forward(queueEvent)),
		session.subscribeCommandMetadataChanged(() => void emitCommands()),
		session.sessionManager.onSessionNameChanged(() =>
			event({ type: "session_info_update", title: session.sessionName, sessionId: session.sessionId }),
		),
		// Straight to the host, not session.emitNotice: dispose clears session listeners before it closes the store.
		session.sessionManager.onPersistenceError(error =>
			event({ type: "notice", level: "error", message: formatPersistenceFailure(error.message), source: "session-persistence" }),
		),
		session.sessionManager.onPersistenceNotice(notice =>
			event({ type: "notice", level: "warning", message: formatPersistenceNotice(notice), source: "session-persistence" }),
		),
	];
	void emitCommands();
	return () => {
		for (const unsubscribe of unsubscribers) unsubscribe();
		bridges.delete(session);
	};
}

/**
 * The probe RPC hands `RpcPromptResults`: reports whether `pending` holds a turn, and every "pending" answer
 * opens a settle stretch so an abandoned continuation still ends with `session_settled`.
 */
export function scheduledTurnProbe(session: AgentSession, pending: () => boolean): RpcScheduledTurnProbe {
	scheduledTurns.set(session, pending);
	return watchedScheduledTurnProbe(pending, () => bridges.get(session)?.settle);
}

/** Re-check settlement where no terminal `agent_end` will (an abandoned goal turn, a prompt that settled without a run). */
export function checkSettled(session: AgentSession): void {
	void bridges.get(session)?.settle.check();
}

/** After new/switch/branch/fork/open session: the detached run sends no terminal `agent_end`, and the command catalog may differ. */
export async function afterSessionChange(session: AgentSession): Promise<void> {
	const bridge = bridges.get(session);
	if (!bridge) return;
	void bridge.settle.check();
	await bridge.emitCommands();
}

export const eventsCommands: CommandTable = {
	async set_event_filter({ session }, { events, messageUpdates = "delta" }) {
		if (events !== null && (!Array.isArray(events) || !events.every(type => typeof type === "string" && type.length > 0))) {
			throw new Error("set_event_filter: events must be null or an array of non-empty event type strings");
		}
		if (messageUpdates !== "full" && messageUpdates !== "delta") {
			throw new Error('set_event_filter: messageUpdates must be "full" or "delta"');
		}
		const bridge = bridges.get(session);
		if (!bridge) throw new Error("set_event_filter: no host event subscription on this session");
		return { events: bridge.forwarder.setFilter(events, messageUpdates), messageUpdates };
	},
};
