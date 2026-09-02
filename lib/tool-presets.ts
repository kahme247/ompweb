export interface ToolEntry {
  name: string;
  description: string;
  active: boolean;
}

export type ToolPreset = "none" | "default" | "full";

export function isToolPreset(value: unknown): value is ToolPreset {
  return value === "none" || value === "default" || value === "full";
}

export const PRESET_NONE: string[] = [];
export const PRESET_DEFAULT: string[] = ["read", "bash", "edit", "write"];
export const PRESET_FULL: string[] = ["bash", "read", "edit", "write", "grep", "find", "ls"];

export function getToolNamesForPreset(preset: ToolPreset): string[] | undefined {

  if (preset === "none") return [...PRESET_NONE];
  if (preset === "full") return undefined;
  return [...PRESET_DEFAULT];
}
