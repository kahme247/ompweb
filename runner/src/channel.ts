/**
 * The channel between one omp process and the local `ompweb host`: NDJSON lines over either
 * transport, with the same frames on both:
 *   - the host's Unix socket, for an omp the user started in a terminal (`HostChannel.connect`);
 *     only this user's processes reach it, and the channel redials when the host restarts;
 *   - stdin/stdout, for a headless omp the host spawned (`HostChannel.stdio`, see `headless.ts`).
 *
 *   omp  → host  {t:"hello", proto, pid, sessionId, sessionFile, cwd}   on every (re)connect
 *   host → omp   {t:"cmd", id, op, args?}
 *   omp  → host  {t:"res", id, ok:true, data?} | {t:"res", id, ok:false, error, code?}
 *   omp  → host  {t:"ui_request", id, method, args}   a dialog opened; `args` positional per ExtensionUIContext,
 *                                                     dialog options without `signal`. With a TUI it shows there too.
 *   host → omp   {t:"ui_response", id, value}         the method's return value; first answer wins
 *   omp  → host  {t:"ui_end", id}                     omp closed the dialog itself (TUI answer, abort, timeout)
 *   host → omp   {t:"refused", reason?}               the host will not take this omp (protocol, session live
 *                                                     elsewhere); the socket closes and omp stops redialling
 *   omp  → host  {t:"ui", method, ...fields}          a presentation call, fire-and-forget:
 *                                                     notify{message, notifyType}, setStatus{statusKey, statusText},
 *                                                     setWidget{widgetKey, widgetLines, widgetPlacement},
 *                                                     setTitle{title}, set_editor_text{text}, setWorkingMessage{message},
 *                                                     custom{id, lines, closed?} (a custom component's rendered lines)
 *   host → omp   {t:"ui_input", id, data}             keyboard input for custom component `id`
 *
 * Other frames come from the command groups (`commands/*.ts`), `events.ts` and `headless.ts`.
 * The transcript before `hello` is the session file; the host reads it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUiComponent,
	KeybindingsManager,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { commands, frames } from "./commands";
import { watchSubagents } from "./commands/agents";
import { watchSessionIdentity } from "./commands/session";
import { closeToolsForHost } from "./commands/tools";
import { type CommandContext, CommandError } from "./commands/types";
import { subscribeHostEvents } from "./events";

export const CHANNEL_PROTO = 1;

const RECONNECT_MS = 2_000;
/** How long TUI startup waits for the first connect; a slower host is still adopted when it answers. */
const CONNECT_WAIT_MS = 1_000;

/** One parsed host line; `#receive` narrows it by `t`. */
export type HostMessage = { t: string } & Record<string, unknown>;

/** Argument index of `ExtensionUIDialogOptions` in each dialog the host can answer. */
const DIALOG_OPTIONS_INDEX = {
	select: 2,
	confirm: 2,
	input: 2,
	editor: 2,
	askDialog: 1,
	formDialog: 1,
	approve: 1,
} as const;

export type DialogMethod = keyof typeof DIALOG_OPTIONS_INDEX;

/** The presentation calls the host mirrors. */
type Presenter = Pick<
	ExtensionUIContext,
	"notify" | "setStatus" | "setWidget" | "setTitle" | "setEditorText" | "setWorkingMessage"
>;

export type CustomFactory<T> = (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: T) => void,
) => ExtensionUiComponent | Promise<ExtensionUiComponent>;

interface PendingDialog {
	method: DialogMethod;
	args: unknown[];
	answer(value: unknown): void;
	/** The host link closed with the dialog open. */
	lost(): void;
}

/** `$XDG_RUNTIME_DIR/ompweb/host.sock`, or the per-user temp dir where there is no runtime dir (macOS). */
export function hostSocketPath(): string {
	if (process.env.OMPWEB_HOST_SOCKET) return process.env.OMPWEB_HOST_SOCKET;
	return path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), "ompweb", "host.sock");
}

/** Whether only this user can create the socket in `dir`; anyone else could stand in for the host. */
function isPrivateDir(dir: string): boolean {
	const uid = process.getuid?.();
	if (uid === undefined) return true;
	try {
		const stat = fs.statSync(dir);
		return stat.uid === uid && (stat.mode & 0o022) === 0;
	} catch {
		return false;
	}
}

function isHostMessage(value: unknown): value is HostMessage {
	return isRecord(value) && typeof value.t === "string";
}

function dialogOptionsOf(method: DialogMethod, args: unknown[]): ExtensionUIDialogOptions | undefined {
	const options = args[DIALOG_OPTIONS_INDEX[method]];
	return isRecord(options) ? options : undefined;
}

