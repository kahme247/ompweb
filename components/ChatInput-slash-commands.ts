import { WEB_SLASH_COMMANDS } from "@/lib/web-slash-commands";

export type SlashCommandSource = "builtin" | "extension" | "prompt" | "skill" | "ompBuiltin";

export type SlashCommandPaletteItem = {
  name: string;
  description?: string;
  /** Bracketed argument hint rendered after the command name, e.g. "[goal]". */
  argumentHint?: string;
  source: SlashCommandSource;
};

export function isDormantSkillCommand(command: SlashCommandPaletteItem, dormantNames: Set<string>): boolean {
  return command.source === "skill" && dormantNames.has(command.name);
}

export const BUILTIN_SLASH_COMMAND_DEFS: { name: string; descriptionKey: string; argumentHintKey?: string }[] = [
  // Web-native prompt-composing commands for names omp does not provide. When
  // omp's catalog reports the same name (extension/custom/skill/builtin), the
  // omp command wins and this entry is hidden.
  ...WEB_SLASH_COMMANDS.map((command) => ({
    name: command.name,
    descriptionKey: command.descriptionKey,
    argumentHintKey: command.argumentHintKey,
  })),
  // omp's goal mode is an RPC command, not a slash builtin.
  { name: "goal", descriptionKey: "chatInput.cmdGoal", argumentHintKey: "chatInput.cmdGoalArg" },
  { name: "btw", descriptionKey: "chatInput.cmdBtw", argumentHintKey: "chatInput.cmdBtwArg" },
  { name: "reload", descriptionKey: "chatInput.cmdReload" },
  { name: "name", descriptionKey: "chatInput.cmdName" },
  { name: "copy", descriptionKey: "chatInput.cmdCopy" },
];

/** Commands omp has no slash equivalent for: the client always dispatches these. */
export const CLIENT_ONLY_COMMAND_NAMES: Record<string, true> = {
  goal: true,
  btw: true,
  reload: true,
  name: true,
  copy: true,
};

export const SLASH_SOURCES: SlashCommandSource[] = ["builtin", "extension", "prompt", "skill", "ompBuiltin"];

export const SLASH_SOURCE_GROUP_LABEL_KEYS: Record<SlashCommandSource, string> = {
  builtin: "chatInput.groupBuiltin",
  extension: "chatInput.groupExtensions",
  prompt: "chatInput.groupPrompts",
  skill: "chatInput.groupSkills",
  ompBuiltin: "chatInput.groupOmpBuiltin",
};

export const SLASH_SOURCE_ORDER: Record<SlashCommandSource, number> = {
  builtin: 0,
  extension: 1,
  prompt: 2,
  skill: 3,
  ompBuiltin: 4,
};

export function slashMatchRank(command: SlashCommandPaletteItem, query: string): number {
  const name = command.name.toLowerCase();
  const description = command.description?.toLowerCase() ?? "";
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (description.includes(query)) return 3;
  return 4;
}
