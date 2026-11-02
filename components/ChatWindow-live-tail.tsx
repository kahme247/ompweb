"use client";

import type { AgentMessage, BashExecutionMessage, ToolResultMessage } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { MessageView } from "./MessageView";

/** Inputs `ChatLiveTail` needs from `ChatWindow`: the not-yet-committed end of the running turn. */
export interface ChatLiveTailProps {
  /** The reply omp is streaming, also while held until its committed row replaces it. */
  streamingMessage: Partial<AgentMessage> | null;
  liveTokensPerSecond?: number | null;
  /** Running tools no message renders yet, shown as status rows when tool calls are collapsed. */
  pendingToolHeaders: { id: string; name: string }[];
  /** A `!command` the user started that has no committed result yet. */
  pendingBash: { command: string; excludeFromContext: boolean } | null;
  toolResults: Map<string, ToolResultMessage>;
  modelNames: Record<string, string>;
  cwd: string | undefined;
  onOpenFile?: (filePath: string) => void;
  sessionId: string | undefined;
  toolCallsDefaultCollapsed: boolean;
  expandThinkingByDefault: boolean;
  hideThinking: boolean;
}

/** The running turn's live end, rendered after the committed transcript: streaming reply, pending tool rows, pending bash. */
export function ChatLiveTail({
  streamingMessage, liveTokensPerSecond, pendingToolHeaders, pendingBash, toolResults, modelNames, cwd, onOpenFile, sessionId,
  toolCallsDefaultCollapsed, expandThinkingByDefault, hideThinking,
}: ChatLiveTailProps) {
  const { t } = useI18n();
  return (
    <>
      {/* Also while held: a finished reply stays until its saved row
          replaces it in the same render (useAgentSession-stream). */}
      {streamingMessage && (
        <MessageView
          key={streamingMessage.timestamp ?? "stream"}
          message={streamingMessage as AgentMessage}
          modelNames={modelNames}
          cwd={cwd}
          onOpenFile={onOpenFile}
          toolResults={toolResults}
          toolCallsDefaultCollapsed={toolCallsDefaultCollapsed}
          expandThinkingByDefault={expandThinkingByDefault}
          hideThinking={hideThinking}
          liveTokensPerSecond={liveTokensPerSecond}
        />
      )}

      {toolCallsDefaultCollapsed && pendingToolHeaders.map((tool) => (
        <div
          key={tool.id}
          role="status"
          aria-label={t("chatWindow.runningNamed", { names: tool.name })}
          style={{
            display: "flex", alignItems: "center", gap: 7,
            marginBottom: 8, padding: "6px 10px",
            border: "1px solid color-mix(in srgb, var(--status-success) 25%, transparent)",
            borderRadius: "var(--radius-control)",
            background: "color-mix(in srgb, var(--status-success) 4%, transparent)",
            color: "var(--text-muted)", fontSize: 12,
          }}
        >
          <span aria-hidden className="live-status-dot live-pulse inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
          <span style={{ color: "var(--status-success)", fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 11 }}>{tool.name}</span>
        </div>
      ))}

      {pendingBash && (
        <MessageView
          message={{
            role: "bashExecution",
            command: pendingBash.command,
            output: "",
            excludeFromContext: pendingBash.excludeFromContext,
          } as BashExecutionMessage}
          sessionId={sessionId}
        />
      )}
    </>
  );
}
