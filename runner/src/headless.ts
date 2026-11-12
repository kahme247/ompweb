/**
 * Headless omp: `ompweb-omp --headless [omp flags]`, spawned by `ompweb host`, which speaks the
 * channel (`channel.ts`) on this process's stdin/stdout. Nothing else may write to stdout.
 *
 * Startup is omp's own `--mode rpc-ui` launch, with RPC's server module swapped for this one
 * (`rpc-mode-swap.ts`): that
 * path runs all of `runRootCommand` (settings, auth, models, --resume/--continue, extensions, MCP,
 * plugins, settings watch, subagent revival) and hands over the finished session with
 * `hasUI` set, as rpc-ui does. The injectable `--mode acp` path was the alternative, but its
 * per-session factory drops the resolved --resume/--continue session, forces MCP off and skips the
 * post-session startup, so it would mean re-deriving those here.
 *
 * Unsolicited frames:
 *   omp → host  {t:"extension_error", extensionPath, event, error}   an extension handler threw
 *   omp → host  {t:"extension_error", action, error}                 an extension's message send failed
 */
import type { ExtensionUIContext, ExtensionUiComponent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { timedOutAskDialogResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { type Terminal, TUI } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { logger } from "@oh-my-pi/pi-utils";
import { type CustomFactory, HostChannel } from "./channel";
import { rpcModeSwap } from "./rpc-mode-swap";

// shortcut: custom components render at a fixed width; take the browser's width when a host sends one.
const CUSTOM_COLUMNS = 100;
const CUSTOM_ROWS = 40;

let headless = false;
let writeChannel: (line: string) => void = () => {};

/** Whether this process is a headless omp (`--headless`). */
export function isHeadless(): boolean {
	return headless;
}

/**
 * Turn this process into a headless omp before startup runs; returns the argv omp's parser gets.
 * stdout becomes the channel's alone: everything else written there goes to stderr.
 */
export function enterHeadless(argv: string[]): string[] {
	headless = true;
	writeChannel = process.stdout.write.bind(process.stdout);
	// Extensions and libraries may print; on stdout that would corrupt the channel.
	process.stdout.write = process.stderr.write.bind(process.stderr);
	console.log = console.info = console.debug = console.error;
	Bun.plugin(rpcModeSwap);
	return [...argv.filter(arg => arg !== "--headless"), "--mode", "rpc-ui"];
}

/** What `runRootCommand` passes RPC's `runRpcMode` (`RpcModeOptions`), as far as headless uses it. */
interface StartupHandoff {
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	subagentEventBus?: EventBus;
	/** stdin, claimed before extensions load so none can read it. */
	input?: ReadableStream<Uint8Array>;
}

/** Byte sink: the stand-in TUI renders through `requestRender` below, never through a terminal. */
class SinkTerminal implements Terminal {
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	get columns(): number {
		return CUSTOM_COLUMNS;
	}
	get rows(): number {
		return CUSTOM_ROWS;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	get kittyEnableSequence(): string | null {
		return null;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	onAppearanceChange(): void {}
	refreshAppearance(): void {}
	get appearance(): undefined {
		return undefined;
	}
}

/** The `tui` a custom component gets: a render request renders it for the host. */
class HostTui extends TUI {
	readonly #render: () => void;
	#scheduled = false;

	constructor(render: () => void) {
		super(new SinkTerminal());
		this.#render = render;
	}

	override requestRender(): void {
		if (this.#scheduled) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			this.#render();
		});
	}
}

/** Show a custom component with the host as its only screen (`ExtensionUIContext.custom`). */
function showCustom<T>(factory: CustomFactory<T>, signal: AbortSignal | undefined): Promise<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	let component: ExtensionUiComponent | undefined;
	let closed = false;
	const tui = new HostTui(() => component?.render(CUSTOM_COLUMNS));
	const finish = (settle: () => void) => {
		if (closed) return;
		closed = true;
		signal?.removeEventListener("abort", onAbort);
		component?.dispose?.();
		settle();
	};
	const onAbort = () => finish(() => reject(signal?.reason ?? new DOMException("Dialog aborted", "AbortError")));
	if (signal?.aborted) {
		onAbort();
		return promise;
	}
	signal?.addEventListener("abort", onAbort, { once: true });
	Promise.try(() => factory(tui, theme, KeybindingsManager.inMemory(), result => finish(() => resolve(result))))
		.then(created => {
			if (closed) {
				created.dispose?.();
				return;
			}
			component = created;
			tui.requestRender();
		})
		.catch(err => finish(() => reject(err)));
	return promise;
}

/** The UI of a headless omp: dialogs go to the host alone, presentation calls become frames. */
function hostUi(channel: HostChannel): ExtensionUIContext {
	const { presenter } = channel;
	return {
		...presenter,
		supportsEditor: true,
		select: (...args) => channel.dialog("select", args, () => undefined),
		confirm: (...args) => channel.dialog("confirm", args, () => false),
		input: (...args) => channel.dialog("input", args, () => undefined),
		editor: (...args) => channel.dialog("editor", args, () => undefined),
		askDialog: (...args) => channel.dialog("askDialog", args, timedOut => (timedOut ? timedOutAskDialogResult(args[0]) : undefined)),
		formDialog: (...args) => channel.dialog("formDialog", args, () => undefined),
		approve: (...args) => channel.dialog("approve", args, () => "deny" as const),
		custom: (factory, options) => channel.custom(factory, mirrored => showCustom(mirrored, options?.signal)),
		// As RPC: there is no local editor to paste into.
		pasteToEditor: text => presenter.setEditorText(text),
		getEditorText: () => "",
		onTerminalInput: () => () => {},
		rerenderMessage: () => {},
		refreshTranscript: () => {},
		getLinkClicksAvailable: () => false,
		setFooter: () => {},
		setHeader: () => {},
		addAutocompleteProvider: () => {},
		get theme() {
			return theme;
		},
		getAllThemes: async () => [],
		getTheme: async () => undefined,
		setTheme: async () => ({ success: false, error: "Theme switching is not supported in headless omp" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
	};
}

/**
 * Stands in for RPC's `runRpcMode` (see `enterHeadless`): serve the host on stdio until stdin
 * ends, then dispose the session and exit, as RPC does.
 */
export async function runRpcMode(session: AgentSession, handoff: StartupHandoff = {}): Promise<never> {
	// Terminal notifications write BEL/OSC to the terminal, which is the channel here.
	process.env.PI_NOTIFICATIONS = "off";
	const channel = HostChannel.stdio(session, handoff.subagentEventBus, writeChannel);
	const ui = hostUi(channel);
	handoff.setToolUIContext?.(ui, true);
	// Read now: `session_start` handlers may wait on a dialog only the host can answer.
	const reading = channel.read(handoff.input ?? Bun.stdin.stream());
	const exit = async (): Promise<never> => {
		await session.dispose().catch(err => logger.error("headless omp: dispose failed", { error: String(err) }));
		process.exit(0);
	};
	await initializeExtensions(session, {
		mode: "rpc",
		uiContext: ui,
		reportSendError: (action, err) => writeFrame({ t: "extension_error", action, error: err.message }),
		reportRuntimeError: err =>
			writeFrame({ t: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error }),
		// shortcut: exits without waiting for a running command's `res`; queue behind it if a host needs that.
		onShutdown: () => void exit(),
	});
	channel.release();
	await reading.catch(err => logger.warn("headless omp: stdin failed", { error: String(err) }));
	return exit();
}

function writeFrame(frame: { t: string } & Record<string, unknown>): void {
	writeChannel(`${JSON.stringify(frame)}\n`);
}
