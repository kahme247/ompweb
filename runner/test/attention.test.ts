import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { ATTENTION_ENTRY_TYPE, ATTENTION_REASON_MAX } from "../src/attention";
import { createTestSession, type TestSession } from "./harness";

let test: TestSession | undefined;

afterEach(async () => {
	await test?.dispose();
	test = undefined;
});

const toolCall = { type: "toolCall" as const, name: "request_attention" };

describe("request_attention", () => {
	it("is in the model's tool list and appends the trimmed, capped reason as the marker entry", async () => {
		// No host listens here: the session's channel stays closed.
		process.env.OMPWEB_HOST_SOCKET = path.join(os.tmpdir(), `ompweb-attention-test-${process.pid}.sock`);
		test = await createTestSession({
			responses: [
				{ content: [{ ...toolCall, arguments: { reason: "  Pick\n a   color  " } }] },
				{ content: ["waiting"] },
				{ content: [{ ...toolCall, arguments: { reason: "x".repeat(ATTENTION_REASON_MAX + 50) } }] },
				{ content: ["waiting again"] },
			],
		});
		const { session, mock } = test;
		const markers = () =>
			session.sessionManager
				.getEntries()
				.flatMap(entry => (entry.type === "custom" && entry.customType === ATTENTION_ENTRY_TYPE ? [entry.data] : []));

		await session.prompt("pick one");
		await session.waitForIdle();
		// The harness passes an explicit (empty) tool list, as `--tools`/`--no-tools` do: the tool still reaches the model.
		expect(mock.calls[0]?.context.tools?.map(tool => tool.name)).toContain("request_attention");
		expect(markers()).toEqual([{ reason: "Pick a color" }]);

		await session.prompt("and again");
		await session.waitForIdle();
		expect(markers()).toEqual([{ reason: "Pick a color" }, { reason: "x".repeat(ATTENTION_REASON_MAX) }]);
	});
});
