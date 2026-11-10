"use client";

import { useId, useState, type ReactNode, type Ref } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { AgentMessage, AssistantMessage } from "@/lib/types";

export function hasAssistantOutput(message: Partial<AgentMessage> | null): boolean {
  return message?.role === "assistant" && ((Array.isArray(message.content) && message.content.some(block =>
    block.type === "image" || (block.type === "text" && block.text.trim().length > 0),
  )) || !!message.errorMessage?.trim() || message.stopReason === "error" || message.stopReason === "aborted");
}

export function assistantModelName(message: AssistantMessage, names: Record<string, string>): string {
  return names[`${message.provider}:${message.model}`] ?? names[message.model] ?? message.model ?? "";
}

export function AssistantTurnHeader({ model }: { model: string }) {
  return (
    <div className="assistant-turn-header">
      <span className="assistant-turn-icon"><Sparkles size={14} strokeWidth={1.8} aria-hidden="true" /></span>
      <span className="assistant-turn-name">AI</span>
      {model && <span>{model}</span>}
    </div>
  );
}

export function AssistantOutputStep({ latest, final, active = true, children }: { latest?: boolean; final?: boolean; active?: boolean; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className={active ? `assistant-output-step${latest ? " assistant-output-latest" : ""}${final ? " assistant-output-final" : ""}` : undefined}>
      {(latest || final) && <div className="assistant-output-label">{t(final ? "chatWindow.finalReply" : "chatWindow.latestOutput")}</div>}
      {children}
    </div>
  );
}

/** Only mounted for a completed turn. A new final entry remounts this fold,
 * so continuing a task and finishing again folds the new progress as well. */
export function TurnProgressHistory({ outputCount, toolCallCount, collapsedRef, children }: {
  outputCount: number;
  toolCallCount: number;
  collapsedRef?: Ref<HTMLDivElement>;
  children: () => ReactNode;
}) {
  const { t, tn } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  return (
    <div className="turn-progress-history" ref={expanded ? undefined : collapsedRef}>
      <button type="button" className="turn-progress-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}>
        <ChevronRight size={13} strokeWidth={1.8} aria-hidden="true" />
        <span>{t("chatWindow.turnProgress")}</span>
        <span className="turn-progress-count">{tn("chatWindow.outputCount", outputCount)}{toolCallCount > 0 && ` · ${tn("chatWindow.toolCallCount", toolCallCount)}`}</span>
        <span className="turn-progress-action">{t(expanded ? "chatWindow.collapseProgress" : "chatWindow.expandProgress")}</span>
      </button>
      <div id={contentId} hidden={!expanded}>{expanded && children()}</div>
    </div>
  );
}
