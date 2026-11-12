import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
} from "@oh-my-pi/pi-coding-agent/sdk";
import { HostChannel } from "./channel";
import { isHeadless } from "./headless";

/**
 * omp's session factory, plus the `ompweb host` channel: the host receives the session's events
 * and drives it through the same `AgentSession` the TUI uses, and dialogs open on both sides.
 * A headless omp serves the host on stdio instead, from `headless.ts`.
 */
export async function createHostedAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	// rpc-ui throws when a resumed session's model cannot be restored; ompweb instead opens it on the
	// default model, or none, so a logged-out user can still open old sessions and log in from them.
	if (isHeadless()) return createAgentSession({ ...options, allowSessionModelFallback: true });
	const result = await createAgentSession(options);
	const channel = await HostChannel.connect(result.session, result.subagentEventBus);
	return {
		...result,
		setToolUIContext: (ui, hasUI) => result.setToolUIContext(channel.wrapUi(ui), hasUI),
	};
}
