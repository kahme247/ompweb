import { formatCompactNumber } from "@/lib/format";
import { isRecord } from "@/lib/type-guards";
import type { ToolCallContent, ToolResultMessage } from "@/lib/types";

export type ToolCategory = "read" | "search" | "edit" | "terminal" | "todo" | "task" | "code" | "web" | "hub" | "other";

export function getToolCategory(toolName: string): ToolCategory {
  const name = toolName.toLowerCase();
  if (name === "hub") return "hub";
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

export interface HubSendSummary {
  to: string[];
  message: string;
  snippet: string;
}

/** Outgoing agent steering: `hub` with `op: "send"` — the TUI's `IRC → X` row. */
export function getHubSendSummary(input: unknown): HubSendSummary | null {
  if (!isRecord(input) || input.op !== "send") return null;
  const raw = Array.isArray(input.to) ? input.to : typeof input.to === "string" ? [input.to] : [];
  const to = raw
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .slice(0, 10);
  if (to.length === 0) return null;
  const message = typeof input.message === "string" ? input.message : "";
  const firstLine = message.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  const snippet = firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
  return { to, message, snippet };
}

export interface HubJobRow {
  id: string;
  type: string;
  status: string;
  label: string;
  durationMs?: number;
  resolvedModel?: string;
}

/** Live job roster: `hub` with `op: "jobs"` — the TUI's `waiting on N jobs` row. */
export function getHubJobs(details: unknown): HubJobRow[] | null {
  if (!isRecord(details) || details.op !== "jobs" || !Array.isArray(details.jobs)) return null;
  const rows: HubJobRow[] = [];
  for (const raw of details.jobs) {
    if (!isRecord(raw)) continue;
    const id = typeof raw.id === "string" && raw.id ? raw.id : null;
    if (!id) continue;
    rows.push({
      id,
      type: typeof raw.type === "string" ? raw.type : "task",
      status: typeof raw.status === "string" ? raw.status : "running",
      label: typeof raw.label === "string" && raw.label ? raw.label : id,
      ...(typeof raw.durationMs === "number" && Number.isFinite(raw.durationMs) ? { durationMs: raw.durationMs } : {}),
      ...(typeof raw.resolvedModel === "string" && raw.resolvedModel ? { resolvedModel: raw.resolvedModel } : {}),
    });
    if (rows.length >= 50) break;
  }
  return rows.length > 0 ? rows : null;
}

export function getHubJobsHeader(jobs: HubJobRow[]): string {
  const waiting = jobs.some((job) => job.status === "running" || job.status === "started" || job.status === "waiting");
  return waiting ? `waiting on ${jobs.length} job${jobs.length === 1 ? "" : "s"}` : `${jobs.length} job${jobs.length === 1 ? "" : "s"}`;
}


function formatToolPreviewValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function getAskPreview(input: Record<string, unknown>): string | null {
  if (!Array.isArray(input.questions)) return null;

  const prompts = input.questions
    .filter(isRecord)
    .map((question) => {
      const header = typeof question.header === "string" ? question.header.trim() : "";
      const prompt = typeof question.question === "string" ? question.question.trim() : "";
      if (header && prompt) return `${header}: ${prompt}`;
      return header || prompt;
    })
    .filter(Boolean);

  if (prompts.length === 0) return input.questions.length > 0 ? `${input.questions.length} question${input.questions.length === 1 ? "" : "s"}` : "";
  const label = prompts.length === 1 ? "Question" : `${prompts.length} questions`;
  return `${label}: ${prompts.map((prompt) => `“${prompt}”`).join(" · ")}`;
}

export function getToolPreview(block: ToolCallContent): string {
  const input = block.input;
  if (!input || typeof input !== "object") return "";

  if (block.toolName.toLowerCase() === "ask") {
    const askPreview = getAskPreview(input);
    if (askPreview !== null) return askPreview.slice(0, 120);
  }

  if (getToolCategory(block.toolName) === "todo") {
    const todoSummary = getTodoSummary(input);
    if (todoSummary) return todoSummary.label;
  }

  if (getToolCategory(block.toolName) === "hub" && isRecord(input)) {
    if (input.op === "send") {
      const send = getHubSendSummary(input);
      if (send) return send.snippet;
      return "send";
    }
    if (input.op === "jobs") return "jobs";
    if (typeof input.op === "string") return input.op;
  }

  const keys = Object.keys(input);
  if (keys.length === 0) return "";

  // Common tool input patterns
  if ("command" in input) return formatToolPreviewValue(input.command).slice(0, 120);
  if ("path" in input) return formatToolPreviewValue(input.path).slice(0, 120);
  if ("file_path" in input) return formatToolPreviewValue(input.file_path).slice(0, 120);
  if ("pattern" in input) return formatToolPreviewValue(input.pattern).slice(0, 120);
  if ("query" in input) return formatToolPreviewValue(input.query).slice(0, 120);

  const first = input[keys[0]];
  return formatToolPreviewValue(first).slice(0, 120);
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

  if (category === "hub" && isRecord(input)) {
    if (input.op === "send") {
      const send = getHubSendSummary(input);
      if (send) return { action: "IRC", target: `→ ${send.to.join(", ")}` };
      return { action: "IRC", target: "send" };
    }
    if (input.op === "jobs") return { action: "hub", target: "jobs" };
    if (typeof input.op === "string") return { action: "hub", target: input.op };
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

export function formatToolCommand(block: ToolCallContent): string {
  const input = block.input;
  if (input && typeof input.command === "string") return input.command;
  if (getToolCategory(block.toolName) === "hub" && isRecord(input) && typeof input.op === "string") {
    if (input.op === "send") {
      const send = getHubSendSummary(input);
      return send ? `hub send → ${send.to.join(", ")}` : "hub send";
    }
    return `hub ${input.op}`;
  }
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
