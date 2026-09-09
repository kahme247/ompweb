import { formatCompactNumber } from "@/lib/format";
import { isRecord } from "@/lib/type-guards";
import type { ToolCallContent, ToolResultMessage } from "@/lib/types";

export type ToolCategory = "read" | "search" | "edit" | "terminal" | "todo" | "task" | "code" | "web" | "other";

export function getToolCategory(toolName: string): ToolCategory {
  // User-run shell rows synthesize "bash (local)" (MessageView.tsx) — one
  // shell execution either way, so drop any trailing "(...)" qualifier first.
  const name = toolName.toLowerCase().replace(/\s*\(.*\)\s*$/, "");
  if (name === "read" || name.endsWith(".read") || name.endsWith("_read") || name === "file_read") return "read";
  if (name === "grep" || name === "glob" || name.includes("search") || name.endsWith(".grep") || name.endsWith(".glob")) return "search";
  if (name === "edit" || name === "write" || name === "ast_edit" || name.endsWith(".edit") || name.endsWith(".write")) return "edit";
  if (name === "bash" || name === "terminal" || name === "exec" || name === "shell" || name === "cmd") return "terminal";
  if (name === "todo" || name.endsWith(".todo")) return "todo";
  if (name === "task" || name === "agent" || name.endsWith(".task") || name.endsWith(".agent")) return "task";
  if (name === "eval" || name.endsWith(".eval")) return "code";
  if (name === "web_search" || name === "browser" || name.includes("browser")) return "web";
  return "other";
}

export function getTodoSummary(input: unknown): { op: string; action: string; label: string; task?: string } | null {
  if (!isRecord(input) || typeof input.op !== "string") return null;
  const op = input.op;
  const task = typeof input.task === "string" ? input.task : undefined;
  const phase = typeof input.phase === "string" ? input.phase : undefined;
  const items = Array.isArray(input.items) ? input.items.filter((i): i is string => typeof i === "string") : undefined;

  switch (op) {
    case "done":
      return { op, action: "Completed", label: task ? `Completed "${task}"` : "Completed task", task };
    case "start":
      return { op, action: "Started", label: task ? `Started "${task}"` : "Started task", task };
    case "append":
      return { op, action: "Added", label: task ? `Added "${task}"` : items?.length ? `Added ${items.length} task${items.length > 1 ? "s" : ""}` : "Added task", task: task ?? items?.[0] };
    case "init": {
      const listCount = Array.isArray(input.list) ? input.list.reduce((acc, p) => acc + (isRecord(p) && Array.isArray(p.items) ? p.items.length : 0), 0) : items?.length ?? 0;
      return { op, action: "Initialized", label: `Initialized plan (${listCount} tasks)`, task: phase };
    }
    case "block":
      return { op, action: "Blocked", label: task ? `Blocked "${task}"` : "Blocked task", task };
    case "unblock":
      return { op, action: "Unblocked", label: task ? `Unblocked "${task}"` : "Unblocked task", task };
    case "drop":
      return { op, action: "Dropped", label: task ? `Dropped "${task}"` : "Dropped task", task };
    default:
      return { op, action: op, label: `Task: ${op}${task ? ` "${task}"` : ""}`, task };
  }
}

export function getToolPreview(block: ToolCallContent): string {
  const input = block.input;
  if (!input || typeof input !== "object") return "";

  if (getToolCategory(block.toolName) === "todo") {
    const todoSummary = getTodoSummary(input);
    if (todoSummary) return todoSummary.label;
  }

  const keys = Object.keys(input);
  if (keys.length === 0) return "";

  // Common tool input patterns
  if ("command" in input) return String(input.command).slice(0, 120);
  if ("path" in input) return String(input.path).slice(0, 120);
  if ("file_path" in input) return String(input.file_path).slice(0, 120);
  if ("pattern" in input) return String(input.pattern).slice(0, 120);
  if ("query" in input) return String(input.query).slice(0, 120);

  const first = input[keys[0]];
  return String(first).slice(0, 120);
}

