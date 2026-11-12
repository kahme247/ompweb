import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
} from "@oh-my-pi/pi-coding-agent/sdk";
import { HostChannel } from "./channel";

/**
 * omp's session factory, plus the `ompweb host` channel: the host receives the session's events
 * and drives it through the same `AgentSession` the TUI uses, and dialogs open on both sides.
 */
export async function createHostedAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const result = await createAgentSession(options);
	const channel = await HostChannel.connect(result.session);
	return {
		...result,
		setToolUIContext: (ui, hasUI) => result.setToolUIContext(channel.wrapUi(ui), hasUI),
	};
}
