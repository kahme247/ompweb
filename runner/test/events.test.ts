import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { eventsCommands, subscribeHostEvents } from "../src/events";
import { createTestSession, type Frame, type TestSession } from "./harness";

let test: TestSession | undefined;
let unsubscribe: (() => void) | undefined;

afterEach(async () => {
	unsubscribe?.();
	await test?.dispose();
	test = undefined;
	unsubscribe = undefined;
});

type Event = { type: string } & Record<string, unknown>;

async function bridged(responses: { content: string[] }[] = []) {
	// No host listens here: the session's own channel stays closed and only this bridge reports.
	process.env.OMPWEB_HOST_SOCKET = path.join(os.tmpdir(), `ompweb-events-test-${process.pid}.sock`);
	test = await createTestSession({ responses });
	const session = test.session;
	const events: Event[] = [];
	const waiters = new Map<string, () => void>();
	const send = (frame: Frame) => {
		expect(frame.t).toBe("event");
		const event = frame.event as Event;
		events.push(event);
		waiters.get(event.type)?.();
	};
	const waitFor = (type: string) => {
		const { promise, resolve } = Promise.withResolvers<void>();
		if (events.some(event => event.type === type)) resolve();
		else waiters.set(type, resolve);
		return promise;
	};
	unsubscribe = subscribeHostEvents(session, send);
	const filter = (args: Record<string, unknown>) => eventsCommands.set_event_filter({ session, send }, args);
	return { session, events, waitFor, filter };
}

describe("host events bridge", () => {
	it("stamps message ids, sends deltas by default, and settles after the run", async () => {
		const { session, events, waitFor } = await bridged([{ content: ["scripted reply"] }]);
		await session.prompt("hello");
		await waitFor("session_settled");
		await waitFor("available_commands_update");

		const types = events.map(event => event.type);
		expect(types.indexOf("session_settled")).toBeGreaterThan(types.lastIndexOf("agent_end"));

		const assistantEnd = events.find(event => event.type === "message_end" && JSON.stringify(event).includes("scripted reply"));
		const updates = events.filter(event => event.type === "message_update");
		expect(updates.length).toBeGreaterThan(0);
		for (const update of updates) {
			expect(update).toMatchObject({ messageId: assistantEnd?.messageId, message: { role: "assistant" } });
			expect(Object.keys(update.message as object)).toEqual(["role"]);
		}
		expect(JSON.stringify(updates)).not.toContain('"partial"');
	});

	it("sends the whole partial in full mode and validates the filter", async () => {
		const { session, events, waitFor, filter } = await bridged([{ content: ["full reply"] }]);
		expect(await filter({ events: null, messageUpdates: "full" })).toEqual({ events: null, messageUpdates: "full" });
		await expect(filter({ events: [""], messageUpdates: "full" })).rejects.toThrow("events must be null");
		await expect(filter({ events: null, messageUpdates: "some" })).rejects.toThrow("messageUpdates");

		await session.prompt("hello");
		await waitFor("agent_end");
		expect(events.find(event => event.type === "message_update")).toMatchObject({
			message: { role: "assistant", content: expect.any(Array) },
		});
	});

	it("reports session renames", async () => {
		const { session, events, waitFor } = await bridged();
		session.sessionManager.setSessionName("renamed", "user");
		await waitFor("session_info_update");
		expect(events.find(event => event.type === "session_info_update")).toMatchObject({
			title: "renamed",
			sessionId: session.sessionId,
		});
	});
});
