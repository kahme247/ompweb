import { isRecord } from "./type-guards";

/**
 * Whether a finished reply must be held on screen until its saved copy
 * lands (see the message_end handler in hooks/useAgentSession.ts). This is
 * hasVisibleAssistantContent plus non-empty thinking: a thinking row was
 * visible while streaming, so dropping it would flicker exactly like
 * dropping a text reply. Other call sites keep the stricter predicate —
 * a thinking-only run is not "content" for run-had-content purposes.
 */
export function hasHoldableAssistantContent(value: unknown): boolean {
  if (hasVisibleAssistantContent(value)) return true;
  if (!isRecord(value) || value.role !== "assistant" || !Array.isArray(value.content)) return false;
  return value.content.some((block) => isRecord(block)
    && block.type === "thinking"
    && typeof block.thinking === "string"
    && block.thinking.trim().length > 0);
}

/** Tool calls and empty assistant envelopes are not a response. */
export function hasVisibleAssistantContent(value: unknown): boolean {
  if (!isRecord(value) || value.role !== "assistant") return false;
  if (!Array.isArray(value.content)) return typeof value.content === "string" && value.content.trim().length > 0;
  return value.content.some((block) => {
    if (!isRecord(block)) return false;
    if (block.type === "text") return typeof block.text === "string" && block.text.trim().length > 0;
    if (block.type === "image") return true;
    return false;
  });
}
