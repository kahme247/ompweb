#!/usr/bin/env bun
/**
 * ompweb's omp: upstream omp's CLI with the root launch command replaced (see `launch.ts`).
 *
 * Upstream's `cli.ts` only acts as the process entry when it is `Bun.main`, so this module stands in:
 * it declares itself the worker host (workers and worker subprocesses re-enter `Bun.main` with a
 * hidden argv selector, which `runCli` dispatches), installs the SQLite lock shim before any store
 * opens, and installs the postmortem handlers. Worker threads re-enter this module too; importing
 * upstream's `cli.ts` already dispatches them (`!Bun.isMainThread`), so the main-thread branch is ours.
 */
import { runCli } from "@oh-my-pi/pi-coding-agent/cli";
import { commands } from "@oh-my-pi/pi-coding-agent/cli-commands";
import { installSqliteLockShim } from "@oh-my-pi/pi-natives/sqlite-locks";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { declareWorkerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import Launch from "./launch";

if (Bun.isMainThread) {
	const launch = commands.find(entry => entry.name === "launch");
	if (!launch) throw new Error("omp has no launch command to replace");
	launch.load = async () => Launch;

	declareWorkerHostEntry();
	installSqliteLockShim();
	postmortem.installProcessHandlers();
	postmortem.registerStdioDisconnectHandling();
	runCli(process.argv.slice(2)).catch(error => postmortem.fatal(error));
}
