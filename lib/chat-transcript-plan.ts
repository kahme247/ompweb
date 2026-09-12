import { getDisplayableAssistantBlocks, splitFinalAssistantBlocks } from "./message-display";
import type { AgentMessage, AssistantMessage, CustomMessage } from "./types";

/**
 * Lightweight transcript row planner for ChatWindow's committed transcript.
 *
 * The old render loop built ONE React element per message (plus per-process
 * group children) across the WHOLE history, then sliced the visible window at
 * the end — long sessions re-created elements for thousands of messages on
 * every committed update. This module separates the O(n) GROUPING pass (which
 * only inspects roles/blocks and produces plain row descriptors) from
 * element creation. The windowing math then skips element creation entirely
 * for rows outside the visible range, and process-detail content is created
 * only inside the (still collapsed by default) group body.
 *
 * Rows are appended in transcript order; a row is either:
 * - { kind: "message", index } — one message rendered standalone (toolResult,
 *   custom, an assistant row without a process group, …)
 * - { kind: "group", userIndex, endIndex, finalAssistantIndex, processIndices,
 *     processCount, toolCallCount } — the collapsed process-details group
 *     (anchor user/compaction messages + final answer render separately).
 */

export type TranscriptRow =
  | { kind: "message"; index: number }
  | {
      kind: "group";
      userIndex: number;
      endIndex: number;
      finalAssistantIndex: number;
      /** Indices of displayable in-process messages folded into the group. */
      processIndices: number[];
      processCount: number;
      toolCallCount: number;
      /** True when the group's final assistant message carries a displayable
       * final answer (text/image) that renders as a separate row. */
      hasFinalAnswer: boolean;
    };

export function hasFinalAssistantAnswer(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  if (message.errorMessage?.trim()) return true;
  return splitFinalAssistantBlocks(message as AssistantMessage).answerBlocks.some((block) => (
    block.type === "image" || (block.type === "text" && block.text.trim().length > 0)
  ));
}

function findFinalAssistantIndex(messages: AgentMessage[], userIdx: number, endIdx: number): number {
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (hasFinalAssistantAnswer(messages[candidateIdx])) return candidateIdx;
  }
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (messages[candidateIdx]?.role === "assistant") return candidateIdx;
  }
  return -1;
}

function countToolCallBlocks(blocks: AssistantMessage["content"]): number {
  let count = 0;
  for (const block of (blocks ?? []) as Array<{ type?: string }>) if (block.type === "toolCall") count += 1;
  return count;
}

export function countToolCalls(messages: AgentMessage[], indices: number[]): number {
  let count = 0;
  for (const idx of indices) {
    const msg = messages[idx];
    if (msg?.role !== "assistant") continue;
    count += countToolCallBlocks((msg as AssistantMessage).content);
  }
  return count;
}

export function hasDisplayableProcessMessage(message: AgentMessage): boolean {
  if (message.role === "assistant") {
    return getDisplayableAssistantBlocks(message as AssistantMessage).length > 0;
  }
  return message.role === "custom";
}

// A user message normally anchors a turn (user prompt → process → final
// answer), and the process messages in between get folded into a collapsed
// ProcessDetailsGroup. When compaction fires mid-turn, pi drops the original
// user prompt and inserts a compaction summary (role "custom", customType
// "compaction") in its place; the agent then keeps producing tool calls and a
// final answer with no user message left to anchor them. Treat a compaction
// summary as an anchor too, otherwise every post-compaction message renders
// standalone and never collapses.
export function isGroupAnchor(message: AgentMessage): boolean {
  if (message.role === "user") return true;
  return message.role === "custom" && (message as CustomMessage).customType === "compaction";
}

/**
 * Plan the transcript into lightweight row descriptors WITHOUT creating
 * React elements. O(history) but allocates only small objects; element
 * creation happens later for the visible window only.
 */
export function planTranscriptRows(messages: AgentMessage[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (let idx = 0; idx < messages.length;) {
    const msg = messages[idx];
    if (!isGroupAnchor(msg)) {
      rows.push({ kind: "message", index: idx });
      idx += 1;
      continue;
    }

    const userIdx = idx;
    let endIdx = userIdx + 1;
    while (endIdx < messages.length && !isGroupAnchor(messages[endIdx])) endIdx += 1;

    const finalAssistantIdx = findFinalAssistantIndex(messages, userIdx, endIdx);

    if (finalAssistantIdx === -1) {
      for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
        rows.push({ kind: "message", index: renderIdx });
      }
      idx = endIdx;
      continue;
    }

    const processIndices: number[] = [];
    for (let processIdx = userIdx + 1; processIdx < finalAssistantIdx; processIdx++) {
      processIndices.push(processIdx);
    }
    const visibleProcessIndices = processIndices.filter((processIdx) => hasDisplayableProcessMessage(messages[processIdx]));
    const finalAssistant = messages[finalAssistantIdx] as AssistantMessage;
    const finalSplit = splitFinalAssistantBlocks(finalAssistant);
    const processCount = visibleProcessIndices.length + (finalSplit.processBlocks.length > 0 ? 1 : 0);
    const toolCallCount = countToolCalls(messages, visibleProcessIndices)
      + countToolCallBlocks(finalSplit.processBlocks);

    if (processCount > 0) {
      rows.push({
        kind: "group",
        userIndex: userIdx,
        endIndex: endIdx,
        finalAssistantIndex: finalAssistantIdx,
        processIndices: visibleProcessIndices,
        processCount,
        toolCallCount,
        hasFinalAnswer: hasFinalAssistantAnswer(finalAssistant),
      });
    } else {
      // No disposable process content: render the anchor and the rest as
      // standalone messages (mirrors old behavior, no group row).
      for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
        rows.push({ kind: "message", index: renderIdx });
      }
    }
    idx = endIdx;
  }
  return rows;
}
