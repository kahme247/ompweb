import { afterEach, describe, expect, it } from "bun:test";
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
		const types = host.frames.map(eventType).filter(Boolean);
		expect(types[0]).toBe("agent_start");
		expect(types).toContain("message_end");
		expect(JSON.stringify(end)).toContain("scripted reply");
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
});
