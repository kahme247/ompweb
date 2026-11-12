/**
 * Host-provided tools and URI schemes, `/btw` side questions, word prediction, dictation and live voice.
 * Reuses omp's transport-free RPC bridges (`host-tools`, `host-uris`, `rpc-btw`, `rpc-dictation`,
 * `rpc-live`); their `{type}` frames go out as `{t}` frames with the same fields.
 *
 *   omp  → host  {t:"host_tool_call", id, toolCallId, toolName, arguments}   run a tool registered by set_host_tools
 *   omp  → host  {t:"host_tool_cancel", id, targetId}                        the call `targetId` was aborted
 *   host → omp   {t:"host_tool_update", id, partialResult}                   streamed partial result of call `id`
 *   host → omp   {t:"host_tool_result", id, result, isError?}                completes call `id`
 *   omp  → host  {t:"host_uri_request", id, operation, url, content?}        read/write a set_host_uri_schemes URL
 *   omp  → host  {t:"host_uri_cancel", id, targetId}                         the request `targetId` was aborted
 *   host → omp   {t:"host_uri_result", id, content?, contentType?, notes?, immutable?, isError?, error?}
 *   omp  → host  {t:"btw_delta", recordId, delta}                            answer text of the running side question
 *   omp  → host  {t:"btw_record", record}                                    topic snapshot on start/complete/cancel/error
 *   omp  → host  {t:"notice", level:"error", message, source:"btw-history"}  a side answer could not be saved
 *   omp  → host  {t:"dictation_state", captureId, state}                     starting | recording | transcribing
 *   omp  → host  {t:"dictation_transcript", captureId, text}                 full preview so far
 *   omp  → host  {t:"dictation_end", captureId, text, error?}                once per capture
 *   omp  → host  {t:"live_phase", phase} | {t:"live_levels", input, output}
 *   omp  → host  {t:"live_transcript", role, turn, text, final} | {t:"live_end", error?}
 */
