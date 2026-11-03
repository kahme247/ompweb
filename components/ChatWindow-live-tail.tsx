"use client";

import type { AgentMessage, AssistantMessage, BashExecutionMessage, ToolResultMessage } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { MessageView } from "./MessageView";
import { assistantModelName, AssistantOutputStep, AssistantTurnHeader, hasAssistantOutput } from "./TranscriptOutput";

/** What `ChatLiveTail` needs from `ChatWindow`: the not-yet-committed end of the running turn. */
export interface ChatLiveTailProps {
  /** The reply omp is streaming, also while held until its committed row replaces it. */
  streamingMessage: Partial<AgentMessage> | null;
  isStreaming: boolean;
  /** Provider and model of the preceding visible assistant output, if any. */
  previousOutputModel: string | null;
  liveTokensPerSecond?: number | null;
  /** Running tools no message renders yet, shown as status rows while tool calls are collapsed. */
  pendingToolHeaders: { id: string; name: string }[];
  /** `!command` results omp holds back until a later prompt records them. */
  deferredBash: BashExecutionMessage[];
  /** A `!command` the user started that has no result yet. */
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

/** The running turn's live end after the committed transcript: streaming reply, pending tool rows, `!command` output. */
export function ChatLiveTail({
  streamingMessage, isStreaming, previousOutputModel, liveTokensPerSecond, pendingToolHeaders, deferredBash, pendingBash, toolResults, modelNames, cwd, onOpenFile, sessionId,
  toolCallsDefaultCollapsed, expandThinkingByDefault, hideThinking,
}: ChatLiveTailProps) {
  const { t } = useI18n();
  const hasOutput = streamingMessage?.role === "assistant" && hasAssistantOutput(streamingMessage);
  return (
    <>
      {/* Also while held: a finished reply stays until its saved row
          replaces it in the same render (useAgentSession-stream). */}
      {streamingMessage && (
        <>
          {hasOutput && streamingMessage.role === "assistant" && previousOutputModel !== `${streamingMessage.provider}:${streamingMessage.model}` && (
            <AssistantTurnHeader model={assistantModelName(streamingMessage as AssistantMessage, modelNames)} />
          )}
          <AssistantOutputStep active={hasOutput} latest={hasOutput}>
            <MessageView
              key={streamingMessage.timestamp ?? "stream"}
              message={streamingMessage as AgentMessage}
              isStreaming={isStreaming}
              modelNames={modelNames}
              cwd={cwd}
              onOpenFile={onOpenFile}
              toolResults={toolResults}
              toolCallsDefaultCollapsed={toolCallsDefaultCollapsed}
              expandThinkingByDefault={expandThinkingByDefault}
              hideThinking={hideThinking}
              liveTokensPerSecond={liveTokensPerSecond}
              hideModelLabel={hasOutput}
              compactActions={hasOutput}
            />
          </AssistantOutputStep>
        </>
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

      {deferredBash.map((message, index) => (
        <MessageView
          key={index}
          message={message}
          sessionId={sessionId}
        />
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
