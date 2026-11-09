/**
 * Web-native slash commands (prompt-composing).
 *
 * omp executes every command in its RPC catalog (builtin, extension, custom,
 * MCP prompt, file, skill) when it arrives through `prompt`, so those are never
 * expanded here. The entries below are omp-web conveniences for names omp does
 * not provide; the dispatcher only uses one when omp's catalog does not already
 * own that name, so an extension/skill command always wins.
 *
 * `/goal` is not here either: it uses omp's native `goal` RPC (goal mode is not
 * a slash builtin over RPC).
 *
 * Pure definitions — no I/O. Prompt text is deliberately concise; the args are
 * user-supplied and embedded verbatim.
 */

export interface WebSlashCommandDef {
  name: string;
  descriptionKey: string;
  /** i18n key for the bracketed argument hint shown in the palette, e.g. "[task]". */
  argumentHintKey: string;
  /** Commands without args refuse to run and surface usage instead. */
  requiresArgs: boolean;
  buildPrompt: (args: string) => string;
}

const PLAN_PROMPT = (args: string) =>
  `Create a plan for this task before doing anything else:\n\n${args}\n\nThink it through step by step, list concrete steps, and state what you will verify when done.`;

const FIX_PROMPT = (args: string) =>
  `Fix this issue:\n\n${args}\n\nReproduce the problem, apply the smallest correct fix, and verify it works before finishing.`;

const TEST_PROMPT = (args: string) =>
  `Write tests for ${args}. Follow the project's test conventions, cover the important behavior and edge cases, and run the tests to confirm they pass.`;

const EXPLAIN_PROMPT = (args: string) =>
  `Explain ${args} concisely: what it does, how it works, and the key details worth knowing.`;

const SIMPLIFY_PROMPT = (args: string) =>
  `Simplify ${args}. Remove unnecessary complexity while preserving behavior, keep the change focused, and verify nothing breaks.`;

const COMMIT_PROMPT = (args: string) =>
  args
    ? `Stage the relevant files and commit the current changes with this message: ${JSON.stringify(args)}. Run the project's checks first so the commit is green.`
    : `Stage the relevant files and commit the current changes with a clear conventional commit message. Run the project's checks first so the commit is green.`;

const LOOP_MAX_ATTEMPTS = 10;
const LOOP_DEFAULT_ATTEMPTS = 3;

const LOOP_PROMPT = (args: string) => {
  const match = args.match(/^(\d+)\s+([\s\S]+)$/);
  const attempts = match ? Math.min(Math.max(parseInt(match[1], 10) || LOOP_DEFAULT_ATTEMPTS, 1), LOOP_MAX_ATTEMPTS) : LOOP_DEFAULT_ATTEMPTS;
  const task = match ? match[2].trim() : args;
  return `Attempt the following task, verifying the result concretely after each attempt (run the relevant checks or tests). If it is not fully done, try again from where it stands, building on what you learned — up to ${attempts} attempts in total. Stop early once it is done. Do not ask for confirmation between attempts.\n\nTask:\n\n${task}`;
};

export const WEB_SLASH_COMMANDS: readonly WebSlashCommandDef[] = [
  {
    name: "plan",
    descriptionKey: "chatInput.cmdPlan",
    argumentHintKey: "chatInput.cmdPlanArg",
    requiresArgs: true,
    buildPrompt: PLAN_PROMPT,
  },
  {
    name: "fix",
    descriptionKey: "chatInput.cmdFix",
    argumentHintKey: "chatInput.cmdFixArg",
    requiresArgs: true,
    buildPrompt: FIX_PROMPT,
  },
  {
    name: "test",
    descriptionKey: "chatInput.cmdTest",
    argumentHintKey: "chatInput.cmdTestArg",
    requiresArgs: true,
    buildPrompt: TEST_PROMPT,
  },
  {
    name: "explain",
    descriptionKey: "chatInput.cmdExplain",
    argumentHintKey: "chatInput.cmdExplainArg",
    requiresArgs: true,
    buildPrompt: EXPLAIN_PROMPT,
  },
  {
    name: "simplify",
    descriptionKey: "chatInput.cmdSimplify",
    argumentHintKey: "chatInput.cmdSimplifyArg",
    requiresArgs: true,
    buildPrompt: SIMPLIFY_PROMPT,
  },
  {
    name: "commit",
    descriptionKey: "chatInput.cmdCommit",
    argumentHintKey: "chatInput.cmdCommitArg",
    requiresArgs: false,
    buildPrompt: COMMIT_PROMPT,
  },
  {
    name: "loop",
    descriptionKey: "chatInput.cmdLoop",
    argumentHintKey: "chatInput.cmdLoopArg",
    requiresArgs: true,
    buildPrompt: LOOP_PROMPT,
  },
];
const WEB_SLASH_COMMAND_LOOKUP = new Map(WEB_SLASH_COMMANDS.map((command) => [command.name, command]));

export function getWebSlashCommand(name: string): WebSlashCommandDef | undefined {
  return WEB_SLASH_COMMAND_LOOKUP.get(name);
}

export type WebSlashCommandExpansion =
  | { kind: "expand"; prompt: string }
  | { kind: "usage-error"; command: string; argumentHintKey: string }
  | { kind: "not-web" };

/**
 * Resolve a full command line (e.g. "/plan ship the export") into either the
 * expanded prompt to send, a usage error for a required-arg command with no
 * args, or "not-web" for commands the client does not own. Single source of
 * truth for both the idle dispatcher and the streaming queue path, so a web
 * command is never forwarded to omp as literal slash text.
 */
export function expandWebSlashCommand(text: string): WebSlashCommandExpansion {
  if (!text.startsWith("/")) return { kind: "not-web" };
  const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return { kind: "not-web" };
  const def = getWebSlashCommand(match[1]);
  if (!def) return { kind: "not-web" };
  const args = (match[2] ?? "").trim();
  if (def.requiresArgs && !args) {
    return { kind: "usage-error", command: `/${def.name}`, argumentHintKey: def.argumentHintKey };
  }
  return { kind: "expand", prompt: def.buildPrompt(args) };
}
