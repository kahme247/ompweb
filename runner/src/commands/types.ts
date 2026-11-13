import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/** What a command handler can reach besides its arguments. */
export interface CommandContext {
	session: AgentSession;
	/** The `cmd` frame's id while a command runs; absent for inbound non-command frames. */
	id?: number;
	/** Send an unsolicited frame to the host (streamed output, progress, subscriptions). */
	send(frame: { t: string } & Record<string, unknown>): void;
}

/** A command failure with a machine-readable `code` (RPC's `session_busy`, `entry_not_found`, …); the `res` frame carries it. */
export class CommandError extends Error {
	constructor(
		message: string,
		readonly code: string,
	) {
		super(message);
	}
}

/**
 * One host command. `args` is the host's JSON as sent (the host is this user's own `ompweb host`,
 * reached over a 0600 socket or the child's stdio); a handler checks what it reads and throws on bad
 * input. The resolved value is the `res` frame's `data`; a throw becomes `{ok:false, error}`.
 */
export type CommandHandler = (ctx: CommandContext, args: Record<string, unknown>) => Promise<unknown>;

export type CommandTable = Record<string, CommandHandler>;


/**
 * Host frames that are not commands (results the host sends back for a request omp made, such as a
 * host tool's output), keyed by `t`. A handler checks what it reads; a throw is logged and dropped.
 */
export type FrameHandler = (ctx: CommandContext, frame: Record<string, unknown>) => void;

export type FrameTable = Record<string, FrameHandler>;