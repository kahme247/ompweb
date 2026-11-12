/**
 * `prompt_result` reporting: every accepted `prompt`/`abort_and_prompt` not answered with `agentInvoked: false`
 * gets exactly one `{t:"prompt_result", id, agentInvoked, status, sessionSettled, error?}` once the work it caused
 * has yielded: at once for local-only slash commands and failures, else after the terminal `agent_end` of the run
 * the prompt started or joined. The host correlates on the cmd `id` instead of guessing who owns an `agent_end`.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { stripRawHttpRequestDiagnostics } from "@oh-my-pi/pi-ai/utils/http-inspector";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CostCapRefusal } from "@oh-my-pi/pi-coding-agent/session/cost-gate";
import { isSessionSettled } from "@oh-my-pi/pi-coding-agent/session/session-settle";
import { toError } from "@oh-my-pi/pi-utils";
import type { CommandContext } from "./commands/types";

/** A prompt whose `prompt_result` is still owed; see {@link PromptResults.begin}. */
export interface PromptTicket {
	readonly id: number | undefined;
}

interface PromptError {
	message: string;
	provider?: string;
	model?: string;
	httpStatus?: number;
	/** Transient: resubmitting later may succeed. omp's own retries are already exhausted. */
	retryable: boolean;
	code?: "cost_cap";
}

interface RunOutcome {
	status: "completed" | "aborted" | "error";
	error?: PromptError;
}

interface OpenPrompt {
	/** `agent_start` count at acceptance; a later start begins a run this prompt may own. */
	startsAtBegin: number;
	/** Outcome of the first run started after acceptance, once the agent yielded it. */
	ownOutcome?: RunOutcome;
	/** Settled while another run was live: reported at the next yield that leaves nothing queued. */
	waiting: boolean;
	/** The cost gate's latest refusal at acceptance; a newer one refused this prompt before dispatch. */
	refusalAtBegin: CostCapRefusal | undefined;
}

/**
 * Correlates accepted prompts with the run that carries their work. Fed every session event through
 * {@link observe}. A prompt reports when the agent yields its work, not when the session is done (background
 * jobs may wake it later; `sessionSettled` says which). A prompt dispatched as a fresh turn owns the first run
 * started after it was accepted, so a late `agent_end` from an earlier run never settles it; one queued into a
 * live run reports at the first yield after its message left the queue.
 */
export class PromptResults {
	#agentStarts = 0;
	#open = new Map<PromptTicket, OpenPrompt>();
	#refusalAtRunStart: CostCapRefusal | undefined;
	readonly #session: AgentSession;
	readonly #send: CommandContext["send"];
	readonly #scheduledTurn: () => boolean;
	/** A prompt reported without a run (refused or aborted before dispatch): no `agent_end` re-checks settlement. */
	readonly #settledWithoutRun: () => void;

	constructor(session: AgentSession, send: CommandContext["send"], scheduledTurn: () => boolean, settledWithoutRun: () => void) {
		this.#session = session;
		this.#send = send;
		this.#scheduledTurn = scheduledTurn;
		this.#settledWithoutRun = settledWithoutRun;
	}

	/** Open a ticket before the prompt starts any work. Close it with exactly one report or {@link discard}. */
	begin(id: number | undefined): PromptTicket {
		const ticket: PromptTicket = { id };
		this.#open.set(ticket, { startsAtBegin: this.#agentStarts, refusalAtBegin: this.#session.costCapRefusal, waiting: false });
		return ticket;
	}

	/** Drop a ticket whose command was rejected before it was accepted (no `prompt_result` is owed). */
	discard(ticket: PromptTicket): void {
		this.#open.delete(ticket);
	}

	/** The prompt's work reached the agent (dispatched or queued). Reports now if its own run already yielded. */
	settle(ticket: PromptTicket): void {
		const open = this.#open.get(ticket);
		if (!open) return;
		if (open.ownOutcome) {
			this.#report(ticket, true, open.ownOutcome);
		} else if (this.#session.isStreaming || this.#agentStarts > open.startsAtBegin) {
			// Queued into a live run, or its own run paused for agent-owned follow-up work (e.g. a retry).
			open.waiting = true;
		} else {
			// Idle with no run since acceptance: the cost gate refused it, or an abort won the race before dispatch.
			this.#report(ticket, true, this.#costCapOutcome(open.refusalAtBegin) ?? { status: "aborted" });
			this.#settledWithoutRun();
		}
	}

	/** The prompt was handled locally without an agent turn. */
	completeLocal(ticket: PromptTicket): void {
		this.#report(ticket, false, { status: "completed" });
	}

	/** The prompt failed before reaching the agent. */
	fail(ticket: PromptTicket, message: string): void {
		this.#report(ticket, false, { status: "error", error: { message, retryable: false } });
	}

