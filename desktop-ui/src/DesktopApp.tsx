import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { MessageView } from "@/components/MessageView";
import { normalizeToolCalls } from "@/lib/normalize";
import { selectableThinkingLevels, thinkingLevelsForMeta } from "@/lib/thinking-levels";
import type { AgentMessage, AssistantMessage, ToolResultMessage } from "@/lib/types";

type SessionState = "idle" | "starting" | "ready" | "running" | "exited";

type SessionInfo = {
  file: string;
  title: string;
  cwd?: string;
  mtimeMs: number;
};

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
};

export function DesktopApp() {
  const [home, setHome] = useState("");
  const [cwd, setCwd] = useState("");
  const [session, setSession] = useState<SessionState>("idle");
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [toolResults, setToolResults] = useState<Map<string, ToolResultMessage>>(new Map());
  const [streaming, setStreaming] = useState<AssistantMessage | null>(null);
  const [error, setError] = useState("");
  const [input, setInput] = useState("");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [models, setModels] = useState<OmpModelInfo[]>([]);
  const [activeModel, setActiveModel] = useState<{ provider: string; id: string } | null>(null);
  const [thinkingLevel, setThinkingLevel] = useState("");
  const sessionRef = useRef<SessionState>("idle");
  sessionRef.current = session;

  const rpc = useCallback(
    <T,>(command: Record<string, unknown>) => invoke<T>("omp_send", { command }),
    [],
  );

  // get_state is authoritative: omp may fall back to a default model that
  // differs from what we set, so the pickers re-sync from it after changes.
  const refreshSessionState = useCallback(async () => {
    try {
      const state = await rpc<StateResponse>({ type: "get_state" });
      const model = state.model;
      if (model?.provider && model.id) setActiveModel({ provider: model.provider, id: model.id });
      if (typeof state.thinkingLevel === "string") setThinkingLevel(state.thinkingLevel);
    } catch {
      // session gone mid-refresh; the exit handler owns the UI from here
    }
  }, [rpc]);

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

  useEffect(() => {
    invoke<string>("omp_home")
      .then((h) => {
        setHome(h);
        setCwd((c) => c || h);
      })
      .catch(() => {});
    invoke<SessionInfo[]>("omp_list_sessions")
      .then(setSessions)
      .catch(() => {});
  }, []);

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

  const start = useCallback(async () => {
    setSession("starting");
    setError("");
    setMessages([]);
    setToolResults(new Map());
    setStreaming(null);
    try {
      await invoke("omp_start", { cwd });
      setSession("ready");
      void loadModels();
      void refreshSessionState();
    } catch (err) {
      setError(String(err));
      setSession("idle");
    }
  }, [cwd, loadModels, refreshSessionState]);

  const stop = useCallback(async () => {
    await invoke("omp_stop").catch(() => {});
    setSession("idle");
  }, []);

  const send = useCallback(async () => {
    const message = input.trim();
    if (!message || session !== "ready") return;
    setInput("");
    setSession("running");
    try {
      await invoke("omp_send", { command: { type: "prompt", message } });
      setSession("ready");
    } catch (err) {
      setError(String(err));
      setSession("ready");
    }
  }, [input, session]);

  // Resume a stored session: spawn omp with --resume, then load its transcript
  // from disk (frames from omp continue the same message list).
  const resume = useCallback(async (info: SessionInfo) => {
    const dir = info.cwd?.trim();
    if (!dir) {
      setError("Session has no cwd recorded.");
      return;
    }
    setSession("starting");
    setError("");
    setMessages([]);
    setToolResults(new Map());
    setStreaming(null);
    setCwd(dir);
    try {
      await invoke("omp_start", { cwd: dir, resume: info.file });
      const msgs = await invoke<AgentMessage[]>("omp_read_session", { file: info.file });
      setMessages(msgs.map((m) => normalizeToolCalls(m)));
      setSession("ready");
      void loadModels();
      void refreshSessionState();
    } catch (err) {
      setError(String(err));
      setSession("idle");
    }
  }, [loadModels, refreshSessionState]);

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

  const busy = session === "starting" || session === "running";
  const started = session !== "idle" && session !== "exited";
  const emptyHint: Record<SessionState, string> = {
    idle: "Open a session to start chatting with omp.",
    starting: "Starting omp…",
    ready: "Session ready — type a prompt below.",
    running: "Working…",
    exited: "omp exited. Open a new session.",
  };

  return (
    <div className="desktop-app">
      <header className="desktop-toolbar">
        <input
          className="desktop-cwd"
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder={home || "working directory"}
          disabled={started}
          spellCheck={false}
        />
        <button
          className={started ? "desktop-btn" : "desktop-btn desktop-btn-primary"}
          onClick={started ? stop : start}
          disabled={started ? false : !cwd.trim() || busy}
        >
          {started ? "Stop" : busy ? "Starting…" : "Open session"}
        </button>
        {started && (
          <select
            className="desktop-select"
            value={modelValue}
            onChange={(e) => {
              const [provider, id] = e.target.value.split("|");
              if (provider && id) void changeModel(provider, id);
            }}
            disabled={busy}
            aria-label="Model"
            title="Model"
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
        )}
        {started && (
          <select
            className="desktop-select"
            value={thinkingLevel || "auto"}
            onChange={(e) => void changeThinking(e.target.value)}
            disabled={busy}
            aria-label="Thinking level"
            title="Thinking level"
          >
            {thinkingOptions.map((lvl) => (
              <option key={lvl} value={lvl}>
                {lvl}
              </option>
            ))}
          </select>
        )}
        <details className="desktop-sessions" open={!started && messages.length === 0 && sessions.length > 0}>
          <summary className="desktop-btn">Resume…</summary>
          <div className="desktop-sessions-list">
            {sessions.length === 0 && <div className="desktop-sessions-empty">No sessions found.</div>}
            {sessions.slice(0, 12).map((s) => (
              <button
                key={s.file}
                className="desktop-session-item"
                onClick={() => void resume(s)}
                disabled={started || busy}
                title={s.file}
              >
                <span className="desktop-session-title">{s.title || s.file.split(/[\\/]/).pop()}</span>
                <span className="desktop-session-meta">
                  {s.cwd} · {new Date(s.mtimeMs).toLocaleString()}
                </span>
              </button>
            ))}
          </div>
        </details>
      </header>

      {error && <div className="desktop-error">{error}</div>}

      <main className="desktop-transcript">
        {messages.length === 0 && !streaming && (
          <div className="desktop-empty">{emptyHint[session]}</div>
        )}
        {messages.map((m, i) => (
          <MessageView key={i} message={m} toolResults={toolResults} cwd={cwd} />
        ))}
        {streaming && (
          <MessageView message={streaming} isStreaming toolResults={toolResults} cwd={cwd} />
        )}
        {session === "running" && !streaming && <div className="desktop-cursor" aria-hidden />}
      </main>

      <footer className="desktop-composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={started ? "Type a prompt… (Enter to send)" : "Open a session first"}
          disabled={!started || busy}
          rows={2}
        />
        <button
          className="desktop-btn desktop-btn-primary"
          onClick={() => void send()}
          disabled={!started || busy || !input.trim()}
        >
          Send
        </button>
      </footer>
    </div>
  );
}
