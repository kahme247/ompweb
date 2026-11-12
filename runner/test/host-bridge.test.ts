import { describe, expect, it } from "bun:test";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { HostToolBridge, HostUriBridge } from "../src/host-bridge";

type Frame = { t: string } & Record<string, unknown>;

function recorder() {
	const frames: Frame[] = [];
	return { frames, send: (frame: Frame) => frames.push(frame) };
}

const definition = { name: "echo", label: "echo", description: "Echo", parameters: { type: "object" }, hidden: false, loadMode: "discoverable" as const };

describe("HostToolBridge", () => {
	it("runs calls on the host, streams updates, and settles on the result", async () => {
		const { frames, send } = recorder();
		const bridge = new HostToolBridge(send);
		const [tool] = bridge.tools([definition]);
		const updates: unknown[] = [];
		const call = tool.execute("tc1", { a: 1 }, undefined, update => updates.push(update));
		expect(frames[0]).toMatchObject({ t: "host_tool_call", toolCallId: "tc1", toolName: "echo", arguments: { a: 1 } });
		const id = frames[0].id;
		bridge.update({ t: "host_tool_update", id, partialResult: { content: [] } });
		bridge.result({ t: "host_tool_result", id, result: { content: [{ type: "text", text: "ok" }] } });
		expect(await call).toEqual({ content: [{ type: "text", text: "ok" }] });
		expect(updates).toEqual([{ content: [] }]);
		expect(() => bridge.result({ t: "host_tool_result", id })).toThrow("host_tool_result");
	});

	it("rejects an error result with its text, cancels on abort, and fails after close", async () => {
		const { frames, send } = recorder();
		const bridge = new HostToolBridge(send);
		const [tool] = bridge.tools([definition]);
		const failing = tool.execute("tc1", {});
		bridge.result({ t: "host_tool_result", id: frames[0].id, isError: true, result: { content: [{ type: "text", text: "boom" }] } });
		await expect(failing).rejects.toThrow("boom");

		const abort = new AbortController();
		const aborted = tool.execute("tc2", {}, abort.signal);
		abort.abort();
		await expect(aborted).rejects.toThrow('Host tool "echo" was aborted');
		expect(frames[2]).toMatchObject({ t: "host_tool_cancel", targetId: frames[1].id });

		const pending = tool.execute("tc3", {});
		bridge.close("gone");
		await expect(pending).rejects.toThrow("gone");
		await expect(tool.execute("tc4", {})).rejects.toThrow("gone");
	});
});

describe("HostUriBridge", () => {
	it("serves reads from the host and leaves the router on close", async () => {
		const { frames, send } = recorder();
		const bridge = new HostUriBridge(send);
		expect(bridge.setSchemes([{ scheme: " Notes ", writable: false, immutable: true }])).toEqual(["notes"]);
		const handler = InternalUrlRouter.instance().getHandler("notes");
		if (!handler) throw new Error("notes:// not registered");
		expect(handler.write).toBeUndefined();
		const read = handler.resolve(parseInternalUrl("notes://a"));
		expect(frames[0]).toMatchObject({ t: "host_uri_request", operation: "read", url: "notes://a" });
		bridge.result({ t: "host_uri_result", id: frames[0].id, content: "hi", notes: ["n"] });
		expect(await read).toMatchObject({ url: "notes://a", content: "hi", contentType: "text/plain", notes: ["n"], immutable: true, size: 2 });
		expect(() => bridge.setSchemes([{ scheme: "skill", writable: false, immutable: false }])).toThrow("reserved");
		bridge.close("gone");
		expect(InternalUrlRouter.instance().getHandler("notes")).toBeUndefined();
	});
});
