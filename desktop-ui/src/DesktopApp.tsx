import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { AppWindow, ArrowLeft, ArrowRight, ArrowUp, Brain, FolderOpen, GitBranch, HardDrive, Minus, PanelLeft, Plus, Settings, Shield, Sparkles, Square, X } from "lucide-react";
import { MessageView } from "@/components/MessageView";
import { ChatMinimap } from "@/components/ChatMinimap";
import { normalizeToolCalls } from "@/lib/normalize";
import { selectableThinkingLevels, thinkingLevelsForMeta } from "@/lib/thinking-levels";
import { formatTokens, formatCost } from "@/lib/subagent-format";
import { useTheme } from "@/hooks/useTheme";
import { Sidebar, projectLabel, type SidebarSession } from "./Sidebar";
import { SettingsView, type LoginProvider } from "./SettingsView";
import type { AgentMessage, AssistantMessage, ToolResultMessage } from "@/lib/types";

type SessionState = "idle" | "starting" | "ready" | "running" | "exited";

type RpcFrame = {
  type: string;
  message?: { role?: string; [key: string]: unknown };
  assistantMessageEvent?: { type?: string; delta?: string };
};

type OmpModelInfo = {
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
  thinking?: { efforts?: string[] };
};

type StateResponse = {
  model?: { id?: string; provider?: string };
  thinkingLevel?: string;
  contextUsage?: { tokens: number; contextWindow: number; percent: number };
};

type CwdInfo = { project: string; branch: string; diffAdded: number; diffRemoved: number };

type ApprovalMode = "default" | "always-ask" | "write" | "yolo";

const APPROVAL_LABELS: Record<ApprovalMode, string> = {
  default: "Default",
  "always-ask": "Ask",
  write: "Write access",
  yolo: "Full access",
};

const NO_DIFF: CwdInfo = { project: "", branch: "", diffAdded: 0, diffRemoved: 0 };

const appWindow = getCurrentWindow();

function firstUserText(messages: AgentMessage[]): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === "text" && typeof block.text === "string") return block.text;
      }
    }
  }
  return "";
}

