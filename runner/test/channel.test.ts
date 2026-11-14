import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager, type SessionPersistenceNotice } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { isRecord } from "@oh-my-pi/pi-utils";
import { HostChannel } from "../src/channel";
import { createTestSession, type Frame, startHost, type TestHost, type TestSession } from "./harness";

let host: TestHost | undefined;
let test: TestSession | undefined;

afterEach(async () => {
	await test?.dispose();
	host?.close();
	test = undefined;
	host = undefined;
});

const eventType = (frame: Frame) => {
	const event = frame.event;
	return frame.t === "event" && typeof event === "object" && event !== null && "type" in event ? event.type : undefined;
};

const FORM = '<form><label>Name <input name="q"></label></form>';

/** A session whose first reply calls `ask` (a formDialog) and whose second ends the run. */
const askSession = (ui?: Partial<ExtensionUIContext>) =>
	createTestSession({
		toolNames: ["ask"],
		responses: [{ content: [{ type: "toolCall", name: "ask", arguments: { html: FORM } }] }, { content: ["done"] }],
		ui,
	});

describe("ompweb channel", () => {
	it("says hello and answers get_state", async () => {
		host = await startHost();
		test = await createTestSession();
		const hello = await host.connected;
		expect(hello).toMatchObject({ proto: 1, sessionId: test.session.sessionId });

		const res = await host.command("get_state");
		expect(res).toMatchObject({
			ok: true,
			data: { sessionId: test.session.sessionId, model: { provider: "mock", id: "mock-model" }, isStreaming: false },
		});
	});

	it("rejects unknown commands and unknown models", async () => {
		host = await startHost();
		test = await createTestSession();
		await host.connected;

		expect(await host.command("no_such_op")).toMatchObject({ ok: false, error: "unknown command: no_such_op" });
		expect(await host.command("set_model", { provider: "nope", modelId: "nothing" })).toMatchObject({
			ok: false,
			error: "Model not found: nope/nothing",
		});
		expect(await host.command("set_model", { provider: 1 })).toMatchObject({ ok: false });
	});

	it("streams a prompt's run from agent_start to agent_end", async () => {
		host = await startHost();
		test = await createTestSession({ responses: [{ content: ["scripted reply"] }] });
		await host.connected;

		expect(await host.command("prompt", { message: "hello" })).toMatchObject({ ok: true });
		const end = await host.waitFor(frame => eventType(frame) === "agent_end");
		// `available_commands_update` comes from an async subscription and may land first.
		const types = host.frames.map(eventType).filter(type => type && type !== "available_commands_update");
		expect(types[0]).toBe("agent_start");
		expect(types).toContain("message_end");
		expect(JSON.stringify(end)).toContain("scripted reply");
	});

	it("identifies an image-only prompt using the capability negotiated by get_state", async () => {
		host = await startHost();
		test = await createTestSession({ responses: [{ content: ["received"] }] });
		await host.connected;
		const state = await host.command("get_state");
		const supportsIds = isRecord(state.data) && state.data.supportsClientMessageIds === true;
		expect(await host.command("prompt", {
			message: "",
			images: [{
				type: "image",
				data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5S8AAAAASUVORK5CYII=",
				mimeType: "image/png",
			}],
			...(supportsIds ? { clientMessageId: "screenshot-intent" } : {}),
		})).toMatchObject({ ok: true });
		const echo = await host.waitFor(frame => eventType(frame) === "message_end"
			&& isRecord(frame.event) && isRecord(frame.event.message) && frame.event.message.role === "user");
		expect(echo.event).toMatchObject({ clientMessageId: "screenshot-intent" });
		await host.waitFor(frame => eventType(frame) === "agent_end");
		expect(await host.command("get_client_message_status", { clientMessageIds: ["screenshot-intent"] }))
			.toMatchObject({ ok: true, data: { persistedClientMessageIds: ["screenshot-intent"], unresolvedClientMessageIds: [] } });
	});

	it("keeps correlated queue IDs in get_state for a reconnecting host", async () => {
		host = await startHost();
		test = await askSession();
		await host.connected;
		await host.command("prompt", { message: "start" });
		const request = await host.waitFor(frame => frame.t === "ui_request");
		await host.command("follow_up", { message: "later", clientMessageId: "queued-intent" });
		// The mock model records circular call contexts; real model descriptors have no call log.
		test.mock.calls.length = 0;
		expect(await host.command("get_state")).toMatchObject({
			ok: true,
			data: { queuedMessages: { followUp: ["later"], clientMessageIds: { steering: [], followUp: ["queued-intent"] } } },
		});
		await host.command("remove_queued_message", { message: "later", queue: "followUp" });
		host.send({ t: "ui_response", id: request.id, value: { data: { q: "continue" } } });
		await test.session.waitForIdle();
	});

	it("lets the host answer the ask tool's formDialog", async () => {
		const html = '<form><label>Name <input name="q"></label></form>';
		host = await startHost();
		test = await createTestSession({
			toolNames: ["ask"],
			responses: [{ content: [{ type: "toolCall", name: "ask", arguments: { html } }] }, { content: ["done"] }],
		});
		await host.connected;

		await host.command("prompt", { message: "ask me" });
		const request = await host.waitFor(frame => frame.t === "ui_request");
		expect(request).toMatchObject({ method: "formDialog", args: [html, {}] });

		host.send({ t: "ui_response", id: request.id, value: { data: { q: "from host" } } });
		const end = await host.waitFor(frame => eventType(frame) === "tool_execution_end");
		expect(end.event).toMatchObject({ toolName: "ask", isError: false });
		expect(JSON.stringify(end.event)).toContain("from host");
		await host.waitFor(frame => eventType(frame) === "agent_end");
		expect(host.frames.some(frame => frame.t === "ui_end")).toBe(false);
	});

	it("closes the TUI's dialog when the host answers", async () => {
		let localSignal: AbortSignal | undefined;
		host = await startHost();
		test = await askSession({
			formDialog: (_html, options) => {
				localSignal = options?.signal;
				return new Promise(() => {});
			},
		});
		await host.connected;

		await host.command("prompt", { message: "ask me" });
		const request = await host.waitFor(frame => frame.t === "ui_request");
		host.send({ t: "ui_response", id: request.id, value: { data: { q: "from host" } } });
		await host.waitFor(frame => eventType(frame) === "agent_end");
		expect(localSignal?.aborted).toBe(true);
	});

	it("tells the host when the TUI answers", async () => {
		host = await startHost();
		test = await askSession({ formDialog: async () => ({ data: { q: "from tui" } }) });
		await host.connected;

		await host.command("prompt", { message: "ask me" });
		const request = await host.waitFor(frame => frame.t === "ui_request");
		await host.waitFor(frame => frame.t === "ui_end" && frame.id === request.id);
		const end = await host.waitFor(frame => eventType(frame) === "tool_execution_end");
		expect(JSON.stringify(end.event)).toContain("from tui");
	});

	it("tells the host when the TUI's dialog fails", async () => {
		host = await startHost();
		test = await askSession({ formDialog: async () => Promise.reject(new Error("tui gone")) });
		await host.connected;

		await host.command("prompt", { message: "ask me" });
		const request = await host.waitFor(frame => frame.t === "ui_request");
		await host.waitFor(frame => frame.t === "ui_end" && frame.id === request.id);
	});

	it("re-sends an open dialog to a redialled host", async () => {
		host = await startHost();
		test = await askSession();
		const hello = await host.connected;

		await host.command("prompt", { message: "ask me" });
		const request = await host.waitFor(frame => frame.t === "ui_request");
		host.drop();
		await host.waitFor(frame => frame.t === "hello" && frame !== hello);
		const again = await host.waitFor(frame => frame.t === "ui_request" && frame !== request);
		expect(again).toMatchObject({ id: request.id, method: "formDialog" });

		host.send({ t: "ui_response", id: request.id, value: { data: { q: "after redial" } } });
		const end = await host.waitFor(frame => eventType(frame) === "tool_execution_end");
		expect(JSON.stringify(end.event)).toContain("after redial");
	});

	it("stops redialling once the host refuses", async () => {
		host = await startHost();
		test = await createTestSession();
		await host.connected;

		host.send({ t: "refused", reason: "session live elsewhere" });
		host.drop();
		// Proving an absence: wait out one real redial interval (2 s) of the channel's own timer.
		await Bun.sleep(2_500);
		expect(host.frames.filter(frame => frame.t === "hello")).toHaveLength(1);
	});

	it("sends a relocation's notice before the moved session's identity", async () => {
		// An in-memory session never relocates; capture the persistence-notice observers to raise one by hand.
		const observers: ((notice: SessionPersistenceNotice) => void)[] = [];
		const subscribe = SessionManager.prototype.onPersistenceNotice;
		SessionManager.prototype.onPersistenceNotice = function (cb) {
			observers.push(cb);
			return subscribe.call(this, cb);
		};
		try {
			host = await startHost();
			test = await createTestSession();
			await host.connected;
		} finally {
			SessionManager.prototype.onPersistenceNotice = subscribe;
		}
		const to = path.join(os.tmpdir(), "moved.jsonl");
		test.session.sessionManager.getSessionFile = () => to;
		for (const observer of observers) observer({ reason: "open-elsewhere", from: "/elsewhere/original.jsonl", to });

		const identity = await host.waitFor(frame => frame.t === "session");
		expect(identity).toMatchObject({ sessionFile: to });
		const notice = host.frames.findIndex(frame => eventType(frame) === "notice");
		expect(notice).toBeGreaterThanOrEqual(0);
		expect(notice).toBeLessThan(host.frames.indexOf(identity));
	});

	it("does not dial a socket in a directory others can write", async () => {
		host = await startHost();
		fs.chmodSync(path.dirname(process.env.OMPWEB_HOST_SOCKET ?? ""), 0o777);
		test = await createTestSession();
		// Proving an absence: a dial would have said hello well within this.
		await Bun.sleep(300);
		expect(host.frames).toHaveLength(0);
	});
});

