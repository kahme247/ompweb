/**
 * Session lifecycle, tree and transcript commands.
 *
 * Unsolicited frame (see {@link watchSessionIdentity}):
 *   omp → host  {t:"session", sessionId, sessionFile, cwd}   the session now writes to another file
 *
 * Errors carry a `code` (`session_busy`, `entry_not_found`, `unknown_since`, `stale_cursor`,
 * `ask_reanswer_unsupported`) as a `CommandError`.
 */
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { type AgentSession, SessionBusyError } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { findMostRecentNonEmptySession, findRecentSessionContinuation } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { probeSessionLeases } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { isRecord } from "@oh-my-pi/pi-utils";
import { afterSessionChange } from "../events";
import { prompting } from "./prompting";
import { settleToolsBeforeSessionChange } from "./tools";
import { type CommandContext, CommandError, type CommandTable, type FrameTable } from "./types";

function optionalString(op: string, args: Record<string, unknown>, field: string): string | undefined {
	const value = args[field];
	if (value !== undefined && typeof value !== "string") throw new Error(`${op}: ${field} must be a string`);
	return value;
}

function requiredString(op: string, args: Record<string, unknown>, field: string): string {
	const value = args[field];
	if (typeof value !== "string") throw new Error(`${op}: ${field} must be a string`);
	return value;
}

/** `fork`/`navigateTree` recheck idleness after their awaits; RPC reports that refusal as `session_busy`. */
function rethrowBusy(err: unknown): never {
	throw err instanceof SessionBusyError ? new CommandError(err.message, "session_busy") : err;
}

/** The optional `provider`/`modelId` pair of `open_session`/`switch_session`, as RPC resolves it. */
async function requestedModel(op: string, session: AgentSession, args: Record<string, unknown>): Promise<Model | undefined> {
	const provider = optionalString(op, args, "provider");
	const modelId = optionalString(op, args, "modelId");
	if (provider === undefined && modelId === undefined) return undefined;
	if (provider === undefined || modelId === undefined) throw new Error("provider and modelId must be given together");
	const find = () => session.getAvailableModels().find(m => m.provider === provider && m.id === modelId);
	// Discovery-backed providers populate after startup; only a miss waits for them.
	let model = find();
	if (!model) {
		await session.modelRegistry.awaitBackgroundRefresh();
		model = find();
	}
	if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
	return model;
}

/**
 * RPC's session-change bracket: settle tools, hold goal continuations across `change`, then on
 * success void input accepted before this command (`sequence`, taken when it arrived) and close the
 * prompts a detached run was answering. Tree navigation passes no `sequence`: it stays in the same
 * session, so queued input and the post-change refresh are untouched, as in RPC.
 */
async function changeSession<T extends { cancelled: boolean }>(
	ctx: CommandContext,
	sequence: number | undefined,
	change: () => Promise<T>,
	detachesRun: (result: T | undefined) => boolean = () => false,
): Promise<T> {
	const state = prompting(ctx);
	await settleToolsBeforeSessionChange(ctx.session);
	await state.goals.beginSessionChange();
	let result: T | undefined;
	let detached = false;
	try {
		result = await change();
	} finally {
		// A change that throws may already have detached the run: count it as detached.
		detached = detachesRun(result);
		await state.goals.endSessionChange({ detachedRun: detached });
		// Respond only once this change's reattach (and any queued ahead of it) has run.
		await state.goals.settled();
	}
	if (!result.cancelled && sequence !== undefined) {
		state.invalidateBefore(sequence);
		if (detached) state.results.abortOpen();
		await afterSessionChange(ctx.session);
	}
	return result;
}

const DEFAULT_MESSAGE_PAGE_LIMIT = 100;
const MAX_MESSAGE_PAGE_LIMIT = 256;
// Bounds one page so a run of large tool outputs never becomes one huge frame.
const MAX_MESSAGE_PAGE_BYTES = 768 * 1024;
const MAX_MESSAGE_CURSOR_CHARS = 2048;