	/**
	 * Mark every open prompt aborted after a session transition: transitions detach the agent before aborting it,
	 * so the interrupted run never publishes a terminal `agent_end` for them.
	 */
	abortOpen(): void {
		for (const [ticket, open] of this.#open) {
			if (open.waiting) this.#report(ticket, true, { status: "aborted" });
			// No run started since acceptance: not detached; the command still running keeps its ticket.
			else if (this.#agentStarts > open.startsAtBegin) open.ownOutcome ??= { status: "aborted" };
		}
	}

	/** Track run boundaries; call after the event was sent so `prompt_result` follows its `agent_end`. */
	observe(event: AgentSessionEvent): void {
		if (event.type === "agent_start") {
			this.#agentStarts++;
			this.#refusalAtRunStart = this.#session.costCapRefusal;
			return;
		}
		if (event.type !== "agent_end" || this.#open.size === 0) return;
		// Older sessions omit `yielded`; only their terminal ends were yields.
		if (!(event.yielded ?? event.isTerminal !== false)) return;
		// A request the cost gate refused during this run is its outcome, whatever message ended it.
		const outcome = this.#costCapOutcome(this.#refusalAtRunStart) ?? runOutcome(event.messages);
		// A still-queued steer/follow-up has not been read by the agent yet.
		const queueDrained = this.#session.queuedMessageCount === 0;
		for (const [ticket, open] of this.#open) {
			if (open.waiting) {
				if (queueDrained) this.#report(ticket, true, outcome);
			} else if (!open.ownOutcome && this.#agentStarts > open.startsAtBegin) {
				open.ownOutcome = outcome;
			}
		}
	}

	#costCapOutcome(since: CostCapRefusal | undefined): RunOutcome | undefined {
		const refusal = this.#session.costCapRefusal;
		if (refusal === undefined || refusal === since) return undefined;
		return { status: "error", error: { message: refusal.message, retryable: false, code: "cost_cap" } };
	}

	#report(ticket: PromptTicket, agentInvoked: boolean, outcome: RunOutcome): void {
		if (!this.#open.delete(ticket)) return;
		// Next macrotask: keeps prompt_result behind the cmd's own `res` and lets queue drains land before
		// `sessionSettled` is read.
		setImmediate(() =>
			this.#send({
				t: "prompt_result",
				id: ticket.id,
				agentInvoked,
				status: outcome.status,
				sessionSettled: isSessionSettled(this.#session, this.#scheduledTurn),
				...(outcome.error ? { error: outcome.error } : {}),
			}),
		);
	}
}

/** Outcome of a run, read from its final assistant message. */
function runOutcome(messages: readonly AgentMessage[]): RunOutcome {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		if (message.stopReason === "error") return { status: "error", error: promptError(message) };
		if (message.stopReason === "aborted") return { status: "aborted" };
		return { status: "completed" };
	}
	return { status: "completed" };
}

function promptError(message: AssistantMessage): PromptError {
	const errorId = AIError.classifyMessage({
		api: message.api,
		provider: message.provider,
		model: message.model,
		errorId: message.errorId,
		errorMessage: message.errorMessage,
		errorClassificationMessage: message.errorClassificationMessage,
		errorStatus: message.errorStatus,
	});
	const error: PromptError = {
		message: message.errorMessage ? stripRawHttpRequestDiagnostics(message.errorMessage) : "Provider request failed",
		provider: message.provider,
		model: message.model,
		retryable: AIError.is(errorId, AIError.Flag.Transient),
	};
	if (message.errorStatus !== undefined) error.httpStatus = message.errorStatus;
	return error;
}

/**
 * Start a prompt and route its resolution into its `prompt_result`: `false` completes locally, agent work
 * settles through the run, a rejection goes to `onError` and a failed result. `startPrompt` receives the
 * `onPromptAdmitted` callback; the returned promise resolves once the prompt is admitted or settles without
 * admission, and never rejects. Await it to answer the cmd only after admission.
 */
export function reportPromptResult(
	ticket: PromptTicket,
	results: PromptResults,
	onError: (error: Error) => void,
	startPrompt: (onPromptAdmitted: () => void) => Promise<boolean>,
): Promise<void> {
	const admitted = Promise.withResolvers<void>();
	const prompt = startPrompt(admitted.resolve);
	void prompt.then(
		agentInvoked => (agentInvoked ? results.settle(ticket) : results.completeLocal(ticket)),
		(cause: unknown) => {
			const error = toError(cause);
			onError(error);
			results.fail(ticket, error.message);
		},
	);
	const settled = () => admitted.resolve();
	void prompt.then(settled, settled);
	return admitted.promise;
}