describe("headless dialogs", () => {
	/** A stdio channel on `session`, as `headless.ts` serves it. */
	function stdio(session: AgentSession) {
		const lines: Frame[] = [];
		const channel = HostChannel.stdio(session, undefined, line => lines.push(JSON.parse(line) as Frame));
		const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
		const writer = writable.getWriter();
		void channel.read(readable.getReader());
		const send = (frame: Frame) => writer.write(new TextEncoder().encode(`${JSON.stringify(frame)}\n`));
		const ends = () => lines.filter(frame => frame.t === "ui_end").map(frame => frame.id);
		return { channel, lines, send, ends, close: () => writer.close() };
	}
	const requestOf = (lines: Frame[]) => lines.find(frame => frame.t === "ui_request");

	it("returns the host's answer", async () => {
		test = await createTestSession();
		const io = stdio(test.session);
		const answer = io.channel.dialog("confirm", ["T", "M"], () => false);
		await io.send({ t: "ui_response", id: requestOf(io.lines)?.id, value: true });
		expect(await answer).toBe(true);
		expect(io.ends()).toEqual([]);
	});

	it("closes on abort with the fallback and tells the host", async () => {
		test = await createTestSession();
		const io = stdio(test.session);
		const abort = new AbortController();
		const answer = io.channel.dialog("confirm", ["T", "M", { signal: abort.signal }], timedOut => `fallback ${timedOut}`);
		const request = requestOf(io.lines);
		expect(request?.args).toEqual(["T", "M", {}]);
		abort.abort();
		expect(await answer).toBe("fallback false");
		expect(io.ends()).toEqual([request?.id]);
	});

	it("closes on timeout with the fallback and tells the host", async () => {
		test = await createTestSession();
		const io = stdio(test.session);
		let timedOutCalls = 0;
		const answer = io.channel.dialog("confirm", ["T", "M", { timeout: 20, onTimeout: () => timedOutCalls++ }], timedOut => `fallback ${timedOut}`);
		expect(await answer).toBe("fallback true");
		expect(timedOutCalls).toBe(1);
		expect(io.ends()).toEqual([requestOf(io.lines)?.id]);
	});

	it("falls back when the host goes away", async () => {
		test = await createTestSession();
		const io = stdio(test.session);
		const answer = io.channel.dialog("confirm", ["T", "M"], timedOut => `fallback ${timedOut}`);
		await io.close();
		expect(await answer).toBe("fallback false");
		expect(io.ends()).toEqual([]);
	});
});