/** `args` as sent to the host: dialog options without the signal. */
function wireArgs(method: DialogMethod, args: unknown[]): unknown[] {
	const options = dialogOptionsOf(method, args);
	if (!options) return args;
	const wire = [...args];
	wire[DIALOG_OPTIONS_INDEX[method]] = { ...options, signal: undefined };
	return wire;
}

export class HostChannel {
	readonly #session: AgentSession;
	readonly #subagentEventBus: EventBus | undefined;
	/** Read once, so a channel never follows a later change of `OMPWEB_HOST_SOCKET`. */
	readonly #socketPath = hostSocketPath();
	/** The host refused this omp: no more dials. */
	#refused = false;
	#write: ((line: string) => void) | undefined;
	#unwatch: (() => void)[] = [];
	/** Frames other than dialog answers wait here until `release()` (headless startup). */
	#held: HostMessage[] | undefined;
	#warnedUnsafeDir = false;
	#nextUiId = 1;
	readonly #pendingUi = new Map<number, PendingDialog>();
	readonly #customInput = new Map<number, (data: string) => void>();

	readonly presenter: Presenter = {
		notify: (message, type) => this.#send({ t: "ui", method: "notify", message, notifyType: type }),
		setStatus: (key, text) => this.#send({ t: "ui", method: "setStatus", statusKey: key, statusText: text }),
		setWidget: (key, content, options) => {
			// Component factories need a terminal, so only plain lines reach the host.
			if (content !== undefined && !Array.isArray(content)) return;
			this.#send({ t: "ui", method: "setWidget", widgetKey: key, widgetLines: content, widgetPlacement: options?.placement });
		},
		setTitle: title => this.#send({ t: "ui", method: "setTitle", title }),
		setEditorText: text => this.#send({ t: "ui", method: "set_editor_text", text }),
		setWorkingMessage: message => this.#send({ t: "ui", method: "setWorkingMessage", message }),
	};

	private constructor(session: AgentSession, subagentEventBus: EventBus | undefined) {
		this.#session = session;
		this.#subagentEventBus = subagentEventBus;
	}

