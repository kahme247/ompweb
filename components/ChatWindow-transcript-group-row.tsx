"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, Layers } from "lucide-react";
import type { AgentMessage, AssistantContentBlock, AssistantMessage } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import type { ActivityPiece, TranscriptRow } from "@/lib/chat-transcript-plan";

/** Renders one committed message, optionally as a partial/overridden view under its own key prefix. */
export type RenderMessage = (idx: number, options?: { attachRef?: boolean; keyPrefix?: string; messageOverride?: AgentMessage; showTimestamp?: boolean; sourceBlockIndices?: number[] }) => ReactNode;

/** A planned user turn (user message plus its folded text/activity segments). */
export type TranscriptGroupRow = Extract<TranscriptRow, { kind: "group" }>;

/** Inputs `renderTranscriptGroupRow` needs from the committed transcript. */
export interface TranscriptGroupRowContext {
  messages: AgentMessage[];
  renderMessage: RenderMessage;
  /** The running turn: render it flat instead of folded. */
  live: boolean;
  messageRefs: React.RefObject<(HTMLDivElement | null)[]>;
  visibleRefIndexByMessage: Map<number, number>;
}

/** Copy of `message` showing only `content`, a text segment's share of a split assistant message. */
function withAssistantBlocks(
  message: AssistantMessage,
  content: AssistantContentBlock[],
  options: { omitUsage?: boolean } = {},
): AssistantMessage {
  const next = { ...message, content };
  if (options.omitUsage) next.usage = undefined;
  return next;
}

/** Collapsed "Process details" row; `children` renders the folded activity only once expanded. */
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

/** Render one user turn as flat, keyed transcript entries for the caller's row list. */
export function renderTranscriptGroupRow(row: TranscriptGroupRow, { messages, renderMessage, live, messageRefs, visibleRefIndexByMessage }: TranscriptGroupRowContext): ReactNode[] {
  const { userIndex: userIdx, endIndex: endIdx, segments } = row;
  const rendered: ReactNode[] = [];

  if (live) {
    // Live tail: render the running turn flat so streaming updates and tool
    // progress stay in view; it folds once the run ends.
    for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
      rendered.push(renderMessage(renderIdx));
    }
    return rendered;
  }

  rendered.push(renderMessage(userIdx));
  // A message split across segments keeps its navigation ref on the first one.
  const attached = new Set<number>();
  segments.forEach((segment, segmentIdx) => {
    if (segment.kind === "text") {
      const msg = messages[segment.index] as AssistantMessage;
      const override = withAssistantBlocks(msg, segment.blocks, { omitUsage: !segment.last });
      if (!segment.last) override.errorMessage = undefined;
      rendered.push(renderMessage(segment.index, {
        attachRef: !attached.has(segment.index),
        keyPrefix: `text-${segmentIdx}`,
        messageOverride: override,
        ...(segment.last ? {} : { showTimestamp: false }),
      }));
      attached.add(segment.index);
      return;
    }
    const refIdx = segment.pieces
      .filter((piece) => !attached.has(piece.index))
      .map((piece) => visibleRefIndexByMessage.get(piece.index))
      .find((value): value is number => typeof value === "number");
    for (const piece of segment.pieces) attached.add(piece.index);
    rendered.push(
      <div
        key={`activity-${userIdx}-${segmentIdx}`}
        ref={refIdx === undefined ? undefined : (el) => { messageRefs.current[refIdx] = el; }}
      >
        <ProcessDetailsGroup messageCount={segment.stepCount} toolCallCount={segment.toolCallCount}>
          {() => renderActivityPieces(messages, segment.pieces, renderMessage)}
        </ProcessDetailsGroup>
      </div>,
    );
  });
  return rendered;
}
