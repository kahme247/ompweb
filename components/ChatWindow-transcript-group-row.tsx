"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, Layers } from "lucide-react";
import type { AgentMessage, AssistantContentBlock, AssistantMessage } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { completedTurnReplyIndex, type ActivityPiece, type TranscriptRow, type TranscriptSegment } from "@/lib/chat-transcript-plan";
import { assistantModelName, hasAssistantOutput, AssistantTurnHeader, TurnProgressHistory } from "./TranscriptOutput";

/** Renders one committed message, optionally as a partial/overridden view under its own key prefix. */
export type RenderMessage = (idx: number, options?: { attachRef?: boolean; keyPrefix?: string; messageOverride?: AgentMessage; showTimestamp?: boolean; sourceBlockIndices?: number[]; final?: boolean; latest?: boolean; followingActivity?: ReactNode }) => ReactNode;

/** A planned user turn: the user message plus its text and activity segments. */
export type TranscriptGroupRow = Extract<TranscriptRow, { kind: "group" }>;

/** What `renderTranscriptGroupRow` needs from `CommittedTranscript`. */
export interface TranscriptGroupRowContext {
  messages: AgentMessage[];
  renderMessage: RenderMessage;
  /** Render every message of the turn as its own row, nothing folded (the running turn with tool activity shown). */
  flat: boolean;
  messageRefs: React.RefObject<(HTMLDivElement | null)[]>;
  visibleRefIndexByMessage: Map<number, number>;
  entryIds: string[];
  modelNames: Record<string, string>;
  turnActive: boolean;
  latestOutputIndex: number;
  streamingHasOutput: boolean;
  searchQuery: string;
  expandThinkingByDefault: boolean;
  showToolCallsUnfolded: boolean;
}

function withAssistantBlocks(
  message: AssistantMessage,
  content: AssistantContentBlock[],
  options: { omitUsage?: boolean } = {},
): AssistantMessage {
  const next = { ...message, content };
  if (options.omitUsage) next.usage = undefined;
  return next;
}

function ProcessDetailsGroup({ messageCount, toolCallCount, children }: { messageCount: number; toolCallCount: number; children: () => ReactNode }) {
  const { t, tn } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const parts = [t("chatWindow.processDetails"), tn("chatWindow.messageCount", messageCount)];
  if (toolCallCount > 0) parts.push(tn("chatWindow.toolCallCount", toolCallCount));

  return (
    <div style={{ marginBottom: 4 }}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="process-details-toggle"
        title={expanded ? t("chatWindow.collapseProcessDetails") : t("chatWindow.expandProcessDetails")}
      >
        <Layers
          size={12}
          strokeWidth={1.8}
          aria-hidden="true"
          style={{ flexShrink: 0, color: "var(--accent)" }}
        />
        <ChevronDown
          size={12}
          strokeWidth={1.8}
          aria-hidden="true"
          style={{
            flexShrink: 0,
            transform: expanded ? "rotate(180deg)" : "none",
            transition: "transform var(--dur-fast) var(--ease-out-warm)",
          }}
        />
        <span className="process-details-label">
          {parts.join(" · ")}
        </span>
      </button>
      {expanded && (
        <div style={{ marginTop: 3 }}>
          {children()}
        </div>
      )}
    </div>
  );
}

/** Render a folded activity run exactly as it streamed: one entry per piece, never merged across messages. */
export function renderActivityPieces(messages: AgentMessage[], pieces: ActivityPiece[], renderMessage: RenderMessage): ReactNode[] {
  return pieces.map((piece, pieceIdx) => {
    if (!piece.blocks) return renderMessage(piece.index, { attachRef: false, keyPrefix: "activity" });
    const msg = messages[piece.index] as AssistantMessage;
    return renderMessage(piece.index, {
      attachRef: false,
      keyPrefix: `activity-${pieceIdx}`,
      messageOverride: { ...withAssistantBlocks(msg, piece.blocks, { omitUsage: true }), errorMessage: undefined },
      showTimestamp: false,
      sourceBlockIndices: piece.blocks.map((block) => msg.content.indexOf(block)),
    });
  });
}

