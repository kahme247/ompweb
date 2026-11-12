/**
 * In-process channel harness: a fake `ompweb host` on a temporary Unix socket, and a real omp
 * `AgentSession` (the runner's own factory) answering from a scripted mock model. No network, no
 * paid model calls.
 *
 *   const host = await startHost();
 *   const { session } = await createTestSession({ responses: [{ content: ["hi"] }] });
 *   await host.connected;
 *   const res = await host.command("get_state");
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { Database } from "bun:sqlite";
import { createHostedAgentSession } from "../src/session";

export type Frame = { t: string } & Record<string, unknown>;
export type Res = { t: "res"; id: number; ok: boolean; data?: unknown; error?: string; code?: string };

export interface TestHost {
	/** Every frame omp sent, in order. */
	readonly frames: Frame[];
	/** Resolves with omp's `hello` once a session connects. */
	readonly connected: Promise<Frame>;
	/** Send `{t:"cmd"}` and resolve with its `res`. */
	command(op: string, args?: Record<string, unknown>): Promise<Res>;
	/** Send any other frame (e.g. `ui_response`). */
	send(frame: Frame): void;
	/** Resolve with the first frame (already received or future) that matches. */
	waitFor(match: (frame: Frame) => boolean, timeoutMs?: number): Promise<Frame>;
	close(): void;
	/** End omp's connection but keep listening, as a restarted host would. */
	drop(): void;
}

/**
 * Listen on a fresh socket and point `OMPWEB_HOST_SOCKET` at it, so the next session created
 * connects here. Call before `createTestSession`.
 */
export async function startHost(): Promise<TestHost> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompweb-runner-test-"));
	const socketPath = path.join(dir, "host.sock");
	process.env.OMPWEB_HOST_SOCKET = socketPath;

	const frames: Frame[] = [];
	const waiters = new Set<{ match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }>();
	const hello = Promise.withResolvers<Frame>();
	let client: Bun.Socket | undefined;
	let buffered = "";
	let nextId = 1;

	const receive = (frame: Frame) => {
		frames.push(frame);
		if (frame.t === "hello") hello.resolve(frame);
		for (const waiter of waiters) {
			if (!waiter.match(frame)) continue;
			waiters.delete(waiter);
			waiter.resolve(frame);
		}
	};

	const server = Bun.listen({
		unix: socketPath,
		socket: {
			open: socket => {
				client = socket;
			},
			data: (_socket, data) => {
				buffered += data.toString();
				const lines = buffered.split("\n");
				buffered = lines.pop() ?? "";
				for (const line of lines) if (line.trim()) receive(JSON.parse(line) as Frame);
			},
		},
	});

	const send = (frame: Frame) => {
		if (!client) throw new Error("no omp connected");
		client.write(`${JSON.stringify(frame)}\n`);
	};

	const waitFor = (match: (frame: Frame) => boolean, timeoutMs = 5000) => {
		const seen = frames.find(match);
		if (seen) return Promise.resolve(seen);
		const { promise, resolve, reject } = Promise.withResolvers<Frame>();
		const waiter = { match, resolve };
		waiters.add(waiter);
		const timer = setTimeout(() => {
			waiters.delete(waiter);
			reject(new Error(`timed out waiting for a frame; got: ${frames.map(f => f.t).join(", ")}`));
		}, timeoutMs);
		return promise.finally(() => clearTimeout(timer));
	};

	return {
		frames,
		connected: hello.promise,
		send,
		waitFor,
		async command(op, args) {
			const id = nextId++;
			send({ t: "cmd", id, op, args });
			const res = await waitFor(frame => frame.t === "res" && frame.id === id);
			return res as Res;
		},
		close() {
			server.stop(true);
			fs.rmSync(dir, { recursive: true, force: true });
		},
		drop() {
			client?.end();
		},
	};
}

/** A local UI that answers no dialog until it is aborted, so the host's answer always wins. */
function silentUi(): ExtensionUIContext {
	const untilAborted = (signal: AbortSignal | undefined) => {
		const { promise, resolve } = Promise.withResolvers<undefined>();
		signal?.addEventListener("abort", () => resolve(undefined), { once: true });
		return promise;
	};
	return {
		select: async (_title, _options, options) => untilAborted(options?.signal),
		confirm: async (_title, _message, options) => (await untilAborted(options?.signal)) ?? false,
		input: async (_title, _placeholder, options) => untilAborted(options?.signal),
		editor: async (_title, _prefill, options) => untilAborted(options?.signal),
		formDialog: async (_html, options) => untilAborted(options?.signal),
		notify: () => {},
		onTerminalInput: () => () => {},
		rerenderMessage: () => {},
		refreshTranscript: () => {},
		getLinkClicksAvailable: () => false,
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => {
			throw new Error("custom UI is not available in tests");
		},
		setEditorText: () => {},
		pasteToEditor: () => {},
		getEditorText: () => "",
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => Promise.resolve([]),
		getTheme: () => Promise.resolve(undefined),
		setTheme: () => Promise.resolve({ success: false, error: "UI not available" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

export interface TestSession {
	session: AgentSession;
	/** The scripted model; `mock.push(...)` adds replies, `mock.calls` records requests. */
	mock: MockModel;
	dispose(): Promise<void>;
}

/**
 * A real `AgentSession` from the runner's factory (so it connects to the host), in memory, on a
 * mock model (`mock/mock-model`) that replies with `responses` in order.
 */
export async function createTestSession(
	options: { responses?: MockResponse[]; toolNames?: string[]; ui?: Partial<ExtensionUIContext> } = {},
): Promise<TestSession> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompweb-runner-session-"));
	const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const mock = createMockModel({ responses: options.responses ?? [] });
	const result = await createHostedAgentSession({
		cwd: dir,
		agentDir: dir,
		modelRegistry,
		model: mock,
		sessionManager: SessionManager.inMemory(dir),
		settings: Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
		}),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		hasUI: true,
		toolNames: options.toolNames ?? [],
	});
	result.setToolUIContext({ ...silentUi(), ...options.ui }, true);
	result.session.agent.streamFn = mock.stream;
	return {
		session: result.session,
		mock,
		async dispose() {
			await result.session.dispose();
			authStorage.close();
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}