	/**
	 * Connect `session` to the host socket, and keep redialling while omp runs: no host listening
	 * means a plain omp run whose dialogs are the TUI's alone, until a host starts.
	 */
	static async connect(session: AgentSession, subagentEventBus?: EventBus): Promise<HostChannel> {
		const channel = new HostChannel(session, subagentEventBus);
		// shortcut: the Windows host has no named pipe yet; dial there once it does.
		if (process.platform === "win32") return channel;
		const { promise: waited, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, CONNECT_WAIT_MS).unref();
		await Promise.race([channel.#dial(), waited]);
		return channel;
	}

	/** Serve the host on this process's stdio; frames other than dialog answers wait for `release()`. */
	static stdio(session: AgentSession, subagentEventBus: EventBus | undefined, write: (line: string) => void): HostChannel {
		const channel = new HostChannel(session, subagentEventBus);
		channel.#held = [];
		channel.#open(write);
		return channel;
	}

	/** Read host lines from `input` until it ends, then close the channel. */
	async read(input: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
		const feed = this.#lineReader();
		const decoder = new TextDecoder();
		try {
			for (let chunk = await input.read(); !chunk.done; chunk = await input.read()) {
				feed(decoder.decode(chunk.value, { stream: true }));
			}
		} finally {
			this.#close();
		}
	}

	/** Dispatch the frames held since `stdio()`, and every later frame as it arrives. */
	release(): void {
		const held = this.#held ?? [];
		this.#held = undefined;
		for (const message of held) this.#receive(message);
	}

	async #dial(): Promise<void> {
		const socketPath = this.#socketPath;
		if (!isPrivateDir(path.dirname(socketPath))) {
			if (!this.#warnedUnsafeDir) {
				this.#warnedUnsafeDir = true;
				logger.warn("ompweb channel: socket directory is not private to this user; not connecting", { socketPath });
			}
			this.#redial();
			return;
		}
		const feed = this.#lineReader();
		const decoder = new TextDecoder();
		const encoder = new TextEncoder();
		const queue: Uint8Array[] = [];
		let opened = false;
		// `write` takes what the kernel buffer holds; the rest waits for `drain`.
		const flush = (socket: Bun.Socket) => {
			while (queue.length > 0) {
				const chunk = queue[0];
				const written = Math.max(socket.write(chunk), 0);
				if (written < chunk.byteLength) {
					queue[0] = chunk.subarray(written);
					return;
				}
				queue.shift();
			}
		};
		const socket = await Bun.connect({
			unix: socketPath,
			socket: {
				data: (_socket, data) => feed(decoder.decode(data, { stream: true })),
				drain: flush,
				close: () => {
					if (!opened) return;
					opened = false;
					this.#close();
					this.#redial();
				},
			},
		}).catch(() => undefined);
		if (!socket) {
			this.#redial();
			return;
		}
		// The channel must not keep a finished omp alive.
		socket.unref();
		opened = true;
		this.#open(line => {
			queue.push(encoder.encode(line));
			if (queue.length === 1) flush(socket);
		});
	}

	#redial(): void {
		if (!this.#refused) setTimeout(() => void this.#dial(), RECONNECT_MS).unref();
	}

	#open(write: (line: string) => void): void {
		this.#write = write;
		const session = this.#session;
		const send: CommandContext["send"] = frame => this.#send(frame);
		this.#send({
			t: "hello",
			proto: CHANNEL_PROTO,
			pid: process.pid,
			sessionId: session.sessionId,
			sessionFile: session.sessionFile,
			cwd: session.sessionManager.getCwd(),
		});
		// Per connection: a redialled host starts from a fresh subscription, not mid-delta.
		this.#unwatch = [watchSessionIdentity(session, send), subscribeHostEvents(session, send)];
		if (this.#subagentEventBus) this.#unwatch.push(watchSubagents({ session, send }, this.#subagentEventBus));
		// Dialogs the TUI still shows open on the new host too.
		for (const [id, { method, args }] of this.#pendingUi) this.#send({ t: "ui_request", id, method, args });
	}

	#close(): void {
		if (!this.#write) return;
		this.#write = undefined;
		for (const unwatch of this.#unwatch.splice(0)) unwatch();
		for (const pending of [...this.#pendingUi.values()]) pending.lost();
		closeToolsForHost(this.#session).catch(err =>
			logger.warn("ompweb channel: closing host tools failed", { error: String(err) }),
		);
	}

	#lineReader(): (text: string) => void {
		let buffered = "";
		return text => {
			buffered += text;
			let newline = buffered.indexOf("\n");
			while (newline >= 0) {
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				newline = buffered.indexOf("\n");
				if (line.trim()) this.#receiveLine(line);
			}
		};
	}

	#receiveLine(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch (err) {
			logger.warn("ompweb channel: unparsable host line", { error: String(err) });
			return;
		}
		if (!isHostMessage(message)) {
			logger.warn("ompweb channel: host line without a frame type");
			return;
		}
		this.#receive(message);
	}

	#send(message: object): void {
		this.#write?.(`${JSON.stringify(message)}\n`);
	}

	#receive(message: HostMessage): void {
		if (message.t === "refused") {
			if (!this.#refused) logger.warn("ompweb channel: the host refused this omp; not redialling", { reason: message.reason });
			this.#refused = true;
			return;
		}
		if (message.t === "ui_response") {
			if (typeof message.id === "number") this.#pendingUi.get(message.id)?.answer(message.value);
			return;
		}
		if (message.t === "ui_input") {
			if (typeof message.id === "number" && typeof message.data === "string") this.#customInput.get(message.id)?.(message.data);
			return;
		}
		if (this.#held) {
			this.#held.push(message);
			return;
		}
		const session = this.#session;
		const send: CommandContext["send"] = frame => this.#send(frame);
		if (message.t !== "cmd") {
			const handler = Object.hasOwn(frames, message.t) ? frames[message.t] : undefined;
			try {
				handler?.({ session, send }, message);
			} catch (err) {
				logger.warn("ompweb channel: bad host frame", { t: message.t, error: String(err) });
			}
			return;
		}
		const { id, op, args } = message;
		if (typeof id !== "number" || typeof op !== "string") return;
		if (args !== undefined && !isRecord(args)) {
			this.#send({ t: "res", id, ok: false, error: `${op}: args must be an object` });
			return;
		}
		const handler = Object.hasOwn(commands, op) ? commands[op] : undefined;
		Promise.try(() => {
			if (!handler) throw new Error(`unknown command: ${op}`);
			return handler({ session, send, id }, args ?? {});
		}).then(
			data => this.#send({ t: "res", id, ok: true, data }),
			(err: unknown) =>
				this.#send({
					t: "res",
					id,
					ok: false,
					error: err instanceof Error ? err.message : String(err),
					...(err instanceof CommandError ? { code: err.code } : {}),
				}),
		);
	}

	/**
	 * Open a dialog on the host alone (headless omp). An abort or the caller's timeout closes it
	 * with `fallback`, as does losing the host.
	 */
	dialog<T>(method: DialogMethod, args: unknown[], fallback: (timedOut: boolean) => T): Promise<T> {
		const options = dialogOptionsOf(method, args);
		if (options?.signal?.aborted || !this.#write) return Promise.resolve(fallback(false));
		const id = this.#nextUiId++;
		const { promise, resolve } = Promise.withResolvers<T>();
		let timer: Timer | undefined;
		const settle = (value: T, closeOnHost: boolean) => {
			clearTimeout(timer);
			options?.signal?.removeEventListener("abort", onAbort);
			this.#pendingUi.delete(id);
			if (closeOnHost) this.#send({ t: "ui_end", id });
			resolve(value);
		};
		const onAbort = () => settle(fallback(false), true);
		options?.signal?.addEventListener("abort", onAbort, { once: true });
		if (options?.timeout !== undefined) {
			timer = setTimeout(() => {
				options.onTimeout?.();
				settle(fallback(true), true);
			}, options.timeout);
		}
		this.#pendingUi.set(id, {
			method,
			args: wireArgs(method, args),
			answer: value => settle(value as T, false),
			lost: () => settle(fallback(false), false),
		});
		this.#send({ t: "ui_request", id, method, args: wireArgs(method, args) });
		return promise;
	}

	/**
	 * Race a dialog between the local UI and the host: the first answer wins and the other side's
	 * dialog closes. Without a host the local UI answers alone, and a host that connects meanwhile gets it.
	 */
	#race<T>(method: DialogMethod, args: unknown[], local: (args: unknown[]) => Promise<T>): Promise<T> {
		const index = DIALOG_OPTIONS_INDEX[method];
		const callerOptions = dialogOptionsOf(method, args);
		const localAbort = new AbortController();
		const signal = callerOptions?.signal ? AbortSignal.any([callerOptions.signal, localAbort.signal]) : localAbort.signal;
		const localArgs = [...args];
		localArgs[index] = { ...callerOptions, signal };

		const id = this.#nextUiId++;
		const { promise: remote, resolve: answer } = Promise.withResolvers<T>();
		const wire = wireArgs(method, args);
		// A lost host leaves the local dialog to answer alone.
		this.#pendingUi.set(id, { method, args: wire, answer: value => answer(value as T), lost: () => {} });
		this.#send({ t: "ui_request", id, method, args: wire });

		const localAnswer = local(localArgs).then(value => ({ from: "local" as const, value }));
		const remoteAnswer = remote.then(value => ({ from: "host" as const, value }));
		return Promise.race([localAnswer, remoteAnswer])
			.finally(() => this.#pendingUi.delete(id))
			.then(
				winner => {
					if (winner.from === "host") localAbort.abort();
					else this.#send({ t: "ui_end", id });
					return winner.value;
				},
				(err: unknown) => {
					this.#send({ t: "ui_end", id });
					throw err;
				},
			);
	}

	/**
	 * Run a custom component through `show` (the TUI's, or the headless stand-in), mirroring its
	 * rendered lines to the host and the host's keys to it.
	 */
	custom<T>(factory: CustomFactory<T>, show: (factory: CustomFactory<T>) => Promise<T>): Promise<T> {
		const id = this.#nextUiId++;
		let last: string | undefined;
		return show(async (tui, theme, keybindings, done) => {
			const component = await factory(tui, theme, keybindings, done);
			const render = component.render.bind(component);
			component.render = width => {
				const lines = render(width);
				const key = lines.join("\n");
				if (key !== last) {
					last = key;
					this.#send({ t: "ui", method: "custom", id, lines });
				}
				return lines;
			};
			this.#customInput.set(id, data => {
				component.handleInput?.(data);
				tui.requestRender();
			});
			return component;
		}).finally(() => {
			this.#customInput.delete(id);
			if (last !== undefined) this.#send({ t: "ui", method: "custom", id, lines: [], closed: true });
		});
	}

	/** The local UI with its dialogs raced against the host and its presentation mirrored there. */
	wrapUi(ui: ExtensionUIContext): ExtensionUIContext {
		return new Proxy(ui, {
			get: (target, prop, receiver) => {
				const value: unknown = Reflect.get(target, prop, receiver);
				if (typeof prop !== "string" || typeof value !== "function") return value;
				if (prop in DIALOG_OPTIONS_INDEX) {
					const method = prop as DialogMethod;
					return (...args: unknown[]) => this.#race(method, args, localArgs => value.apply(target, localArgs));
				}
				if (prop === "custom") {
					return <T>(factory: CustomFactory<T>, options?: unknown) =>
						this.custom(factory, mirrored => value.call(target, mirrored, options));
				}
				if (Object.hasOwn(this.presenter, prop)) {
					const mirror: unknown = Reflect.get(this.presenter, prop);
					return (...args: unknown[]) => {
						const result: unknown = value.apply(target, args);
						if (typeof mirror === "function") mirror(...args);
						return result;
					};
				}
				return value;
			},
		});
	}
}