/** Render one user turn as keyed transcript entries for `CommittedTranscript`'s row list. */
export function renderTranscriptGroupRow(row: TranscriptGroupRow, { messages, renderMessage, flat, messageRefs, visibleRefIndexByMessage, entryIds, modelNames, turnActive, latestOutputIndex, streamingHasOutput, searchQuery, expandThinkingByDefault, showToolCallsUnfolded }: TranscriptGroupRowContext): ReactNode[] {
  const { userIndex: userIdx, endIndex: endIdx, segments } = row;
  const rendered: ReactNode[] = [];
  const replyIndex = turnActive ? null : completedTurnReplyIndex(messages, userIdx, endIdx);
  const finalSegment = replyIndex === null ? -1 : segments.findLastIndex(segment => segment.kind === "text" && segment.index === replyIndex && segment.last);
  const firstText = segments.find(segment => segment.kind === "text");
  const headerMessage = replyIndex !== null ? messages[replyIndex] : firstText ? messages[firstText.index] : null;
  const turnHeader = headerMessage?.role === "assistant" ? <AssistantTurnHeader key={`header-${userIdx}`} model={assistantModelName(headerMessage, modelNames)} /> : null;

  rendered.push(renderMessage(userIdx));
  if (turnHeader) rendered.push(turnHeader);
  if (flat) {
    let previousModel = headerMessage?.role === "assistant" ? `${headerMessage.provider}:${headerMessage.model}` : "";
    for (let renderIdx = userIdx + 1; renderIdx < endIdx; renderIdx++) {
      const message = messages[renderIdx];
      if (message.role === "assistant" && hasAssistantOutput(message)) {
        const model = `${message.provider}:${message.model}`;
        if (model !== previousModel) rendered.push(<AssistantTurnHeader key={`header-${renderIdx}`} model={assistantModelName(message, modelNames)} />);
        previousModel = model;
      }
      rendered.push(renderMessage(renderIdx));
    }
    return rendered;
  }

  const lastTextSegment = segments.findLastIndex(segment => segment.kind === "text");
  const renderActivity = (segment: Extract<TranscriptSegment, { kind: "activity" }>, segmentIdx: number, attached: Set<number>): ReactNode => {
    const refIdx = segment.pieces
      .filter(piece => !attached.has(piece.index))
      .map(piece => visibleRefIndexByMessage.get(piece.index))
      .find((value): value is number => typeof value === "number");
    for (const piece of segment.pieces) attached.add(piece.index);
    return (
      <div key={`activity-${userIdx}-${segmentIdx}`} ref={refIdx === undefined ? undefined : el => { messageRefs.current[refIdx] = el; }}>
        <ProcessDetailsGroup messageCount={segment.stepCount} toolCallCount={segment.toolCallCount}>
          {() => renderActivityPieces(messages, segment.pieces, renderMessage)}
        </ProcessDetailsGroup>
      </div>
    );
  };
  const renderSegments = (from: number, to: number): ReactNode[] => {
    const output: ReactNode[] = [];
    // Reopening history must attach the same message refs again.
    const attached = new Set<number>();
    let previousModel = headerMessage?.role === "assistant" ? `${headerMessage.provider}:${headerMessage.model}` : "";
    for (let segmentIdx = from; segmentIdx < to; segmentIdx += 1) {
      const segment = segments[segmentIdx];
      if (segment.kind === "text") {
        const msg = messages[segment.index] as AssistantMessage;
        const model = `${msg.provider}:${msg.model}`;
        if (model !== previousModel) output.push(<AssistantTurnHeader key={`model-${userIdx}-${segmentIdx}`} model={assistantModelName(msg, modelNames)} />);
        previousModel = model;
        const override = withAssistantBlocks(msg, segment.blocks, { omitUsage: !segment.last });
        if (!segment.last) override.errorMessage = undefined;
        const attachRef = !attached.has(segment.index);
        attached.add(segment.index);
        const next = segments[segmentIdx + 1];
        const followingActivity = segmentIdx + 1 < to && next?.kind === "activity" ? renderActivity(next, segmentIdx + 1, attached) : undefined;
        output.push(renderMessage(segment.index, {
          attachRef,
          keyPrefix: `text-${segmentIdx}`,
          messageOverride: override,
          sourceBlockIndices: segment.blocks.map(block => msg.content.indexOf(block)),
          latest: segment.index === latestOutputIndex && !streamingHasOutput && segmentIdx === lastTextSegment,
          final: segmentIdx === finalSegment,
          followingActivity,
          ...(segment.last ? {} : { showTimestamp: false }),
        }));
        if (followingActivity) segmentIdx += 1;
      } else {
        output.push(renderActivity(segment, segmentIdx, attached));
      }
    }
    return output;
  };
  const progress = finalSegment > 0 ? segments.slice(0, finalSegment) : [];
  const outputCount = progress.filter(segment => segment.kind === "text").length;
  if (outputCount > 0 && replyIndex !== null && !searchQuery.trim() && !expandThinkingByDefault && !showToolCallsUnfolded) {
    const toolCallCount = progress.reduce((count, segment) => count + (segment.kind === "activity" ? segment.toolCallCount : 0), 0);
    const progressIndices = new Set(progress.flatMap(segment => segment.kind === "text" ? [segment.index] : segment.pieces.map(piece => piece.index)));
    progressIndices.delete(replyIndex);
    rendered.push(
      <TurnProgressHistory key={`progress-${userIdx}-${entryIds[replyIndex] ?? replyIndex}`} outputCount={outputCount} toolCallCount={toolCallCount}
        collapsedRef={el => { for (const index of progressIndices) { const refIdx = visibleRefIndexByMessage.get(index); if (refIdx !== undefined) messageRefs.current[refIdx] = el; } }}>
        {() => renderSegments(0, finalSegment)}
      </TurnProgressHistory>,
    );
    rendered.push(...renderSegments(finalSegment, segments.length));
  } else {
    rendered.push(...renderSegments(0, segments.length));
  }
  return rendered;
}
