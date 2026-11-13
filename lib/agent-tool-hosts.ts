/** The host rule shared by agent-tools.ts and github/tools.ts; a leaf module so neither imports the other at runtime. */

/** A machine sessions can start on; this machine has id "local". */
export interface AgentToolHost {
  id: string;
  label: string;
  online: boolean;
  /** Off: the user confirms each agent-started session there. */
  allowAgentStart: boolean;
}

/** A host's allowAgentStart covers its agents' calls; a remote caller always asks before reaching this machine. */
export function startsUnasked(target: AgentToolHost, sourceHostId: string): boolean {
  return target.allowAgentStart && !(target.id === "local" && sourceHostId !== "local");
}
