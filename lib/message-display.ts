import type { AssistantContentBlock, AssistantMessage, ThinkingContent } from "./types";

interface DisplayOptions {
  isStreaming?: boolean;
}

export function isEmptyThinkingBlock(block: AssistantContentBlock, options: DisplayOptions = {}): block is ThinkingContent {
  return block.type === "thinking" && !block.deferred && !options.isStreaming && block.thinking.trim() === "";
}

/** Reply content (non-blank text or an image), as opposed to thinking and tool activity. */
export function isReplyBlock(block: AssistantContentBlock): boolean {
  return block.type === "image" || (block.type === "text" && block.text.trim().length > 0);
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  return (message.content ?? []).filter((block) => !isEmptyThinkingBlock(block, options));
}
