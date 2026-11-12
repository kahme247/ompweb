/**
 * omp's root `launch` command (`commands/launch.ts`), with one change: the agent session factory
 * hosts the session for ompweb. Keep it in step with upstream's copy on every omp bump.
 */
import { type Args, parseArgs, reportCliUsageError } from "@oh-my-pi/pi-coding-agent/cli/args";
import { launchHelp } from "@oh-my-pi/pi-coding-agent/commands/launch-help";
import { prepareAcpTerminalAuthArgs } from "@oh-my-pi/pi-coding-agent/modes/acp/terminal-auth";
import { Command } from "@oh-my-pi/pi-utils/cli";
import { createHostedAgentSession } from "./session";

export default class Index extends Command {
	static description = launchHelp.description;
	static hidden = launchHelp.hidden;
	static args = launchHelp.args;
	static flags = launchHelp.flags;
	static examples = launchHelp.examples;

	static strict = false;

	async run(): Promise<void> {
		const { args } = prepareAcpTerminalAuthArgs(this.argv);
		let parsed: Args;
		try {
			parsed = parseArgs(args);
		} catch (error) {
			if (reportCliUsageError(error)) {
				process.exitCode = 2;
				return;
			}
			throw error;
		}
		// Startup boundary, as upstream: the session graph loads only once argv is accepted.
		const { runRootCommand } = await import("@oh-my-pi/pi-coding-agent/main");
		try {
			await runRootCommand(parsed, args, { createAgentSession: createHostedAgentSession });
		} catch (error) {
			if (reportCliUsageError(error)) process.exit(2);
			throw error;
		}
	}
}
