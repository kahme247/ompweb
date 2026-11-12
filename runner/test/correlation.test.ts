import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { isRecord } from "@oh-my-pi/pi-utils";
import {
	CLIENT_MESSAGE_ENTRY_CUSTOM_TYPE,
	claimClientMessage,
	getClientMessageStatus,
	onClientQueueChange,
	stampClientMessageId,
	submitCorrelated,
} from "../src/correlation";
import { createTestSession, type TestSession } from "./harness";

let test: TestSession | undefined;

afterEach(async () => {
	await test?.dispose();
	test = undefined;
});

type Stamped = AgentSessionEvent & { clientMessageId?: string; clientMessageIds?: unknown };

// The scripted model's `delayMs` keeps the first run streaming while input is queued behind it.
async function correlated(responses: { content: string[]; delayMs?: number }[]) {
	process.env.OMPWEB_HOST_SOCKET = path.join(os.tmpdir(), `ompweb-correlation-test-${process.pid}.sock`);
	test = await createTestSession({ responses });
	const session = test.session;
	const events: Stamped[] = [];
	const started = Promise.withResolvers<void>();
	session.subscribe(event => {
		events.push(stampClientMessageId(session, event));
		if (event.type === "agent_start") started.resolve();
	});
	onClientQueueChange(session, event => events.push(event));
	return { session, events, started: started.promise };
}

const userEnds = (events: Stamped[]) =>
	events.flatMap(event =>
		event.type === "message_end" && event.message.role === "user" ? [{ id: event.clientMessageId, message: event.message }] : [],
	);

describe("client message correlation", () => {
	it("stamps an idle prompt, journals its entry, reports it persisted and rejects reuse", async () => {
		const { session, events } = await correlated([{ content: ["first"] }, { content: ["second"] }]);
		const claim = claimClientMessage(session, "intent-1");
		await submitCorrelated(claim, undefined, hooks => session.prompt("same text", hooks), true);
		await session.prompt("same text");

		const ends = userEnds(events);
		expect(ends.map(end => end.id)).toEqual(["intent-1", undefined]);
		const start = events.find(event => event.type === "message_start" && event.message.role === "user");
		expect(start?.clientMessageId).toBe("intent-1");

		const status = await getClientMessageStatus(session, ["intent-1", "unknown"]);
		expect(status.persistedClientMessageIds).toEqual(["intent-1"]);
		expect(status.messages.map(item => item.clientMessageId)).toEqual(["intent-1"]);
		expect(status.unresolvedClientMessageIds).toEqual(["unknown"]);

		const entries = session.sessionManager.getEntries();
		const link = entries.find(entry => entry.type === "custom" && entry.customType === CLIENT_MESSAGE_ENTRY_CUSTOM_TYPE);
		const data = link?.type === "custom" && isRecord(link.data) ? link.data : undefined;
		const target = entries.find(entry => entry.id === data?.entryId);
		expect(data?.clientMessageId).toBe("intent-1");
		expect(target?.type === "message" && target.message === ends[0]?.message).toBe(true);
		// The model never sees the ID.
		expect(JSON.stringify(session.messages)).not.toContain("intent-1");

		expect(() => claimClientMessage(session, "intent-1")).toThrow("already submitted");
		expect(() => claimClientMessage(session, "")).toThrow("nonempty");
	});

	it("aligns a queued follow-up's ID in an identity-only queue_update, then on its delivery", async () => {
		const { session, events, started } = await correlated([{ content: ["busy"], delayMs: 200 }, { content: ["after"] }]);
		const run = session.prompt("start");
		await started;
		const claim = claimClientMessage(session, "queued-1");
		await submitCorrelated(claim, undefined, hooks => session.followUp("later", undefined, hooks));

		const updates = events.filter(event => event.type === "queue_update");
		expect(updates.at(-1)).toMatchObject({ followUp: ["later"], clientMessageIds: { steering: [], followUp: ["queued-1"] } });
		const status = await getClientMessageStatus(session, ["queued-1"]);
		expect(status.queuedMessages.clientMessageIds?.followUp).toEqual(["queued-1"]);
		expect(status.unresolvedClientMessageIds).toEqual([]);

		await run;
		await session.waitForIdle();
		expect(userEnds(events).map(end => end.id)).toEqual([undefined, "queued-1"]);
		expect((await getClientMessageStatus(session, ["queued-1"])).persistedClientMessageIds).toEqual(["queued-1"]);
	});

	it("journals a withdrawn queued message as resolved", async () => {
		const { session, started } = await correlated([{ content: ["busy"], delayMs: 200 }]);
		const run = session.prompt("start");
		await started;
		const claim = claimClientMessage(session, "withdrawn-1");
		await submitCorrelated(claim, undefined, hooks => session.followUp("take me back", undefined, hooks));
		expect(session.removeQueuedMessage("take me back", "followUp")).toBe(true);

		const status = await getClientMessageStatus(session, ["withdrawn-1"]);
		expect(status.resolvedClientMessageIds).toEqual(["withdrawn-1"]);
		expect(status.unresolvedClientMessageIds).toEqual([]);
		expect(() => claimClientMessage(session, "withdrawn-1")).toThrow("already resolved");
		await run;
	});

	it("frees a released ID and resolves a locally consumed one", async () => {
		const { session } = await correlated([]);
		claimClientMessage(session, "cancelled")?.release();
		claimClientMessage(session, "consumed")?.consumed();
		const status = await getClientMessageStatus(session, ["cancelled", "consumed"]);
		expect(status.resolvedClientMessageIds).toEqual(["consumed"]);
		expect(status.unresolvedClientMessageIds).toEqual(["cancelled"]);
		expect(claimClientMessage(session, "cancelled")?.id).toBe("cancelled");
	});
});
