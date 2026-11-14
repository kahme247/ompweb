import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CACHE_WARMING_MODES } from "@oh-my-pi/pi-coding-agent/session/cache-warmer";
import { isSessionSettled } from "@oh-my-pi/pi-coding-agent/session/session-settle";
import { buildAvailableSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import { calculateTokensPerSecond } from "@oh-my-pi/pi-coding-agent/utils/token-rate";
import { parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { queuedClientMessageIds } from "../correlation";
import type { CommandTable, FrameTable } from "./types";

// shortcut: RPC's get_state first awaits its goal controller and counts a scheduled goal turn as unsettled;
// that controller is RPC transport state, so add it here when the runner ports goals.
export function sessionState(session: AgentSession) {
	const queued = session.getQueuedMessages();
	const clientMessageIds = queuedClientMessageIds(session);
	return {
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		interruptMode: session.interruptMode,
		sessionFile: session.sessionFile,
		sessionId: session.sessionId,
		sessionName: session.sessionName,
		autoCompactionEnabled: session.autoCompactionEnabled,
		queuedMessageCount: session.queuedMessageCount,
		hasPendingAsyncWork: session.hasPendingAsyncWork(),
		isSettled: isSessionSettled(session),
		supportsClientMessageIds: true,
		queuedMessages: {
			steering: [...queued.steering],
			followUp: [...queued.followUp],
			liveSteered: queued.liveSteered,
			...(clientMessageIds ? { clientMessageIds } : {}),
		},
		todoPhases: session.getTodoPhases(),
		fastModeEnabled: session.isFastModeEnabled(),
		tokensPerSecond: calculateTokensPerSecond(session.messages, session.isStreaming),
		fastModeActive: session.isFastModeActive(),
		slowModeSupported: session.isSlowModeSupported(),
		slowModeEnabled: session.isSlowModeEnabled(),
		slowModeScope: session.getSlowModeScope(),
		usageLimit: session.getUsageLimitState(),
		messageCount: session.messages.length,
		systemPrompt: session.systemPrompt,
		dumpTools: session.agent.state.tools.map(tool => ({
			name: tool.name,
			description: tool.description,
			parameters: toolWireSchema(tool),
			examples: tool.examples,
		})),
		contextUsage: session.getContextUsage(),
		goal: session.getGoalModeState() ?? null,
	};
}

/** Exact provider/id match; a miss waits for background discovery (proxy/ollama models land after startup). */
export async function findModel(session: AgentSession, provider: string, modelId: string) {
	const find = () => session.getAvailableModels().find(m => m.provider === provider && m.id === modelId);
	const model = find();
	if (model) return model;
	await session.modelRegistry.awaitBackgroundRefresh();
	return find();
}

function bool(op: string, value: unknown): boolean {
	if (typeof value !== "boolean") throw new Error(`${op}: enabled must be a boolean`);
	return value;
}

export const modelCommands: CommandTable = {
	async get_state({ session }) {
		return sessionState(session);
	},
	async set_model({ session }, { provider, modelId }) {
		if (typeof provider !== "string" || typeof modelId !== "string") throw new Error("set_model: provider and modelId must be strings");
		const model = await findModel(session, provider, modelId);
		if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
		await session.setModel(model);
		return model;
	},
	async cycle_model({ session }) {
		return (await session.cycleModel()) ?? null;
	},
	async get_available_models({ session }) {
		await session.modelRegistry.awaitBackgroundRefresh();
		return { models: session.getAvailableModels() };
	},
	async set_thinking_level({ session }, { level }) {
		const parsed = typeof level === "string" ? parseConfiguredThinkingLevel(level) : undefined;
		if (!parsed) throw new Error(`set_thinking_level: invalid level ${String(level)}`);
		session.setThinkingLevel(parsed);
	},
	async cycle_thinking_level({ session }) {
		const level = session.cycleThinkingLevel();
		return level ? { level } : null;
	},
	async get_available_thinking_levels({ session }) {
		return { levels: [ThinkingLevel.Off, ...session.getAvailableThinkingLevels()] };
	},
	async set_fast_mode({ session }, { enabled }) {
		const on = bool("set_fast_mode", enabled);
		if (!session.setFastMode(on) && on) throw new Error("Fast mode is unavailable for the current model.");
		return { enabled: session.isFastModeEnabled(), active: session.isFastModeActive() };
	},
	async set_slow_mode({ session }, { enabled }) {
		const on = bool("set_slow_mode", enabled);
		if (!session.setSlowMode(on) && on) throw new Error("Slow mode is unavailable for the current model.");
		return { enabled: session.isSlowModeEnabled() };
	},
	async set_auto_compaction({ session }, { enabled }) {
		session.setAutoCompactionEnabled(bool("set_auto_compaction", enabled));
	},
	async set_auto_retry({ session }, { enabled }) {
		session.setAutoRetryEnabled(bool("set_auto_retry", enabled));
	},
	async abort_retry({ session }) {
		session.abortRetry();
	},
	async set_cache_warming({ session }, { mode }) {
		const valid = CACHE_WARMING_MODES.find(m => m === mode);
		if (!valid) throw new Error(`Invalid cache warming mode: ${String(mode)}`);
		return { mode: session.setCacheWarmingMode(valid) };
	},
	async compact({ session }, { customInstructions }) {
		if (customInstructions !== undefined && typeof customInstructions !== "string") throw new Error("compact: customInstructions must be a string");
		return session.compact(customInstructions);
	},
	async abort_compaction({ session }) {
		session.abortCompaction();
	},
	// The runner's own command; mirrors argument-less `/rename`: generate, persist as a user title, return it.
	async generate_title({ session }) {
		const title = await session.renameTitle();
		if (!title) return { title: null };
		if (!(await session.sessionManager.setSessionName(title, "user"))) throw new Error("generate_title: a user-set name takes precedence");
		return { title };
	},
	async get_session_stats({ session }) {
		return session.getSessionStats();
	},
	async get_available_commands({ session }) {
		return { commands: await buildAvailableSlashCommands(session) };
	},
};

export const modelFrames: FrameTable = {};
