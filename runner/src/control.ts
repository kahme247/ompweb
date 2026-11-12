/**
 * Control channel between one omp process and the local `ompweb host`.
 *
 * The view plane (transcript, live events, dialogs, subagents) rides omp's own collab room on the
 * host's loopback relay. This channel carries what collab has no frames for: commands with results.
 * It is NDJSON over the host's Unix socket, so only this user's processes reach it.
 *
 *   omp  → host  {t:"hello", proto, pid, sessionId, cwd}
 *   host → omp   {t:"cmd", id, op, args?}
 *   omp  → host  {t:"res", id, ok:true, data?} | {t:"res", id, ok:false, error}
 */
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

export const CONTROL_PROTO = 1;

export type ControlCommand =
	| { t: "cmd"; id: number; op: "get_state" }
	| { t: "cmd"; id: number; op: "set_model"; args: { provider: string; modelId: string } };

/** `$XDG_RUNTIME_DIR/ompweb/host.sock`, or the per-user temp dir where there is no runtime dir (macOS). */
export function hostSocketPath(): string {
	if (process.env.OMPWEB_HOST_SOCKET) return process.env.OMPWEB_HOST_SOCKET;
	return path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), "ompweb", "host.sock");
}

function state(session: AgentSession) {
	const model = session.model;
	return {
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
		sessionName: session.sessionName,
		model: model && { provider: model.provider, id: model.id },
		thinkingLevel: session.thinkingLevel,
		isStreaming: session.isStreaming,
	};
}

async function run(session: AgentSession, cmd: ControlCommand): Promise<unknown> {
	switch (cmd.op) {
		case "get_state":
			return state(session);
		case "set_model": {
			const { provider, modelId } = cmd.args;
			const model = session.modelRegistry.find(provider, modelId);
			if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
			await session.setModel(model);
			return state(session);
		}
		default: {
			const unknown: never = cmd;
			throw new Error(`unknown command: ${JSON.stringify(unknown)}`);
		}
	}
}

/**
 * Connect `session` to the host socket. No host listening means a plain omp run: the channel stays
 * closed and nothing else changes.
 */
export async function attachControl(session: AgentSession): Promise<void> {
	let buffered = "";
	await Bun.connect({
		unix: hostSocketPath(),
		socket: {
			open(socket) {
				const hello = { t: "hello", proto: CONTROL_PROTO, pid: process.pid, sessionId: session.sessionId, cwd: process.cwd() };
				socket.write(`${JSON.stringify(hello)}\n`);
			},
			data(socket, data) {
				buffered += data.toString();
				let newline = buffered.indexOf("\n");
				while (newline >= 0) {
					const line = buffered.slice(0, newline);
					buffered = buffered.slice(newline + 1);
					newline = buffered.indexOf("\n");
					if (!line.trim()) continue;
					const cmd = JSON.parse(line) as ControlCommand;
					run(session, cmd).then(
						data => socket.write(`${JSON.stringify({ t: "res", id: cmd.id, ok: true, data })}\n`),
						(err: unknown) =>
							socket.write(`${JSON.stringify({ t: "res", id: cmd.id, ok: false, error: String(err instanceof Error ? err.message : err) })}\n`),
					);
				}
			},
		},
	}).catch(() => undefined);
}