export function getSemanticToolLabel(block: ToolCallContent): { action: string; target: string; isFile?: boolean } {
  const input = block.input;
  const category = getToolCategory(block.toolName);

  if (category === "todo") {
    const todoSummary = getTodoSummary(input);
    if (todoSummary) {
      return { action: todoSummary.action, target: todoSummary.task ?? todoSummary.label };
    }
  }

  if (isRecord(input)) {
    if (category === "read" && typeof input.path === "string") {
      return { action: "Read", target: input.path, isFile: true };
    }
    if (category === "search") {
      if (typeof input.pattern === "string") {
        const scope = typeof input.path === "string" ? ` in ${input.path}` : "";
        return { action: "Search", target: `"${input.pattern}"${scope}` };
      }
      if (typeof input.path === "string") {
        return { action: "Find", target: input.path };
      }
      if (typeof input.query === "string") {
        return { action: "Search", target: `"${input.query}"` };
      }
    }
    if (category === "edit") {
      if (typeof input.path === "string") {
        const action = block.toolName.toLowerCase().includes("write") ? "Create" : "Edit";
        return { action, target: input.path, isFile: true };
      }
    }
    if (category === "terminal" && typeof input.command === "string") {
      return { action: "Run", target: input.command };
    }
    if (category === "code") {
      const target = typeof input.title === "string" ? input.title : (typeof input.language === "string" ? `${input.language} code` : "code");
      return { action: "Eval", target };
    }
    if (category === "web" && typeof input.query === "string") {
      return { action: "Search Web", target: `"${input.query}"` };
    }
  }

  return { action: block.toolName, target: getToolPreview(block) };
}

export function summarizeToolCallGroup(blocks: ToolCallContent[]): {
  summaryText: string;
  categories: ToolCategory[];
  totalCount: number;
} {
  const counts: Record<ToolCategory, number> = {
    read: 0,
    search: 0,
    edit: 0,
    terminal: 0,
    todo: 0,
    task: 0,
    code: 0,
    web: 0,
    other: 0,
  };

  for (const b of blocks) {
    const cat = getToolCategory(b.toolName);
    counts[cat]++;
  }

  const parts: string[] = [];
  if (counts.read > 0) parts.push(`Read ${counts.read} file${counts.read > 1 ? "s" : ""}`);
  if (counts.search > 0) parts.push(`searched ${counts.search} time${counts.search > 1 ? "s" : ""}`);
  if (counts.edit > 0) parts.push(`edited ${counts.edit} file${counts.edit > 1 ? "s" : ""}`);
  if (counts.terminal > 0) parts.push(`ran ${counts.terminal} command${counts.terminal > 1 ? "s" : ""}`);
  if (counts.todo > 0) parts.push(`updated ${counts.todo} task${counts.todo > 1 ? "s" : ""}`);
  if (counts.task > 0) parts.push(`spawned ${counts.task} subagent${counts.task > 1 ? "s" : ""}`);
  if (counts.code > 0) parts.push(`executed ${counts.code} code cell${counts.code > 1 ? "s" : ""}`);
  if (counts.web > 0) parts.push(`browsed ${counts.web} page${counts.web > 1 ? "s" : ""}`);
  if (counts.other > 0) parts.push(`used ${counts.other} other tool${counts.other > 1 ? "s" : ""}`);

  const activeCategories = (Object.keys(counts) as ToolCategory[]).filter((c) => counts[c] > 0);

  let summaryText = "";
  if (parts.length === 0) {
    summaryText = `${blocks.length} tool operations`;
  } else if (parts.length === 1) {
    summaryText = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  } else if (parts.length === 2) {
    summaryText = `${parts[0].charAt(0).toUpperCase() + parts[0].slice(1)} and ${parts[1]}`;
  } else {
    summaryText = parts.map((p, i) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p)).join(" · ");
  }

  return {
    summaryText,
    categories: activeCategories,
    totalCount: blocks.length,
  };
}

export function formatToolCommand(block: ToolCallContent): string {
  const input = block.input;
  if (input && typeof input.command === "string") return input.command;
  if (input && typeof input.path === "string") return `${block.toolName} ${input.path}`;
  if (input && typeof input.file_path === "string") return `${block.toolName} ${input.file_path}`;
  if (input && typeof input.query === "string") return `${block.toolName} ${input.query}`;
  try {
    return `${block.toolName} ${JSON.stringify(input)}`;
  } catch {
    return block.toolName;
  }
}

export function formatToolOutput(text: string, toolName: string): string {
  if (!isReadToolName(toolName)) return text;
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*\d+:\s?/, ""))
    .join("\n");
}

export function isReadToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "read" || name.endsWith(".read") || name.endsWith("_read");
}

export function getToolResultMeta(result: ToolResultMessage | undefined): string | null {
  if (!result || !isRecord(result.details)) return null;
  const details = result.details;
  const usage = isRecord(details.usage) ? details.usage : details;
  const readNumber = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = usage[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    }
    return undefined;
  };
  const input = readNumber("input", "inputTokens", "input_tokens");
  const output = readNumber("output", "outputTokens", "output_tokens");
  const cacheRead = readNumber("cacheRead", "cache_read", "cacheReadTokens");
  const cacheWrite = readNumber("cacheWrite", "cache_write", "cacheWriteTokens");
  const parts = [
    input ? `in ${formatCompactNumber(input)}` : null,
    output ? `out ${formatCompactNumber(output)}` : null,
    cacheRead ? `cache R ${formatCompactNumber(cacheRead)}` : null,
    cacheWrite ? `cache W ${formatCompactNumber(cacheWrite)}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}
