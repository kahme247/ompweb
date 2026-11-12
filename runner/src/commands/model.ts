import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CommandTable, FrameTable } from "./types";

export function sessionState(session: AgentSession) {
	const model = session.model;
	return {
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
		sessionName: session.sessionName,
		model: model && { provider: model.provider, id: model.id },
		thinkingLevel: session.thinkingLevel,
		isStreaming: session.isStreaming,
	};
}

export const modelCommands: CommandTable = {
	async get_state({ session }) {
		return sessionState(session);
	},
	async set_model({ session }, args) {
		const { provider, modelId } = args;
		if (typeof provider !== "string" || typeof modelId !== "string") throw new Error("set_model: provider and modelId must be strings");
		const model = session.modelRegistry.find(provider, modelId);
		if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
		await session.setModel(model);
		return sessionState(session);
	},
};

export const modelFrames: FrameTable = {};
