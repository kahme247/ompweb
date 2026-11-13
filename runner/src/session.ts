import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
} from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createAttentionTool } from "./attention";
import { HostChannel } from "./channel";
import { isHeadless } from "./headless";

/**
 * omp's session factory, plus the `ompweb host` channel: the host receives the session's events
 * and drives it through the same `AgentSession` the TUI uses, and dialogs open on both sides.
 * A headless omp serves the host on stdio instead, from `headless.ts`.
 * Every session it makes gets the `request_attention` tool (`attention.ts`). Subagents do not: omp builds
 * them with its own factory and hands them none of their parent's custom tools.
 */
export async function createHostedAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	let session: AgentSession | undefined;
	const customTools = [...(options.customTools ?? []), createAttentionTool(() => session)];
	// A non-interactive launch throws when a resumed session's model cannot be restored; ompweb instead
	// opens it on the default model, or none, so a logged-out user can still open old sessions and log in from them.
	if (isHeadless()) {
		const result = await createAgentSession({ ...options, customTools, allowSessionModelFallback: true });
		session = result.session;
		return result;
	}
	const result = await createAgentSession({ ...options, customTools });
	session = result.session;
	// Only the TUI is a session the web may drive; `-p`, json and acp runs leave `hasUI` unset (rpc modes never reach here).
	if (!options.hasUI) return result;
	const channel = await HostChannel.connect(result.session, result.subagentEventBus);
	return {
		...result,
		setToolUIContext: (ui, hasUI) => result.setToolUIContext(channel.wrapUi(ui), hasUI),
	};
}
