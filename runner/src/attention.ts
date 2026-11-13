/**
 * The agent's `request_attention` tool. It only appends an `omp-web-attention` custom entry to its session: ompweb's
 * session list (`lib/omp/session-files.ts`) shows a session under Needs attention while that marker is newer than its
 * newest user message and the session is not running.
 */
import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/** The marker's `customType`; ompweb's session list reads the same literal (`lib/omp/session-files.ts`). */
export const ATTENTION_ENTRY_TYPE = "omp-web-attention";
/** The longest reason written; `lib/omp/session-files.ts` caps the reason it reads at the same length. */
export const ATTENTION_REASON_MAX = 300;

const parameters = type({
	reason: type("string").describe('One short sentence on what you need from the user, e.g. "Approve the migration plan".'),
});

/**
 * `request_attention` for the session `session()` returns. A session's tools are built before the session, so the
 * factory hands in a getter it fills once the session exists; no turn, and so no tool call, runs before that.
 */
export function createAttentionTool(
	session: () => AgentSession | undefined,
): CustomTool<typeof parameters, { reason: string }> {
	return {
		name: "request_attention",
		label: "Request Attention",
		// Always in the model's tool list: SDK custom tools otherwise default to "discoverable", behind a discovery
		// step, and a tool the model must look up first is one it forgets to call at the end of a turn.
		loadMode: "essential",
		description: [
			"Mark this session as waiting for the user, so it shows under Needs attention in omp-web.",
			"Call it as the last action of a turn that ends waiting on the user: for an instruction, an answer, a decision or an approval.",
			"Do not call it for progress updates or mid-task.",
			"The user's next message clears it; never withdraw it yourself.",
		].join(" "),
		parameters,
		async execute(_toolCallId, params) {
			const target = session();
			if (!target) throw new Error("request_attention ran before its session existed");
			const reason = String(params.reason ?? "")
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, ATTENTION_REASON_MAX);
			target.sessionManager.appendCustomEntry(ATTENTION_ENTRY_TYPE, { reason });
			return {
				content: [{ type: "text", text: "The session is marked as waiting for the user. End the turn now." }],
				details: { reason },
			};
		},
	};
}
