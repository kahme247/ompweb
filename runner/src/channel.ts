/**
 * The channel between one omp process and the local `ompweb host`: NDJSON over the host's Unix
 * socket, so only this user's processes reach it.
 *
 *   omp  → host  {t:"hello", proto, pid, sessionId, sessionFile, cwd}
 *   omp  → host  {t:"event", event}                       every AgentSession event
 *   host → omp   {t:"cmd", id, op, args?}
 *   omp  → host  {t:"res", id, ok:true, data?} | {t:"res", id, ok:false, error}
 *   omp  → host  {t:"ui_request", id, method, args}        a dialog opened (TUI shows it too)
 *   host → omp   {t:"ui_response", id, value}              first answer wins; the TUI dialog closes
 *   omp  → host  {t:"ui_end", id}                          answered locally or cancelled
 *
 * The transcript before `hello` is the session file; the host reads it.
 */
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

export const CHANNEL_PROTO = 1;

export type HostMessage =
	| { t: "cmd"; id: number; op: "get_state" }
	| { t: "cmd"; id: number; op: "set_model"; args: { provider: string; modelId: string } }
	| { t: "cmd"; id: number; op: "prompt"; args: { text: string; streamingBehavior?: "steer" | "followUp" } }
	| { t: "cmd"; id: number; op: "abort" }
	| { t: "ui_response"; id: number; value: unknown };

type Command = Extract<HostMessage, { t: "cmd" }>;

/** Argument index of `ExtensionUIDialogOptions` in each dialog the host can answer. */
const DIALOG_OPTIONS_INDEX: Record<string, number> = {
	select: 2,
	confirm: 2,
	input: 2,
	editor: 2,
	askDialog: 1,
	formDialog: 1,
	approve: 1,
};

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

async function run(session: AgentSession, cmd: Command): Promise<unknown> {
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
		case "prompt":
			// The run continues after the reply; its progress arrives as events.
			void session.prompt(cmd.args.text, { streamingBehavior: cmd.args.streamingBehavior ?? "followUp", userInitiated: true });
			return undefined;
		case "abort":
			await session.abort();
			return undefined;
		default: {
			const unknown: never = cmd;
			throw new Error(`unknown command: ${JSON.stringify(unknown)}`);
		}
	}
}

export class HostChannel {
	#socket: Bun.Socket | undefined;
	#nextUiId = 1;
	readonly #pendingUi = new Map<number, (value: unknown) => void>();

	/**
	 * Connect `session` to the host socket. No host listening means a plain omp run: the channel
	 * stays closed and every dialog is the TUI's alone.
	 */
	// shortcut: connects once at session creation; reconnect when the host can restart under a live omp.
	static async connect(session: AgentSession): Promise<HostChannel> {
		const channel = new HostChannel();
		let buffered = "";
		channel.#socket = await Bun.connect({
			unix: hostSocketPath(),
			socket: {
				data: (_socket, data) => {
					buffered += data.toString();
					let newline = buffered.indexOf("\n");
					while (newline >= 0) {
						const line = buffered.slice(0, newline);
						buffered = buffered.slice(newline + 1);
						newline = buffered.indexOf("\n");
						if (line.trim()) channel.#receive(session, JSON.parse(line) as HostMessage);
					}
				},
				close: () => {
					channel.#socket = undefined;
				},
			},
		}).catch(() => undefined);
		if (!channel.#socket) return channel;
		channel.#send({
			t: "hello",
			proto: CHANNEL_PROTO,
			pid: process.pid,
			sessionId: session.sessionId,
			sessionFile: session.sessionFile,
			cwd: process.cwd(),
		});
		// shortcut: forwards whole events, partial messages included; trim streaming deltas when the host link carries them.
		session.subscribe(event => channel.#send({ t: "event", event }));
		return channel;
	}

	#send(message: object): void {
		this.#socket?.write(`${JSON.stringify(message)}\n`);
	}

	#receive(session: AgentSession, message: HostMessage): void {
		if (message.t === "ui_response") {
			this.#pendingUi.get(message.id)?.(message.value);
			return;
		}
		run(session, message).then(
			data => this.#send({ t: "res", id: message.id, ok: true, data }),
			(err: unknown) => this.#send({ t: "res", id: message.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
		);
	}

	/**
	 * Race a dialog between the local UI and the host: the first answer wins and the other side's
	 * dialog closes. Without a host the local UI answers alone.
	 */
	#race<T>(method: string, args: unknown[], local: (args: unknown[]) => Promise<T>): Promise<T> {
		const index = DIALOG_OPTIONS_INDEX[method];
		if (!this.#socket || index === undefined) return local(args);

		const callerOptions = args[index] as ExtensionUIDialogOptions | undefined;
		const localAbort = new AbortController();
		const signal = callerOptions?.signal ? AbortSignal.any([callerOptions.signal, localAbort.signal]) : localAbort.signal;
		const localArgs = [...args];
		localArgs[index] = { ...callerOptions, signal };

		const id = this.#nextUiId++;
		const { promise: remote, resolve: answer } = Promise.withResolvers<T>();
		this.#pendingUi.set(id, value => answer(value as T));
		const wireArgs = [...args];
		wireArgs[index] = callerOptions && { ...callerOptions, signal: undefined };
		this.#send({ t: "ui_request", id, method, args: wireArgs });

		const localAnswer = local(localArgs).then(value => ({ from: "local" as const, value }));
		const remoteAnswer = remote.then(value => ({ from: "host" as const, value }));
		return Promise.race([localAnswer, remoteAnswer]).then(winner => {
			this.#pendingUi.delete(id);
			if (winner.from === "host") localAbort.abort();
			else this.#send({ t: "ui_end", id });
			return winner.value;
		});
	}

	/** The local UI with its dialogs raced against the host. */
	wrapUi(ui: ExtensionUIContext): ExtensionUIContext {
		return new Proxy(ui, {
			get: (target, prop, receiver) => {
				const value: unknown = Reflect.get(target, prop, receiver);
				if (typeof prop !== "string" || typeof value !== "function" || !(prop in DIALOG_OPTIONS_INDEX)) return value;
				return (...args: unknown[]) => this.#race(prop, args, localArgs => value.apply(target, localArgs));
			},
		});
	}
}