describe("edit_message", () => {
	async function settledSession() {
		host = await startHost();
		test = await createTestSession({ responses: [{ content: ["first reply"] }] });
		await host.connected;
		await host.command("prompt", { message: "first" });
		await host.waitFor(frame => eventType(frame) === "agent_end");
		await test.session.waitForIdle();
		const entries = test.session.sessionManager.getEntries();
		const user = entries.find(entry => entry.type === "message" && entry.message.role === "user");
		const assistant = entries.find(entry => entry.type === "message" && entry.message.role === "assistant");
		if (!user || !assistant) throw new Error("the run left no user or assistant message");
		return { user, assistant };
	}

	it("moves the leaf before a user message and records the navigation", async () => {
		const { user } = await settledSession();
		const res = await host?.command("edit_message", { entryId: user.id });
		const leafId = test?.session.sessionManager.getLeafId();
		expect(res).toMatchObject({ ok: true, data: { sessionId: test?.session.sessionId, cancelled: false, leafId } });
		const leaf = test?.session.sessionManager.getEntry(leafId ?? "");
		expect(leaf).toMatchObject({ type: "custom", customType: "omp-web-history-navigation", data: { entryId: user.id } });
		expect(leaf?.parentId).toBe(user.parentId);
	});

	it("refuses a target that is not a user message", async () => {
		const { assistant } = await settledSession();
		const leafBefore = test?.session.sessionManager.getLeafId();
		for (const entryId of [assistant.id, "no-such-entry"]) {
			expect(await host?.command("edit_message", { entryId })).toMatchObject({
				ok: false,
				error: "The edit target must be a user message",
			});
		}
		expect(test?.session.sessionManager.getLeafId()).toBe(leafBefore);
	});

	it("refuses while a run is in flight", async () => {
		host = await startHost();
		test = await askSession();
		await host.connected;
		await host.command("prompt", { message: "ask me" });
		const request = await host.waitFor(frame => frame.t === "ui_request");
		const user = test.session.sessionManager
			.getEntries()
			.find(entry => entry.type === "message" && entry.message.role === "user");
		expect(await host.command("edit_message", { entryId: user?.id })).toMatchObject({ ok: false, code: "session_busy" });
		host.send({ t: "ui_response", id: request.id, value: { data: { q: "done" } } });
		await host.waitFor(frame => eventType(frame) === "agent_end");
	});
});