export function DesktopApp() {
  useTheme();
  const [home, setHome] = useState("");
  const [cwd, setCwd] = useState("");
  const [session, setSession] = useState<SessionState>("idle");
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [toolResults, setToolResults] = useState<Map<string, ToolResultMessage>>(new Map());
  const [streaming, setStreaming] = useState<AssistantMessage | null>(null);
  const [error, setError] = useState("");
  const [input, setInput] = useState("");
  const [sessions, setSessions] = useState<SidebarSession[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [histPast, setHistPast] = useState<SidebarSession[]>([]);
  const [histFuture, setHistFuture] = useState<SidebarSession[]>([]);
  const [cwdInfo, setCwdInfo] = useState<CwdInfo>(NO_DIFF);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(() => {
    try {
      const v = localStorage.getItem("omp-desktop-approval-mode");
      return v === "always-ask" || v === "write" || v === "yolo" ? v : "default";
    } catch {
      return "default";
    }
  });
  const [refreshTick, setRefreshTick] = useState(0);
  const [editingCwd, setEditingCwd] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [models, setModels] = useState<OmpModelInfo[]>([]);
  const [activeModel, setActiveModel] = useState<{ provider: string; id: string } | null>(null);
  const [thinkingLevel, setThinkingLevel] = useState("");
  const [contextUsage, setContextUsage] = useState<StateResponse["contextUsage"]>(undefined);
  const sessionRef = useRef<SessionState>("idle");
  sessionRef.current = session;

  const rpc = useCallback(
    <T,>(command: Record<string, unknown>) => invoke<T>("omp_send", { command }),
    [],
  );

  useEffect(() => {
    // Project windows get their cwd from the Rust window registry; the main
    // window falls back to the last-used directory, then home.
    if (getCurrentWindow().label.startsWith("chat-")) {
      invoke<{ cwd?: string | null }>("omp_window_boot")
        .then((b) => {
          if (b.cwd) {
            setCwd(b.cwd);
            setHome(b.cwd);
          }
        })
        .catch(() => {});
    } else {
      invoke<string>("omp_home")
        .then((h) => {
          setHome(h);
          let stored: string | null = null;
          try {
            stored = localStorage.getItem("omp-desktop-cwd");
          } catch {
            // storage unavailable falls back to home
          }
          setCwd((c) => c || stored || h);
        })
        .catch(() => {});
    }
    invoke<SidebarSession[]>("omp_list_sessions")
      .then(setSessions)
      .catch(() => {});
  }, []);

  const saveCwd = useCallback((dir: string) => {
    try {
      localStorage.setItem("omp-desktop-cwd", dir);
    } catch {
      // persistence is best-effort
    }
  }, []);

  // Re-apply persisted shell settings (Rust defaults reset on restart).
  useEffect(() => {
    try {
      const raw = localStorage.getItem("omp-desktop-settings");
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "boolean") {
          invoke("omp_shell_set_setting", { key, value }).catch(() => {});
        }
      }
    } catch {
      // malformed storage falls back to Rust defaults
    }
  }, []);

  // Context row under the composer: project name + git branch (debounced —
  // the cwd field is editable and fires this on every keystroke).
  useEffect(() => {
    const dir = cwd.trim();
    if (!dir) {
      setCwdInfo(NO_DIFF);
      return;
    }
    const t = setTimeout(() => {
      invoke<CwdInfo>("omp_cwd_info", { cwd: dir })
        .then(setCwdInfo)
        .catch(() => setCwdInfo({ ...NO_DIFF, project: projectLabel(dir) }));
    }, 350);
    return () => clearTimeout(t);
  }, [cwd, refreshTick]);

  useEffect(() => {
    const putToolResult = (msg: ToolResultMessage) => {
      setToolResults((prev) => {
        const next = new Map(prev);
        next.set(msg.toolCallId, msg);
        return next;
      });
    };

    const unlisteners: Promise<UnlistenFn>[] = [
      listen<RpcFrame>("omp-frame", (event) => {
        const frame = event.payload;
        const wire = frame.message as AgentMessage | undefined;
        switch (frame.type) {
          case "message_start": {
            if (wire?.role === "user") {
              setMessages((m) => [...m, wire]);
            } else if (wire?.role === "assistant") {
              setStreaming(normalizeToolCalls(wire) as AssistantMessage);
            } else if (wire?.role === "toolResult") {
              putToolResult(wire as ToolResultMessage);
            }
            break;
          }
          case "message_update": {
            // frame.message is omp's full partial AssistantMessage — the app's
            // own type, no manual delta accumulation needed.
            if (wire?.role === "assistant") {
              setStreaming(normalizeToolCalls(wire) as AssistantMessage);
            }
            break;
          }
          case "message_end": {
            if (wire?.role === "assistant") {
              const done = normalizeToolCalls(wire) as AssistantMessage;
              setMessages((m) => [...m, done]);
              setStreaming(null);
            } else if (wire?.role === "toolResult") {
              putToolResult(wire as ToolResultMessage);
            }
            break;
          }
          case "agent_start":
            setSession("running");
            break;
          case "agent_end":
            if (sessionRef.current !== "exited") setSession("ready");
            setRefreshTick((t) => t + 1);
            break;
        }
      }),
      listen<{ code: number | null }>("omp-exit", () => {
        setSession("exited");
        setStreaming(null);
      }),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()));
    };
  }, []);

  // get_state is authoritative: omp may fall back to a default model that
  // differs from what we set, so the pickers re-sync from it after changes.
  const refreshSessionState = useCallback(async () => {
    try {
      const state = await rpc<StateResponse>({ type: "get_state" });
      const model = state.model;
      if (model?.provider && model.id) setActiveModel({ provider: model.provider, id: model.id });
      if (typeof state.thinkingLevel === "string") setThinkingLevel(state.thinkingLevel);
      setContextUsage(
        state.contextUsage && typeof state.contextUsage.percent === "number"
          ? state.contextUsage
          : undefined,
      );
    } catch {
      // session gone mid-refresh; the exit handler owns the UI from here
    }
  }, [rpc]);

  // While a run streams, keep the context gauge moving without waiting for
  // agent_end (the frame handlers only bump the tick at turn boundaries).
  useEffect(() => {
    if (session !== "running") return;
    const id = setInterval(() => void refreshSessionState(), 5000);
    return () => clearInterval(id);
  }, [session, refreshSessionState]);

  const loadModels = useCallback(async () => {
    try {
      const res = await rpc<{ models?: OmpModelInfo[] }>({ type: "get_available_models" });
      const list = Array.isArray(res.models)
        ? res.models.filter((m) => m && typeof m.id === "string" && typeof m.provider === "string")
        : [];
      setModels(list);
    } catch {
      setModels([]);
    }
  }, [rpc]);

  const resetTranscript = useCallback(() => {
    setMessages([]);
    setToolResults(new Map());
    setStreaming(null);
    messageRefs.current = [];
  }, []);

  const beginSession = useCallback(async () => {
    setSession("starting");
    setError("");
    resetTranscript();
    setActiveFile(null);
    saveCwd(cwd.trim());
    try {
      await invoke("omp_start", { cwd: cwd.trim(), approvalMode });
      setSession("ready");
      void loadModels();
      void refreshSessionState();
      return true;
    } catch (err) {
      setError(String(err));
      setSession("idle");
      return false;
    }
  }, [cwd, approvalMode, loadModels, refreshSessionState, resetTranscript, saveCwd]);

  const stop = useCallback(async () => {
    if (sessionRef.current === "running") {
      // interrupt the run; the session stays open
      rpc({ type: "abort" }).catch(() => {});
      return;
    }
    await invoke("omp_stop").catch(() => {});
    setSession("idle");
  }, [rpc]);

  const send = useCallback(async () => {
    const message = input.trim();
    if (!message || session === "starting" || session === "running") return;
    setInput("");
    setError("");
    try {
      if (sessionRef.current !== "ready") {
        const ok = await beginSession();
        if (!ok) return;
      }
      setSession("running");
      await invoke("omp_send", { command: { type: "prompt", message } });
      setSession("ready");
    } catch (err) {
      setError(String(err));
      setSession(sessionRef.current === "exited" ? "exited" : "ready");
    }
  }, [input, session, beginSession]);

  // Resume a stored session: spawn omp with --resume, then load its transcript
  // from disk (frames from omp continue the same message list).
  const currentSession = activeFile ? sessions.find((s) => s.file === activeFile) : undefined;

  const resume = useCallback(async (info: SidebarSession, push = true) => {
    const dir = info.cwd?.trim();
    if (!dir) {
      setError("Session has no cwd recorded.");
      return;
    }
    if (push && currentSession && currentSession.file !== info.file) {
      setHistPast((p) => [...p, currentSession]);
      setHistFuture([]);
    }
    setSession("starting");
    setError("");
    resetTranscript();
    setCwd(dir);
    saveCwd(dir);
    setActiveFile(info.file);
    try {
      await invoke("omp_start", { cwd: dir, resume: info.file, approvalMode });
      const msgs = await invoke<AgentMessage[]>("omp_read_session", { file: info.file });
      setMessages(msgs.map((m) => normalizeToolCalls(m)));
      setSession("ready");
      void loadModels();
      void refreshSessionState();
      invoke<SidebarSession[]>("omp_list_sessions").then(setSessions).catch(() => {});
    } catch (err) {
      setError(String(err));
      setSession("idle");
      setActiveFile(null);
    }
  }, [approvalMode, currentSession, loadModels, refreshSessionState, resetTranscript, saveCwd]);

  const goBack = useCallback(() => {
    const prev = histPast[histPast.length - 1];
    if (!prev) return;
    setHistPast((p) => p.slice(0, -1));
    if (currentSession) setHistFuture((f) => [...f, currentSession]);
    void resume(prev, false);
  }, [histPast, currentSession, resume]);

  const goForward = useCallback(() => {
    const next = histFuture[histFuture.length - 1];
    if (!next) return;
    setHistFuture((f) => f.slice(0, -1));
    if (currentSession) setHistPast((p) => [...p, currentSession]);
    void resume(next, false);
  }, [histFuture, currentSession, resume]);

  const changeApproval = useCallback((mode: ApprovalMode) => {
    setApprovalMode(mode);
    try {
      localStorage.setItem("omp-desktop-approval-mode", mode);
    } catch {
      // persistence is best-effort
    }
  }, []);

  const changeModel = useCallback(
    async (provider: string, modelId: string) => {
      setActiveModel({ provider, id: modelId });
      try {
        await rpc({ type: "set_model", provider, modelId });
      } catch (err) {
        setError(String(err));
      }
      void refreshSessionState();
    },
    [rpc, refreshSessionState],
  );

  const changeThinking = useCallback(
    async (level: string) => {
      setThinkingLevel(level);
      try {
        await rpc({ type: "set_thinking_level", level });
      } catch (err) {
        setError(String(err));
      }
      void refreshSessionState();
    },
    [rpc, refreshSessionState],
  );

  const modelGroups = useMemo(() => {
    const byProvider = new Map<string, OmpModelInfo[]>();
    for (const m of models) {
      const list = byProvider.get(m.provider) ?? [];
      list.push(m);
      byProvider.set(m.provider, list);
    }
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    for (const list of byProvider.values()) {
      list.sort((a, b) => collator.compare(a.name || a.id, b.name || b.id));
    }
    return [...byProvider.entries()].sort(([a], [b]) => collator.compare(a, b));
  }, [models]);

  // Catalog ladder wins; a non-catalog active model falls back to generic
  // levels so the dropdown still works for disabled/renamed providers.
  const thinkingOptions = useMemo(() => {
    const live = activeModel
      ? models.find((m) => m.provider === activeModel.provider && m.id === activeModel.id)
      : undefined;
    return selectableThinkingLevels(
      live
        ? thinkingLevelsForMeta({ provider: live.provider, modelId: live.id, reasoning: live.reasoning, thinking: live.thinking })
        : null,
    );
  }, [models, activeModel]);

  const modelValue = activeModel ? `${activeModel.provider}|${activeModel.id}` : "";
  const activeInCatalog = activeModel
    ? models.some((m) => m.provider === activeModel.provider && m.id === activeModel.id)
    : false;

  const activeSession = activeFile ? sessions.find((s) => s.file === activeFile) : undefined;
  const title =
    activeSession?.title ||
    (messages.length > 0 ? firstUserText(messages).slice(0, 80) : "") ||
    "New Task";
  const running = session === "running";

  // Cumulative tokens processed / cost across the session's assistant turns.
  const sessionUsage = useMemo(() => {
    let tokens = 0;
    let cost = 0;
    let any = false;
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      const u = (m as AssistantMessage).usage;
      if (!u) continue;
      any = true;
      tokens += u.totalTokens ?? u.input + u.output + u.cacheRead + u.cacheWrite;
      cost += u.cost?.total ?? 0;
    }
    return any ? { tokens, cost } : null;
  }, [messages]);

  return (
    <div className="desktop-app">
      {sidebarOpen && (
        <aside className="desktop-sidebar">
          <div className="sidebar-actions">
            <div className="sidebar-nav-row">
              <button
                className="sidebar-icon-btn"
                onClick={goBack}
                disabled={histPast.length === 0}
                title="Back"
              >
                <ArrowLeft size={14} aria-hidden />
              </button>
              <button
                className="sidebar-icon-btn"
                onClick={goForward}
                disabled={histFuture.length === 0}
                title="Forward"
              >
                <ArrowRight size={14} aria-hidden />
              </button>
            </div>
            <button className="sidebar-new-task" onClick={() => void beginSession()} disabled={!cwd.trim()}>
              <Plus size={15} aria-hidden />
              New Task
            </button>
          </div>
          <Sidebar
            sessions={sessions}
            activeFile={activeFile}
            onOpen={(s) => void resume(s)}
          />
          <div className="sidebar-footer">
            <button
              className="sidebar-icon-btn"
              onClick={() => void invoke("omp_open_project_window", { cwd: cwd.trim() }).catch(() => {})}
              disabled={!cwd.trim()}
              title="Open this project in its own window"
            >
              <AppWindow size={15} aria-hidden />
            </button>
            <span className="sidebar-footer-spacer" />
            <button
              className="sidebar-icon-btn"
              onClick={() => setSettingsOpen(true)}
              title="Settings"
            >
              <Settings size={15} aria-hidden />
            </button>
          </div>
        </aside>
      )}

      <div className="desktop-main">
        <header className="desktop-titlebar" data-tauri-drag-region>
          <button
            className="titlebar-btn"
            onClick={() => setSidebarOpen((v) => !v)}
            title="Toggle sidebar"
          >
            <PanelLeft size={15} aria-hidden />
          </button>
          <div className="titlebar-title" data-tauri-drag-region>
            {settingsOpen ? "Settings" : title}
          </div>
          {!settingsOpen && (cwdInfo.diffAdded > 0 || cwdInfo.diffRemoved > 0) && (
            <span className="titlebar-diff" title="Working-tree changes vs HEAD">
              <span className="diff-add">+{cwdInfo.diffAdded.toLocaleString()}</span>{" "}
              <span className="diff-del">-{cwdInfo.diffRemoved.toLocaleString()}</span>
            </span>
          )}
          <div className="titlebar-drag" data-tauri-drag-region />
          <div className="titlebar-controls">
            <button className="titlebar-btn" onClick={() => void appWindow.minimize()} title="Minimize">
              <Minus size={14} aria-hidden />
            </button>
            <button className="titlebar-btn" onClick={() => void appWindow.toggleMaximize()} title="Maximize">
              <Square size={11} aria-hidden />
            </button>
            <button
              className="titlebar-btn titlebar-close"
              onClick={() => void appWindow.close()}
              title="Close to tray"
            >
              <X size={14} aria-hidden />
            </button>
          </div>
        </header>

        {error && !settingsOpen && <div className="desktop-error">{error}</div>}

        {settingsOpen ? (
          <SettingsView
            onBack={() => setSettingsOpen(false)}
            providersLoader={() =>
              rpc<{ providers?: LoginProvider[] }>({ type: "get_login_providers" }).then(
                (res) => (Array.isArray(res.providers) ? res.providers : []),
              )
            }
          />
        ) : (
          <>
            <main className="desktop-transcript" ref={scrollRef}>
              <div className="transcript-inner">
                <div className="transcript-column">
                  {messages.length === 0 && !streaming && (
                    <div className="desktop-empty">
                      {session === "starting"
                        ? "Starting omp…"
                        : session === "exited"
                          ? "omp exited. Start a new task."
                          : "Do anything…"}
                    </div>
                  )}
                  {messages.map((m, i) => (
                    <div
                      key={i}
                      className="transcript-message"
                      ref={(el) => {
                        messageRefs.current[i] = el;
                      }}
                    >
                      <MessageView message={m} toolResults={toolResults} cwd={cwd} />
                    </div>
                  ))}
                  {streaming && (
                    <MessageView message={streaming} isStreaming toolResults={toolResults} cwd={cwd} />
                  )}
                </div>
              </div>
            </main>
            <ChatMinimap messages={messages} scrollContainer={scrollRef} messageRefs={messageRefs} />

        <footer className="desktop-composer">
          <div className="composer-box">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder="Do anything…"
              disabled={session === "starting"}
              rows={2}
              spellCheck={false}
            />
            <div className="composer-row">
              <div className="composer-controls">
                {session !== "idle" && session !== "exited" && (
                  <>
                    <label className="composer-chip" title="Model">
                      <Sparkles size={12} aria-hidden />
                      <select
                        className="composer-select"
                        value={modelValue}
                        onChange={(e) => {
                          const [provider, id] = e.target.value.split("|");
                          if (provider && id) void changeModel(provider, id);
                        }}
                        disabled={running}
                        aria-label="Model"
                      >
                        {activeModel && !activeInCatalog && (
                          <option value={modelValue}>{activeModel.id}</option>
                        )}
                        {modelGroups.map(([provider, list]) => (
                          <optgroup key={provider} label={provider}>
                            {list.map((m) => (
                              <option key={m.id} value={`${provider}|${m.id}`}>
                                {m.name || m.id}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    </label>
                    <label className="composer-chip" title="Thinking level">
                      <Brain size={12} aria-hidden />
                      <select
                        className="composer-select"
                        value={thinkingLevel || "auto"}
                        onChange={(e) => void changeThinking(e.target.value)}
                        disabled={running}
                        aria-label="Thinking level"
                      >
                        {thinkingOptions.map((lvl) => (
                          <option key={lvl} value={lvl}>
                            {lvl}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
              </div>
              {running ? (
                <button className="composer-send stop" onClick={() => void stop()} title="Stop">
                  <Square size={12} aria-hidden />
                </button>
              ) : (
                <button
                  className="composer-send"
                  onClick={() => void send()}
                  disabled={!input.trim() || session === "starting" || !cwd.trim()}
                  title="Send"
                >
                  <ArrowUp size={15} aria-hidden />
                </button>
              )}
            </div>
          </div>
          <div className="composer-context">
            {editingCwd ? (
              <input
                className="context-cwd-input"
                autoFocus
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    saveCwd(e.currentTarget.value.trim());
                    setEditingCwd(false);
                  } else if (e.key === "Escape") {
                    setEditingCwd(false);
                  }
                }}
                onBlur={() => {
                  saveCwd(cwd.trim());
                  setEditingCwd(false);
                }}
                placeholder={home || "working directory"}
                spellCheck={false}
              />
            ) : (
              <button
                className="context-chip editable"
                onClick={() => setEditingCwd(true)}
                title="Change working directory"
              >
                <FolderOpen size={12} aria-hidden />
                {cwdInfo.project || projectLabel(cwd) || "Set directory"}
              </button>
            )}
            {cwdInfo.branch && (
              <span className="context-chip branch">
                <GitBranch size={12} aria-hidden />
                {cwdInfo.branch}
              </span>
            )}
            <span className="context-chip" title="Sessions run locally on this machine">
              <HardDrive size={12} aria-hidden />
              Local
            </span>
            <label className="composer-chip context-approval" title="Tool approval mode — applies when the next session starts">
              <Shield size={12} aria-hidden />
              <select
                className="composer-select"
                value={approvalMode}
                onChange={(e) => changeApproval(e.target.value as ApprovalMode)}
                aria-label="Approval mode"
              >
                {(Object.keys(APPROVAL_LABELS) as ApprovalMode[]).map((mode) => (
                  <option key={mode} value={mode}>
                    {APPROVAL_LABELS[mode]}
                  </option>
                ))}
              </select>
            </label>
            <span className="context-spacer" />
            {sessionUsage && (
              <span
                className="context-chip"
                title="Tokens processed (input+output incl. cache reads) and cost, summed across this session's turns"
              >
                {formatTokens(sessionUsage.tokens)} tok
                {sessionUsage.cost > 0 ? ` · ${formatCost(sessionUsage.cost)}` : ""}
              </span>
            )}
            {contextUsage && typeof contextUsage.percent === "number" && (
              <span
                className="context-chip context-gauge"
                title={`${Math.round(contextUsage.tokens).toLocaleString()} of ${Math.round(contextUsage.contextWindow).toLocaleString()} context tokens`}
              >
                <span className="gauge-bar">
                  <span
                    className="gauge-fill"
                    style={{ width: `${Math.min(100, Math.max(1.5, contextUsage.percent))}%` }}
                  />
                </span>
                {contextUsage.percent >= 10
                  ? `${Math.round(contextUsage.percent)}%`
                  : `${contextUsage.percent.toFixed(1)}%`}
              </span>
            )}
            {running && <span className="context-spinner" aria-label="running" />}
          </div>
        </footer>
          </>
        )}
      </div>
    </div>
  );
}
