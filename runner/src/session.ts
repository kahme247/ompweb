import { cfgCollabAutoStart, cfgCollabRelayUrl } from "@oh-my-pi/pi-coding-agent/collab/settings";
import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
} from "@oh-my-pi/pi-coding-agent/sdk";
import { attachControl } from "./control";

/**
 * omp's session factory, plus ompweb hosting: with `OMPWEB_RELAY_URL` set, every session this
 * process creates is shared through that relay (collab, control access) for this run only, and
 * gets the host's control channel.
 */
export async function createHostedAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const relayUrl = process.env.OMPWEB_RELAY_URL;
	// Runtime-override layer: never persisted, so the user's own /collab relay setting is untouched.
	if (relayUrl && options.settings) {
		cfgCollabRelayUrl.override(options.settings, relayUrl);
		cfgCollabAutoStart.override(options.settings, "control");
	}
	const result = await createAgentSession(options);
	await attachControl(result.session);
	return result;
}