/** The transcript a cursor pages; any change (new message, branch, other session) makes it stale. */
interface MessageSnapshot {
	sessionId: string;
	leafId: string | null;
	messageCount: number;
}

function encodeCursor(snapshot: MessageSnapshot, offset: number): string {
	return Buffer.from(JSON.stringify({ version: 1, ...snapshot, offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): MessageSnapshot & { offset: number } {
	const invalid = new Error("Invalid message cursor");
	if (cursor.length === 0 || cursor.length > MAX_MESSAGE_CURSOR_CHARS || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid;
	const bytes = Buffer.from(cursor, "base64url");
	if (bytes.toString("base64url") !== cursor) throw invalid;
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw invalid;
	}
	if (!isRecord(value)) throw invalid;
	const { version, sessionId, leafId, messageCount, offset } = value;
	if (
		version !== 1 ||
		typeof sessionId !== "string" ||
		sessionId.length === 0 ||
		sessionId.length > 256 ||
		!((typeof leafId === "string" && leafId.length > 0 && leafId.length <= 256) || leafId === null) ||
		typeof messageCount !== "number" ||
		!Number.isSafeInteger(messageCount) ||
		messageCount < 0 ||
		typeof offset !== "number" ||
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		offset > messageCount
	)
		throw invalid;
	return { sessionId, leafId, messageCount, offset };
}

/** One page of the in-memory transcript, from `cursor` on, bounded by `limit` messages and the byte budget. */
function pageMessages(session: AgentSession, cursor: string | undefined, limit = DEFAULT_MESSAGE_PAGE_LIMIT) {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MESSAGE_PAGE_LIMIT) {
		throw new Error(`Message page limit must be between 1 and ${MAX_MESSAGE_PAGE_LIMIT}`);
	}
	const messages = session.messages;
	const snapshot: MessageSnapshot = {
		sessionId: session.sessionId,
		leafId: session.sessionManager.getLeafId(),
		messageCount: messages.length,
	};
	let offset = 0;
	if (cursor !== undefined) {
		const decoded = decodeCursor(cursor);
		if (
			decoded.sessionId !== snapshot.sessionId ||
			decoded.leafId !== snapshot.leafId ||
			decoded.messageCount !== snapshot.messageCount
		) {
			throw new CommandError("Message cursor is stale", "stale_cursor");
		}
		offset = decoded.offset;
	}
	const page: typeof messages = [];
	let pageBytes = 2;
	while (offset + page.length < messages.length && page.length < limit) {
		const message = messages[offset + page.length];
		const messageBytes = Buffer.byteLength(JSON.stringify(message), "utf8") + (page.length === 0 ? 0 : 1);
		if (page.length > 0 && pageBytes + messageBytes > MAX_MESSAGE_PAGE_BYTES) break;
		page.push(message);
		pageBytes += messageBytes;
	}
	const nextOffset = offset + page.length;
	return {
		messages: page,
		...(nextOffset < messages.length ? { nextCursor: encodeCursor(snapshot, nextOffset) } : {}),
		totalMessages: messages.length,
	};
}

/** new_session and switch_session detach a live run unless they were cancelled. */
const detachesUnlessCancelled = (result: { cancelled: boolean } | undefined) => result?.cancelled !== true;

/**
 * Send `{t:"session", …}` whenever `session` moves to another session file: `/new`, `/resume`,
 * fork, branch, open_session, or a write that relocates a contended file, whoever triggered it.
 */
export function watchSessionIdentity(session: AgentSession, send: CommandContext["send"]): () => void {
	let sent = `${session.sessionId}\0${session.sessionFile ?? ""}`;
	const check = () => {
		const now = `${session.sessionId}\0${session.sessionFile ?? ""}`;
		if (now === sent) return;
		sent = now;
		send({ t: "session", sessionId: session.sessionId, sessionFile: session.sessionFile, cwd: session.sessionManager.getCwd() });
	};
	const offChange = session.registerSessionChangeCallback(check);
	// Relocation off a contended file changes the id without an AgentSession transition.
	const offMove = session.sessionManager.onPersistenceNotice(check);
	return () => {
		offChange();
		offMove();
	};
}

export const sessionCommands: CommandTable = {
	async new_session(ctx, args) {
		const sequence = prompting(ctx).accept();
		const parentSession = optionalString("new_session", args, "parentSession");
		return changeSession(
			ctx,
			sequence,
			async () => ({ cancelled: !(await ctx.session.newSession(parentSession ? { parentSession } : undefined)) }),
			detachesUnlessCancelled,
		);
	},
	async switch_session(ctx, args) {
		const sequence = prompting(ctx).accept();
		const { session } = ctx;
		const sessionPath = requiredString("switch_session", args, "sessionPath");
		const model = await requestedModel("switch_session", session, args);
		return changeSession(
			ctx,
			sequence,
			async () => ({ cancelled: !(await session.switchSession(sessionPath, model ? { model } : undefined)) }),
			detachesUnlessCancelled,
		);
	},
	/**
	 * Continue the newest non-empty session in `sessionDir`, or start one there: `--session-dir
	 * <dir> --continue` at runtime. Reopening the active session is a no-op and leaves a live run going.
	 */
	async open_session(ctx, args) {
		const sequence = prompting(ctx).accept();
		const { session } = ctx;
		const sessionDir = requiredString("open_session", args, "sessionDir");
		const model = await requestedModel("open_session", session, args);
		const fileBeforeOpen = session.sessionFile;
		return changeSession(
			ctx,
			sequence,
			async () => {
				if (!session.sessionFile) throw new Error("open_session requires session persistence (omit --no-session)");
				const dir = path.resolve(sessionDir);
				const recent = await findMostRecentNonEmptySession(dir);
				const latest = recent ? ((await findRecentSessionContinuation(recent))?.session.path ?? recent) : null;
				const current = path.resolve(session.sessionFile);
				const alreadyOpen = latest
					? current === path.resolve(latest)
					: path.dirname(current) === dir && session.messages.length === 0;
				let cancelled = false;
				if (!alreadyOpen) {
					cancelled = latest
						? !(await session.switchSession(latest, model ? { model } : undefined))
						: !(await session.newSession({ sessionDir: dir }));
				}
				// A resumed session is bound to the model by the switch; an already-open or fresh one selects it.
				if (!cancelled && model && !modelsAreEqual(session.model, model)) await session.setModel(model);
				return { cancelled, resumed: !cancelled && latest !== null, sessionId: session.sessionId, sessionFile: session.sessionFile };
			},
			// Any real open changes the file, even when an aliased path reopens a transcript with the same id.
			() => session.sessionFile !== fileBeforeOpen,
		);
	},
	async fork(ctx, args) {
		const sequence = prompting(ctx).accept();
		const { session } = ctx;
		const entryId = optionalString("fork", args, "entryId");
		// A fork is a snapshot: refuse while work could still write into the transcript.
		if (session.isBusyForSnapshot) throw new CommandError(new SessionBusyError("fork the session").message, "session_busy");
		// Fork switches files in-process without detaching a run (it requires idle).
		return changeSession(ctx, sequence, async () => ({
			cancelled: !(await session.fork(entryId, { requireIdle: true }).catch(rethrowBusy)),
		}));
	},
	async branch(ctx, args) {
		const sequence = prompting(ctx).accept();
		const entryId = requiredString("branch", args, "entryId");
		// A live run keeps streaming to its normal end.
		const result = await changeSession(ctx, sequence, () => ctx.session.branch(entryId));
		return { text: result.selectedText, cancelled: result.cancelled };
	},
	async navigate_tree(ctx, args) {
		const { session } = ctx;
		const entryId = requiredString("navigate_tree", args, "entryId");
		const customInstructions = optionalString("navigate_tree", args, "customInstructions");
		if (!session.sessionManager.getEntry(entryId)) throw new CommandError(`Entry ${entryId} not found`, "entry_not_found");
		// As `fork`: a run would keep writing into the branch the leaf just left.
		if (session.isBusyForSnapshot) {
			throw new CommandError(new SessionBusyError("navigate the session tree").message, "session_busy");
		}
		const result = await changeSession(ctx, undefined, () =>
			session
				.navigateTree(entryId, {
					summarize: args.summarize === true,
					customInstructions,
					// Only to detect a re-answer, which moves nothing yet: refused below, since it needs a picker.
					allowAskReopen: true,
					requireIdle: true,
				})
				.catch(rethrowBusy),
		);
		if (result.reopenAsk) {
			throw new CommandError("Re-answering an ask is not available over RPC; select another entry", "ask_reanswer_unsupported");
		}
		return { cancelled: result.cancelled, aborted: result.aborted, editorText: result.editorText };
	},
	/**
	 * Move the leaf to just before a user message so the host can resend an edited version; the old
	 * branch stays in the tree. Formerly ompweb's `omp-web-edit` extension command.
	 */
	async edit_message(ctx, args) {
		const { session } = ctx;
		const entryId = requiredString("edit_message", args, "entryId");
		if (session.isBusyForSnapshot || session.hasPendingAsyncWork()) {
			throw new CommandError("Cannot edit while the agent is running", "session_busy");
		}
		const entry = session.sessionManager.getEntry(entryId);
		if (entry?.type !== "message" || entry.message.role !== "user") throw new Error("The edit target must be a user message");
		const sessionId = session.sessionId;
		const result = await changeSession(ctx, undefined, () => session.navigateTree(entryId, { summarize: false }));
		if (session.sessionId !== sessionId) throw new Error("The session changed while editing history");
		// Navigation selects the target's parent; this non-message entry persists that leaf without adding context.
		if (!result.cancelled) session.sessionManager.appendCustomEntry("omp-web-history-navigation", { entryId });
		return { sessionId: session.sessionId, cancelled: result.cancelled, leafId: session.sessionManager.getLeafId() };
	},
	async abort_branch_summary({ session }) {
		session.abortBranchSummary();
		return undefined;
	},
	async get_tree({ session }) {
		return { tree: session.sessionManager.getTree(), leafId: session.sessionManager.getLeafId() };
	},
	async get_entries({ session }, args) {
		const since = optionalString("get_entries", args, "since");
		const entries = session.sessionManager.getEntries();
		const leafId = session.sessionManager.getLeafId();
		if (since === undefined) return { entries, leafId };
		const index = entries.findIndex(entry => entry.id === since);
		if (index === -1) throw new CommandError(`Unknown entries cursor: ${since}`, "unknown_since");
		return { entries: entries.slice(index + 1), leafId };
	},
	async get_messages({ session }) {
		return { messages: session.messages };
	},
	async get_messages_page({ session }, args) {
		const cursor = optionalString("get_messages_page", args, "cursor");
		const { limit } = args;
		if (limit !== undefined && typeof limit !== "number") throw new Error("get_messages_page: limit must be a number");
		if (session.isStreaming || session.isCompacting) {
			throw new CommandError("Cannot page messages while the session is changing", "session_busy");
		}
		return pageMessages(session, cursor, limit);
	},
	async get_branch_messages({ session }) {
		return { messages: session.getUserMessagesForBranching() };
	},
	async get_last_assistant_text({ session }) {
		return { text: session.getLastAssistantText() };
	},
	async set_session_name({ session }, args) {
		const name = requiredString("set_session_name", args, "name").trim();
		if (!name || !(await session.setSessionName(name, "user"))) throw new Error("Session name cannot be empty");
		return undefined;
	},
	async set_label({ session }, args) {
		const entryId = requiredString("set_label", args, "entryId");
		session.sessionManager.appendLabelChange(entryId, optionalString("set_label", args, "label"));
		return undefined;
	},
	async export_html({ session }, args) {
		return { path: await session.exportToHtml(optionalString("export_html", args, "outputPath")) };
	},
	async get_session_lease(_ctx, args) {
		const { sessionIds } = args;
		if (!Array.isArray(sessionIds) || !sessionIds.every(id => typeof id === "string")) {
			throw new Error("get_session_lease: sessionIds must be an array of strings");
		}
		return probeSessionLeases(sessionIds);
	},
};

export const sessionFrames: FrameTable = {};
