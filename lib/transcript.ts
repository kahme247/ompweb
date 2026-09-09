// Markdown export for a session transcript. Ports the Tauri desktop app's
// session-menu "Copy transcript" (User/Assistant sections, thinking details,
// Tool/Shell sections) to the web sidebar. Pure formatter: no DOM, no fetch.
import type {
  AgentMessage,
  AssistantContentBlock,
  TextContent,
} from "./types";

export const TRANSCRIPT_BLOCK_CHAR_LIMIT = 20000;
export const TRANSCRIPT_TOTAL_CHAR_LIMIT = 500000;

export interface TranscriptMeta {
  title?: string;
  cwd?: string;
}

function truncateBlock(text: string): string {
  if (text.length <= TRANSCRIPT_BLOCK_CHAR_LIMIT) return text;
  return `${text.slice(0, TRANSCRIPT_BLOCK_CHAR_LIMIT)}\n\n…(truncated ${text.length - TRANSCRIPT_BLOCK_CHAR_LIMIT} chars)`;
}

function pickFence(text: string): string {
  return text.includes("```") ? "~~~~" : "```";
}

function fenced(text: string, language = ""): string {
  const fence = pickFence(text);
  return `${fence}${language}\n${text}\n${fence}`;
}

function textOf(content: string | (TextContent | { type: string })[]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push((block as TextContent).text);
    else if (block.type === "image") parts.push("[attached image]");
  }
  return parts.join("\n\n");
}

function assistantText(blocks: AssistantContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "image") parts.push("[attached image]");
  }
  return parts.join("\n\n");
}

function assistantThinking(blocks: AssistantContentBlock[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.type === "thinking" && block.thinking.trim()) {
      out.push(`<details><summary>Thinking</summary>\n\n${truncateBlock(block.thinking)}\n\n</details>`);
    }
  }
  return out;
}

function toolInputSummary(input: Record<string, unknown>): string {
  const keys = Object.keys(input);
  if (keys.length === 0) return "";
  return fenced(truncateBlock(JSON.stringify(input, null, 2)), "json");
}

/**
 * Render session messages as Markdown. Tool calls render with their JSON
 * input; matching tool results (by toolCallId) render beneath as fenced
 * output. Images degrade to a placeholder line since binary bytes cannot
 * travel through the clipboard.
 */
export function transcriptToMarkdown(messages: AgentMessage[], meta: TranscriptMeta = {}): string {
  const sections: string[] = [];
  if (meta.title) sections.push(`# ${meta.title}`);
  if (meta.cwd) sections.push(`_${meta.cwd}_`);

  const pendingResults = new Map<string, { name?: string; text: string; isError?: boolean }>();
  for (const message of messages) {
    if (message.role === "toolResult") {
      const text = textOf(message.content);
      pendingResults.set(message.toolCallId, {
        name: message.toolName,
        text,
        isError: message.isError,
      });
    }
  }
  const consumedResults = new Set<string>();

  for (const message of messages) {
    switch (message.role) {
      case "user": {
        const text = textOf(message.content).trim();
        if (text) sections.push(`## User\n\n${truncateBlock(text)}`);
        break;
      }
      case "assistant": {
        const header = message.provider || message.model ? `## Assistant (${[message.provider, message.model].filter(Boolean).join("/")})` : "## Assistant";
        const body: string[] = [];
        const text = assistantText(message.content).trim();
        if (text) body.push(truncateBlock(text));
        body.push(...assistantThinking(message.content));
        for (const block of message.content) {
          if (block.type !== "toolCall") continue;
          const lines = [`### Tool: ${block.toolName} \`${block.toolCallId}\``];
          const summary = toolInputSummary(block.input);
          if (summary) lines.push(summary);
          const result = pendingResults.get(block.toolCallId);
          if (result) {
            consumedResults.add(block.toolCallId);
            const label = result.isError ? "Tool result (error)" : "Tool result";
            const name = result.name ?? block.toolName;
            lines.push(`**${label}: ${name}**`);
            if (result.text.trim()) lines.push(fenced(truncateBlock(result.text.trim())));
            else lines.push("_(empty)_");
          }
          body.push(lines.join("\n\n"));
        }
        if (message.errorMessage) body.push(`**Error:** ${message.errorMessage}`);
        if (body.length > 0) sections.push(`${header}\n\n${body.join("\n\n")}`);
        break;
      }
      case "toolResult": {
        // Rendered under its tool call above; only orphan results (no
        // matching call in the transcript window) get their own section.
        if (consumedResults.has(message.toolCallId)) break;
        const text = textOf(message.content).trim();
        const label = message.isError ? "### Tool result (error)" : "### Tool result";
        const name = message.toolName ?? message.toolCallId;
        sections.push(text ? `${label}: ${name}\n\n${fenced(truncateBlock(text))}` : `${label}: ${name}\n\n_(empty)_`);
        break;
      }
      case "bashExecution": {
        const lines = [`### Shell: \`${message.command}\``];
        if (message.exitCode !== undefined || message.cancelled) {
          lines.push(`_exit ${message.cancelled ? "cancelled" : message.exitCode}_`);
        }
        if (message.output.trim()) lines.push(fenced(truncateBlock(message.output.trim())));
        sections.push(lines.join("\n\n"));
        break;
      }
      case "pythonExecution": {
        const lines = ["### Python"];
        lines.push(fenced(truncateBlock(message.code.trim()), "python"));
        if (message.output.trim()) lines.push(fenced(truncateBlock(message.output.trim())));
        sections.push(lines.join("\n\n"));
        break;
      }
      case "fileMention": {
        const lines = ["### Attached files"];
        for (const file of message.files) {
          lines.push(`- \`${file.path}\`${file.skippedReason ? ` _(${file.skippedReason})_` : ""}`);
        }
        sections.push(lines.join("\n"));
        break;
      }
      case "developer": {
        const text = textOf(message.content).trim();
        if (text) sections.push(`### System note\n\n${truncateBlock(text)}`);
        break;
      }
      case "custom": {
        if (!message.display) break;
        const text = textOf(message.content).trim();
        if (text) sections.push(`### ${message.customType}\n\n${truncateBlock(text)}`);
        break;
      }
    }
  }

  let markdown = `${sections.join("\n\n---\n\n")}\n`;
  if (markdown.length > TRANSCRIPT_TOTAL_CHAR_LIMIT) {
    markdown = `${markdown.slice(0, TRANSCRIPT_TOTAL_CHAR_LIMIT)}\n\n…(transcript truncated at ${TRANSCRIPT_TOTAL_CHAR_LIMIT} chars)\n`;
  }
  return markdown;
}