import { isRpcHostToolResult, isRpcHostToolUpdate, RpcHostToolBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/host-tools";
import { isRpcHostUriResult, RpcHostUriBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/host-uris";
import { RpcBtwController } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-btw";
import { RpcDictationBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-dictation";
import { RpcLiveBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-live";
import type { RpcHostToolDefinition, RpcHostUriSchemeDefinition } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { cfgSpellingAutocomplete } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { requestTextPrediction, textPredictionBackend } from "@oh-my-pi/pi-coding-agent/predict/client";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { cfgSttEnabled } from "@oh-my-pi/pi-coding-agent/stt/settings";
import { defaultLoadModeForToolName } from "@oh-my-pi/pi-coding-agent/tools/essential-tools";
import {
	type WordCompletionEngine,
	type WordCompletionMethod,
	type WordCompletionQuery,
	wordCompletionQuery,
} from "@oh-my-pi/pi-tui/prompt/word-completion";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { CommandContext, CommandTable, FrameTable } from "./types";

interface ToolsState {
	hostTools: RpcHostToolBridge;
	hostUris: RpcHostUriBridge;
	btw: RpcBtwController;
	dictation: RpcDictationBridge;
	live: RpcLiveBridge;
	predictor: WordPredictor;
	lastDictationError: string | undefined;
}

const states = new WeakMap<AgentSession, ToolsState>();

function optionalString(op: string, args: Record<string, unknown>, field: string): string | undefined {
	const value = args[field];
	if (value !== undefined && typeof value !== "string") throw new Error(`${op}: ${field} must be a string`);
	return value;
}

/** The session's bridges, created on first use; their frames go to the host that sent the command. */
function stateOf(ctx: CommandContext): ToolsState {
	let state = states.get(ctx.session);
	if (state) return state;
	const output = ({ type, ...frame }: { type: string } & object) => ctx.send({ t: type, ...frame });
	const created: ToolsState = {
		hostTools: new RpcHostToolBridge(output),
		hostUris: new RpcHostUriBridge(output),
		btw: new RpcBtwController(ctx.session, output),
		dictation: new RpcDictationBridge(ctx.session, frame => {
			output(frame);
			if (frame.type === "dictation_end" && frame.error) created.lastDictationError = frame.error;
		}),
		live: new RpcLiveBridge(ctx.session, output),
		predictor: new WordPredictor(),
		lastDictationError: undefined,
	};
	state = created;
	states.set(ctx.session, state);
	return state;
}

/**
 * Call before the session is replaced (new_session, switch_session, branch, fork, navigate_tree,
 * open_session), as RPC does: stops dictation and lands every `/btw` checkpoint. Throws when a
 * side answer cannot be saved, so the caller keeps the session instead of losing it.
 */
export async function settleToolsBeforeSessionChange(session: AgentSession): Promise<void> {
	const state = states.get(session);
	if (!state) return;
	const previousError = state.lastDictationError;
	try {
		await state.dictation.stop();
	} catch (cause) {
		// Only a transcription failure already reported in `dictation_end` lets the change proceed.
		if (state.dictation.active || state.lastDictationError === previousError || !(cause instanceof Error) || cause.message !== state.lastDictationError) throw cause;
		logger.warn("Dictation failed while changing sessions", { error: String(cause) });
	}
	await state.btw.close();
}

/**
 * Call when the host link closes, as RPC does on client disconnect: pending host tool and URI calls
 * fail instead of hanging the agent, host schemes leave the process-wide router, mic and call stop.
 */
export async function closeToolsForHost(session: AgentSession): Promise<void> {
	const state = states.get(session);
	if (!state) return;
	states.delete(session);
	state.hostTools.close("ompweb host disconnected before host tool execution completed");
	state.hostUris.clear("ompweb host disconnected before host URI request completed");
	state.dictation.dispose();
	await state.live.stop();
}

function hostToolDefinitions(value: unknown): RpcHostToolDefinition[] {
	if (!Array.isArray(value)) throw new Error("set_host_tools: tools must be an array");
	return value.map((tool: unknown, index) => {
		if (!isRecord(tool)) throw new Error(`set_host_tools: tool at index ${index} must be an object`);
		const name = typeof tool.name === "string" ? tool.name.trim() : "";
		if (!name) throw new Error(`set_host_tools: tool at index ${index} must provide a non-empty name`);
		const description = typeof tool.description === "string" ? tool.description.trim() : "";
		if (!description) throw new Error(`set_host_tools: tool "${name}" must provide a non-empty description`);
		if (!isRecord(tool.parameters)) throw new Error(`set_host_tools: tool "${name}" must provide a JSON Schema object`);
		const loadMode = tool.loadMode;
		if (loadMode !== undefined && loadMode !== "essential" && loadMode !== "discoverable") {
			throw new Error(`set_host_tools: tool "${name}" loadMode must be "essential" or "discoverable"`);
		}
		return {
			name,
			label: typeof tool.label === "string" && tool.label.trim() ? tool.label.trim() : name,
			description,
			parameters: tool.parameters,
			hidden: tool.hidden === true,
			loadMode: defaultLoadModeForToolName(name, loadMode),
			readsSkillUris: tool.readsSkillUris === true ? true : undefined,
		};
	});
}

function hostUriSchemes(value: unknown): RpcHostUriSchemeDefinition[] {
	if (!Array.isArray(value)) throw new Error("set_host_uri_schemes: schemes must be an array");
	// The bridge validates and normalizes each scheme name.
	return value.map((scheme: unknown, index) => {
		if (!isRecord(scheme)) throw new Error(`set_host_uri_schemes: scheme at index ${index} must be an object`);
		return {
			scheme: typeof scheme.scheme === "string" ? scheme.scheme : "",
			description: typeof scheme.description === "string" ? scheme.description : undefined,
			writable: scheme.writable === true,
			immutable: scheme.immutable === true,
		};
	});
}

const INVALID_TEXT_CURSOR = "cursor must be an integer UTF-16 offset within text";

function textCursor(op: string, args: Record<string, unknown>): { text: string; cursor: number } {
	const { text, cursor } = args;
	if (typeof text !== "string" || typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0 || cursor > text.length) {
		throw new Error(`${op}: ${INVALID_TEXT_CURSOR}`);
	}
	return { text, cursor };
}

/** Composer ghost-text query at a UTF-16 cursor, gated like the TUI editor's: end of line, prose word. */
function wordQueryAt(text: string, cursor: number): WordCompletionQuery | undefined {
	if (cursor < text.length && text[cursor] !== "\n") return undefined;
	const lines = text.split("\n");
	let cursorLine = 0;
	let lineStart = 0;
	while (lineStart + lines[cursorLine].length < cursor) lineStart += lines[cursorLine++].length + 1;
	return wordCompletionQuery(lines, cursorLine, cursor - lineStart);
}

/**
 * RPC's `RpcWordPredictor` (it lives in rpc-mode.ts): one engine request in flight, and a newer
 * request replaces the one waiting behind it (which answers `null`), so a burst of typing costs the
 * shared daemon at most two inferences.
 */
class WordPredictor {
	#busy = false;
	#queued: { engine: WordCompletionEngine; query: WordCompletionQuery; resolve(suffix: string | null): void; reject(error: unknown): void } | undefined;

	predict(method: WordCompletionMethod, text: string, cursor: number): Promise<string | null> {
		if (method === "off") return Promise.resolve(null);
		const query = wordQueryAt(text, cursor);
		if (!query) return Promise.resolve(null);
		if (!this.#busy) return this.#run(method, query);
		this.#queued?.resolve(null);
		const { promise, resolve, reject } = Promise.withResolvers<string | null>();
		this.#queued = { engine: method, query, resolve, reject };
		return promise;
	}

	async #run(engine: WordCompletionEngine, query: WordCompletionQuery): Promise<string | null> {
		this.#busy = true;
		try {
			const { suggestion } = await requestTextPrediction(engine, query.before, query.prefix);
			return suggestion?.suffix || null;
		} finally {
			this.#busy = false;
			const next = this.#queued;
			this.#queued = undefined;
			if (next) void this.#run(next.engine, next.query).then(next.resolve, next.reject);
		}
	}
}

async function liveStart(ctx: CommandContext, args: Record<string, unknown>, op: "live_start" | "live_connect") {
	const voice = optionalString(op, args, "voice");
	const instructions = optionalString(op, args, "instructions");
	const sdpOffer = op === "live_connect" ? args.sdpOffer : undefined;
	// Without an offer, live_connect would open the omp machine's microphone.
	if (op === "live_connect" && (typeof sdpOffer !== "string" || !sdpOffer.trim())) throw new Error("live_connect requires a non-empty sdpOffer");
	const state = stateOf(ctx);
	if (state.dictation.active) throw new Error(`${op}: End dictation before starting live voice`);
	return state.live.start({ voice, instructions, sdpOffer: typeof sdpOffer === "string" ? sdpOffer : undefined });
}

// shortcut: RPC also refuses live_start/live_connect/dictation_start while a session change or shutdown runs;
// that counter lives with the session-change commands, so add it when they export one.
export const toolsCommands: CommandTable = {
	set_host_tools: async (ctx, args) => {
		const tools = hostToolDefinitions(args.tools);
		await ctx.session.refreshRpcHostTools(stateOf(ctx).hostTools.setTools(tools));
		return { toolNames: tools.map(tool => tool.name) };
	},
	set_host_uri_schemes: async (ctx, args) => ({ schemes: stateOf(ctx).hostUris.setSchemes(hostUriSchemes(args.schemes)) }),

	btw: async (ctx, args) => {
		if (typeof args.question !== "string") throw new Error("btw: question must be a string");
		return { record: await stateOf(ctx).btw.ask(args.question, optionalString("btw", args, "recordId")) };
	},
	btw_cancel: async (ctx, args) => ({ cancelled: stateOf(ctx).btw.cancel(optionalString("btw_cancel", args, "recordId")) }),
	get_btw_history: async ctx => ({ records: await stateOf(ctx).btw.history() }),

	predict_word: async (ctx, args) => {
		const { text, cursor } = textCursor("predict_word", args);
		return { suffix: await stateOf(ctx).predictor.predict(cfgSpellingAutocomplete.get(ctx.session.settings), text, cursor) };
	},
	predict_word_feedback: async (ctx, args) => {
		const { text, cursor } = textCursor("predict_word_feedback", args);
		const { suggestion, accepted } = args;
		if (typeof suggestion !== "string" || typeof accepted !== "boolean") {
			throw new Error("predict_word_feedback: suggestion must be a string and accepted a boolean");
		}
		const method = cfgSpellingAutocomplete.get(ctx.session.settings);
		if (method === "off") return undefined;
		const query = wordQueryAt(text, cursor);
		if (query) textPredictionBackend(method).feedback(query.before, query.prefix, suggestion, accepted);
		return undefined;
	},

	dictation_start: async (ctx, args) => {
		const state = stateOf(ctx);
		if (state.live.active) throw new Error("dictation_start: End live voice before starting dictation");
		if (!cfgSttEnabled.get(ctx.session.settings)) throw new Error("dictation_start: Speech-to-text is disabled. Enable it in settings: stt.enabled");
		if (typeof args.captureId !== "string") throw new Error("dictation_start: captureId must be a string");
		await state.dictation.start(args.captureId);
		return undefined;
	},
	dictation_stop: async ctx => stateOf(ctx).dictation.stop(),

	live_start: (ctx, args) => liveStart(ctx, args, "live_start"),
	live_connect: (ctx, args) => liveStart(ctx, args, "live_connect"),
	live_stop: async ctx => {
		await stateOf(ctx).live.stop();
		return undefined;
	},
	live_mute: async (ctx, args) => {
		const { muted } = args;
		if (muted !== undefined && typeof muted !== "boolean") throw new Error("live_mute: muted must be a boolean");
		return stateOf(ctx).live.setMuted(muted);
	},
};

/** The RPC bridges' guards check `type`; the channel's frames carry it as `t`. */
function asRpcFrame(frame: Record<string, unknown>): Record<string, unknown> {
	return { ...frame, type: frame.t };
}

export const toolsFrames: FrameTable = {
	host_tool_result: (ctx, frame) => {
		const rpc = asRpcFrame(frame);
		if (!isRpcHostToolResult(rpc)) throw new Error("host_tool_result: needs a string id and a result with content[]");
		stateOf(ctx).hostTools.handleResult(rpc);
	},
	host_tool_update: (ctx, frame) => {
		const rpc = asRpcFrame(frame);
		if (!isRpcHostToolUpdate(rpc)) throw new Error("host_tool_update: needs a string id and a partialResult with content[]");
		stateOf(ctx).hostTools.handleUpdate(rpc);
	},
	host_uri_result: (ctx, frame) => {
		const rpc = asRpcFrame(frame);
		if (!isRpcHostUriResult(rpc)) throw new Error("host_uri_result: needs a string id");
		stateOf(ctx).hostUris.handleResult(rpc);
	},
};
