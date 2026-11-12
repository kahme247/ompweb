import type { CommandTable, FrameTable } from "./types";

export const promptingCommands: CommandTable = {
	async prompt({ session }, args) {
		if (typeof args.text !== "string") throw new Error("prompt: text must be a string");
		const streamingBehavior = args.streamingBehavior === "steer" ? "steer" : "followUp";
		// The run continues after the reply; its progress arrives as events.
		void session.prompt(args.text, { streamingBehavior, userInitiated: true });
		return undefined;
	},
	async abort({ session }) {
		await session.abort();
		return undefined;
	},
};

export const promptingFrames: FrameTable = {};
