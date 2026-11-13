import { correlationCommands } from "../correlation";
import { eventsCommands } from "../events";
import { agentsCommands, agentsFrames } from "./agents";
import { modelCommands, modelFrames } from "./model";
import { promptingCommands, promptingFrames } from "./prompting";
import { sessionCommands, sessionFrames } from "./session";
import { toolsCommands, toolsFrames } from "./tools";
import type { CommandTable, FrameTable } from "./types";

/** Every host command by name; each group file owns its names. */
export const commands: CommandTable = {
	...promptingCommands,
	...modelCommands,
	...sessionCommands,
	...toolsCommands,
	...agentsCommands,
	...eventsCommands,
	...correlationCommands,
};

/** Every non-command host frame by `t`; each group file owns its frame types. */
export const frames: FrameTable = {
	...promptingFrames,
	...modelFrames,
	...sessionFrames,
	...toolsFrames,
	...agentsFrames,
};
