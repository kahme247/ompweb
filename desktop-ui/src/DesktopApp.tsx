import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { AppWindow, ArrowLeft, ArrowRight, ArrowUp, Brain, CircleDashed, FolderOpen, GitBranch, Hand, HardDrive, Minus, Minimize2, PanelLeft, Plus, Settings, ShieldCheck, Sparkles, Square, SquarePen, Wrench, X, Zap } from "lucide-react";
import { MessageView } from "@/components/MessageView";
import { ChatMinimap } from "@/components/ChatMinimap";
import { normalizeToolCalls } from "@/lib/normalize";
import { selectableThinkingLevels, thinkingLevelsForMeta } from "@/lib/thinking-levels";
import { formatTokens, formatCost } from "@/lib/subagent-format";
import { useTheme } from "@/hooks/useTheme";
import { Sidebar, projectLabel, type SidebarSession } from "./Sidebar";
import { SettingsView, applyFontSettings, type LoginProvider, type UsageSnapshot } from "./SettingsView";
import { MenuChip, ProjectMenu, BranchMenu, WorktreeMenu } from "./ContextMenus";
import { SubagentDialog } from "./SubagentDialog";
import { ThemedSelect } from "./ThemedSelect";
import { CommandPalette } from "@/components/CommandPalette";
import { TodoList } from "@/components/TodoList";
import { toast, ToastProvider } from "@/components/ui/toast";
import { MAX_TOTAL_ATTACHED_IMAGE_BYTES } from "@/lib/image-attachments";
import {
  compareSubagents,
  mergeSubagentRoster,
  parseSubagentActivityEvent,
  parseSubagentLifecycle,
  parseSubagentProgress,
  parseSubagentSnapshot,
  type SubagentActivityEvent,
  type SubagentInfo,
} from "@/lib/subagent-types";
import type { TodoPhase } from "@/lib/pi-types";
import type { SessionInfo } from "@/lib/types";
import type { AgentMessage, AssistantMessage, ToolResultMessage } from "@/lib/types";

type SessionState = "idle" | "starting" | "ready" | "running" | "exited";

type RpcFrame = {
  type: string;
  id?: string;
  progress?: unknown;
  message?: { role?: string; [key: string]: unknown };
  assistantMessageEvent?: { type?: string; delta?: string };
};

type OmpModelInfo = {
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
  thinking?: { efforts?: string[] };
  input?: string[];
};

type StateResponse = {
  model?: { id?: string; provider?: string };
  thinkingLevel?: string;
  contextUsage?: { tokens: number; contextWindow: number; percent: number };
  queuedMessageCount?: number;
  todoPhases?: TodoPhase[];
  fastModeEnabled?: boolean;
  fastModeActive?: boolean;
};

type ToolPreset = "none" | "default" | "full";

const TOOL_PRESET_LABELS: Record<ToolPreset, string> = {
  none: "No tools",
  default: "Core tools",
  full: "Full tools",
};

type CwdInfo = { project: string; branch: string; diffAdded: number; diffRemoved: number };

type ApprovalMode = "default" | "always-ask" | "write" | "yolo";

const APPROVAL_OPTIONS = [
  { value: "default", label: "Default", description: "Use the omp config default", icon: <CircleDashed size={14} /> },
  { value: "always-ask", label: "Ask before changes", description: "Ask before file changes.", icon: <Hand size={14} /> },
  { value: "write", label: "Edit automatically", description: "Edit files automatically.", icon: <SquarePen size={14} /> },
  { value: "yolo", label: "Full access", description: "Run with fewer confirmations.", icon: <ShieldCheck size={14} /> },
];

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
  const [toolPreset, setToolPreset] = useState<ToolPreset>(() => {
    try {
      const v = localStorage.getItem("omp-desktop-tool-preset");
      return v === "none" || v === "default" ? v : "full";
    } catch {
      return "full";
    }
  });
  const [fastMode, setFastMode] = useState<{ enabled: boolean; active?: boolean }>({ enabled: false });
  const [refreshTick, setRefreshTick] = useState(0);
  const [queuedCount, setQueuedCount] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [attached, setAttached] = useState<{ data: string; mimeType: string; previewUrl: string }[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messageRefs = useRef<(HTMLDivElement | null)[]>([]);
  /** Transcript auto-follows the stream until the user scrolls up. */
  const followRef = useRef(true);
  const [models, setModels] = useState<OmpModelInfo[]>([]);
  const [activeModel, setActiveModel] = useState<{ provider: string; id: string } | null>(null);
  const [thinkingLevel, setThinkingLevel] = useState("");
  const [contextUsage, setContextUsage] = useState<StateResponse["contextUsage"]>(undefined);
  const [todoPhases, setTodoPhases] = useState<TodoPhase[]>([]);
  const [subagents, setSubagents] = useState<SubagentInfo[]>([]);
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | null>(null);
  /** Bounded live-activity buffers, throttled into state (omp-web pattern). */
  const subagentActivityRef = useRef<Map<string, SubagentActivityEvent[]>>(new Map());
  const [subagentActivity, setSubagentActivity] = useState<Map<string, SubagentActivityEvent[]>>(new Map());
  const activityDirtyRef = useRef(false);
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
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "boolean") {
            invoke("omp_shell_set_setting", { key, value }).catch(() => {});
          }
        }
      }
    } catch {
      // malformed storage falls back to Rust defaults
    }
    try {
      const rawFonts = localStorage.getItem("omp-desktop-fonts");
      if (rawFonts) applyFontSettings(JSON.parse(rawFonts));
    } catch {
      // font defaults apply
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
          case "subagent_event": {
            const payload = frame as { id?: unknown; event?: unknown };
            const subId = typeof payload.id === "string" ? payload.id : null;
            const activity = parseSubagentActivityEvent(payload);
            if (subId && activity) {
              const list = subagentActivityRef.current.get(subId) ?? [];
              list.push(activity);
              if (list.length > 40) list.splice(0, list.length - 40);
              subagentActivityRef.current.set(subId, list);
              activityDirtyRef.current = true;
            }
            break;
          }
          case "subagent_lifecycle": {
            const info = parseSubagentLifecycle(frame);
            if (info) setSubagents((prev) => mergeSubagentRoster(prev, [info]));
            break;
          }
          case "subagent_progress": {
            // frame.progress carries the full AgentProgress for a live subagent.
            const id = typeof frame.id === "string" ? frame.id : undefined;
            const progress = parseSubagentProgress(frame.progress);
            if (!id || !progress) break;
            setSubagents((prev) => {
              const existing = prev.find((s) => s.id === id);
              if (!existing) {
                return mergeSubagentRoster(prev, [
                  { id, agent: "subagent", status: "started", index: -1, lastUpdate: Date.now(), source: "live", progress },
                ]);
              }
              return mergeSubagentRoster(prev, [{ ...existing, lastUpdate: Date.now(), progress }]);
            });
            break;
          }
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
  const refreshSubagents = useCallback(async () => {
    try {
      const res = await rpc<{ subagents?: unknown[] }>({ type: "get_subagents" });
      const incoming = Array.isArray(res.subagents)
        ? res.subagents
            .map(parseSubagentSnapshot)
            .filter((s): s is SubagentInfo => s !== undefined)
        : [];
      setSubagents((prev) => mergeSubagentRoster(prev, incoming));
    } catch {
      // no session or no live subagents — keep the current roster
    }
  }, [rpc]);

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
      setQueuedCount(typeof state.queuedMessageCount === "number" ? state.queuedMessageCount : 0);
      setFastMode({ enabled: state.fastModeEnabled === true, active: state.fastModeActive });
      setTodoPhases(Array.isArray(state.todoPhases) ? state.todoPhases : []);
      // Roster rehydration: get_subagents snapshot fills gaps after reconnects
      // and restores terminal chips the frame stream no longer carries.
      void refreshSubagents();
    } catch {
      // session gone mid-refresh; the exit handler owns the UI from here
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc]);

  // Transcript auto-follow: pin to bottom on every message/stream batch until
  // the user scrolls up; scrolling back near the bottom re-engages the follow.
  useEffect(() => {
    if (!followRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [messages, streaming]);

  const onTranscriptScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    followRef.current = distance < 140;
  }, []);

  const autoGrowComposer = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, []);

  /** Shared attach path for paste/drag/picker; enforces the omp-web limits. */
  const attachImageData = useCallback((data: string, mimeType: string): boolean => {
    let ok = false;
    setAttached((prev) => {
      const total = prev.reduce((sum, img) => sum + img.data.length, 0) + data.length;
      if (prev.length >= 10) {
        setError("At most 10 images can be attached.");
        return prev;
      }
      if (total > MAX_TOTAL_ATTACHED_IMAGE_BYTES) {
        setError("Attached images exceed the 5 MB total limit.");
        return prev;
      }
      ok = true;
      return [...prev, { data, mimeType, previewUrl: `data:${mimeType};base64,${data}` }];
    });
    return ok;
  }, []);

  const addImageFiles = useCallback(async (files: File[]) => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      }).catch(() => null);
      if (!dataUrl) continue;
      attachImageData(dataUrl.slice(dataUrl.indexOf(",") + 1), file.type);
    }
  }, [attachImageData]);

  // Focus the composer whenever the session becomes interactive.
  useEffect(() => {
    if (session === "ready" && !settingsOpen) textareaRef.current?.focus();
  }, [session, settingsOpen]);

  // Dropping files onto the window: images attach as prompt images, other
  // files append their real paths (Tauri's drag-drop event is the only way
  // to get real paths in WebView2).
  useEffect(() => {
    const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
    const unlisteners: Promise<UnlistenFn>[] = [
      listen<{ paths: string[] }>("tauri://drag-enter", () => setDragOver(true)),
      listen("tauri://drag-leave", () => setDragOver(false)),
      listen<{ paths: string[] }>("tauri://drag-drop", (event) => {
        setDragOver(false);
        const paths = (event.payload.paths ?? []).filter(Boolean);
        if (paths.length === 0) return;
        const images = paths.filter((p) => IMAGE_EXTS.some((ext) => p.toLowerCase().endsWith(ext)));
        const others = paths.filter((p) => !images.includes(p));
        if (images.length > 0) {
          void (async () => {
            for (const path of images) {
              try {
                const img = await invoke<{ data: string; mimeType: string }>("omp_read_image", { path });
                attachImageData(img.data, img.mimeType);
              } catch (err) {
                toastError(err);
              }
            }
          })();
        }
        if (others.length > 0) {
          setInput((prev) => (prev ? `${prev} ` : "") + others.map((p) => `"${p}"`).join(" "));
        }
      }),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()));
    };
  }, []);

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
    setTodoPhases([]);
    setSubagents([]);
    setSelectedSubagentId(null);
    subagentActivityRef.current = new Map();
    setSubagentActivity(new Map());
    messageRefs.current = [];
  }, []);

  const beginSession = useCallback(async () => {
    setSession("starting");
    setError("");
    resetTranscript();
    setActiveFile(null);
    saveCwd(cwd.trim());
    try {
      await invoke("omp_start", { cwd: cwd.trim(), approvalMode, tools: toolPreset });
      setSession("ready");
      void loadModels();
      void refreshSessionState();
      return true;
    } catch (err) {
      setError(String(err));
      setSession("idle");
      return false;
    }
  }, [cwd, approvalMode, toolPreset, loadModels, refreshSessionState, resetTranscript, saveCwd]);

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
    if ((!message && attached.length === 0) || session === "starting") return;
    setInput("");
    setAttached([]);
    setError("");
    const imagePayload = attached.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType }));
    try {
      if (sessionRef.current === "running") {
        // omp queues prompts that arrive mid-run; show it in the context row.
        await invoke("omp_send", {
          command: { type: "prompt", message, ...(imagePayload.length ? { images: imagePayload } : {}) },
        });
        setTimeout(() => void refreshSessionState(), 600);
        return;
      }
      if (sessionRef.current !== "ready") {
        const ok = await beginSession();
        if (!ok) {
          setAttached(attached);
          return;
        }
      }
      setSession("running");
      await invoke("omp_send", {
        command: { type: "prompt", message, ...(imagePayload.length ? { images: imagePayload } : {}) },
      });
      setSession("ready");
    } catch (err) {
      setError(String(err));
      setAttached((prev) => [...attached, ...prev]);
      setSession(sessionRef.current === "exited" ? "exited" : "ready");
    }
  }, [input, attached, session, beginSession, refreshSessionState]);

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
      await invoke("omp_start", { cwd: dir, resume: info.file, approvalMode, tools: toolPreset });
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
  }, [approvalMode, toolPreset, currentSession, loadModels, refreshSessionState, resetTranscript, saveCwd]);

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

  /** Transient failures go to toasts; session-fatal ones keep the red bar. */
  const toastError = useCallback((err: unknown) => toast.error(typeof err === "string" ? err : String(err)), []);

  const changeToolPreset = useCallback((preset: ToolPreset) => {
    setToolPreset(preset);
    try {
      localStorage.setItem("omp-desktop-tool-preset", preset);
    } catch {
      // persistence is best-effort
    }
  }, []);

  const fastModeSupported =
    activeModel != null && ["anthropic", "openai", "google"].includes(activeModel.provider);

  const attachFromPicker = useCallback(async () => {
    try {
      const path = await invoke<string | null>("omp_pick_image");
      if (!path) return;
      const img = await invoke<{ data: string; mimeType: string }>("omp_read_image", { path });
      attachImageData(img.data, img.mimeType);
    } catch (err) {
      toastError(err);
    }
  }, [attachImageData, toastError]);
  const toggleFastMode = useCallback(async () => {
    try {
      const res = await rpc<{ enabled?: boolean; active?: boolean }>({
        type: "set_fast_mode",
        enabled: !fastMode.enabled,
      });
      setFastMode({ enabled: res.enabled ?? !fastMode.enabled, active: res.active });
    } catch (err) {
      toastError(err);
    }
  }, [fastMode.enabled, rpc, toastError]);

  const [compacting, setCompacting] = useState(false);
  const compact = useCallback(async () => {
    if (sessionRef.current !== "ready" || compacting) return;
    setCompacting(true);
    setError("");
    try {
      await rpc({ type: "compact" });
    } catch (err) {
      toast.error(String(err));
    } finally {
      setCompacting(false);
      void refreshSessionState();
    }
  }, [compacting, rpc, refreshSessionState]);

  // Throttled flush of the live-activity buffers into render state.
  useEffect(() => {
    if (subagents.length === 0) return;
    const id = setInterval(() => {
      if (!activityDirtyRef.current) return;
      activityDirtyRef.current = false;
      setSubagentActivity(new Map(subagentActivityRef.current));
    }, 400);
    return () => clearInterval(id);
  }, [subagents.length]);

  // Global keys: Esc leaves settings; Ctrl+N starts a new task.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && settingsOpen) {
        setSettingsOpen(false);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void beginSession();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen, beginSession]);

  const changeModel = useCallback(
    async (provider: string, modelId: string) => {
      setActiveModel({ provider, id: modelId });
      try {
        await rpc({ type: "set_model", provider, modelId });
      } catch (err) {
        toast.error(String(err));
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
        toast.error(String(err));
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
  const started = session !== "idle" && session !== "exited";
  const dialogInfo = selectedSubagentId ? subagents.find((s) => s.id === selectedSubagentId) : undefined;

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

  const usageSnapshot: UsageSnapshot | null = useMemo(
    () =>
      sessionUsage
        ? {
            tokens: sessionUsage.tokens,
            cost: sessionUsage.cost,
            contextPercent: contextUsage?.percent ?? null,
            model: activeModel ? `${activeModel.provider}/${activeModel.id}` : null,
            thinkingLevel: thinkingLevel || null,
          }
        : null,
    [sessionUsage, contextUsage, activeModel, thinkingLevel],
  );

  return (
    <ToastProvider>
    <div className="desktop-app">
      <aside className={`desktop-sidebar${sidebarOpen ? "" : " collapsed"}`}>
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
            cwd={cwd.trim()}
            usage={usageSnapshot}
            providersLoader={() =>
              rpc<{ providers?: LoginProvider[] }>({ type: "get_login_providers" }).then(
                (res) => (Array.isArray(res.providers) ? res.providers : []),
              )
            }
          />
        ) : (
          <>
            <main className="desktop-transcript" ref={scrollRef} onScroll={onTranscriptScroll}>
              <div className="transcript-inner">
                <div className="transcript-column">
                  {messages.length === 0 && !streaming && (
                    <div className="desktop-empty">
                      <div className="empty-heading">
                        What should we build in{" "}
                        <span className="empty-project">{cwdInfo.project || "this folder"}</span>?
                      </div>
                      {session === "starting" && <div className="empty-sub">Starting omp…</div>}
                      {session === "exited" && <div className="empty-sub">omp exited. Start a new task.</div>}
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
          <div className="composer-panels">
            {todoPhases.length > 0 && <TodoList phases={todoPhases} collapsible />}
            {subagents.length > 0 && (
              <div className="subagent-chips">
                {[...subagents].sort(compareSubagents).map((s) => (
                  <span
                    key={s.id}
                    className={`subagent-chip ${s.status} clickable`}
                    title={s.task ?? s.description ?? s.id}
                    onClick={() => setSelectedSubagentId(s.id)}
                  >
                    <span className="subagent-dot" aria-hidden />
                    <span className="subagent-chip-name">{s.agent}</span>
                    {s.progress?.retryFailure && <span className="subagent-chip-note">⟳ retrying</span>}
                    {s.status === "started" && s.progress?.currentTool && (
                      <span className="subagent-chip-note">{s.progress.currentTool}</span>
                    )}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className={`composer-box${dragOver ? " drag-over" : ""}`}>
            {attached.length > 0 && (
              <div className="composer-attachments">
                {attached.map((img, i) => (
                  <span key={i} className="attachment-thumb">
                    {/* eslint-disable-next-line @next/next/no-img-element -- desktop Vite app, next/image unavailable */}
                    <img src={img.previewUrl} alt="" />
                    <button
                      className="attachment-remove"
                      onClick={() => setAttached((prev) => prev.filter((_, j) => j !== i))}
                      title="Remove attachment"
                    >
                      <X size={10} aria-hidden />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                autoGrowComposer();
              }}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
                if (files.length > 0) {
                  e.preventDefault();
                  void addImageFiles(files);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={
                running
                  ? "Keep typing to queue follow-up changes…"
                  : attached.length > 0
                    ? "Describe the attached image…"
                    : "Do anything…"
              }
              disabled={session === "starting"}
              rows={1}
              spellCheck={false}
            />
            <div className="composer-row">
              <div className="composer-controls">
                <div className="controls-side">
                  <button
                    className="composer-chip"
                    onClick={() => void attachFromPicker()}
                    title="Attach image"
                    aria-label="Attach image"
                  >
                    <Plus size={14} aria-hidden />
                  </button>
                  <label className="composer-chip" title="Tool approval mode — applies when the next session starts">
                    <ThemedSelect
                      value={approvalMode}
                      options={APPROVAL_OPTIONS}
                      onChange={(v) => changeApproval(v as ApprovalMode)}
                      direction="up"
                      ariaLabel="Approval mode"
                      maxWidth={140}
                      hideLabel={running}
                    />
                  </label>
                </div>
                <div className="controls-side">
                  {running && <span className="context-spinner" aria-hidden />}
                  {session !== "exited" && (
                  <>
                    <label className="composer-chip" title="Tool preset — applies to the next session">
                      <Wrench size={12} aria-hidden />
                      <ThemedSelect
                        value={toolPreset}
                        options={(Object.keys(TOOL_PRESET_LABELS) as ToolPreset[]).map((preset) => ({
                          value: preset,
                          label: TOOL_PRESET_LABELS[preset],
                        }))}
                        onChange={(v) => changeToolPreset(v as ToolPreset)}
                        disabled={running}
                        direction="up"
                        ariaLabel="Tool preset"
                        maxWidth={110}
                      />
                    </label>
                    <label
                      className="composer-chip"
                      title={started ? "Model" : "Model — starts loading once a session opens"}
                    >
                      <Sparkles size={12} aria-hidden />
                      <ThemedSelect
                        value={modelValue}
                        options={[
                          ...(activeModel && !activeInCatalog
                            ? [{ value: modelValue, label: activeModel.id, group: "current" }]
                            : []),
                          ...modelGroups.flatMap(([provider, list]) =>
                            list.map((m) => ({
                              value: `${provider}|${m.id}`,
                              label: m.name || m.id,
                              group: provider,
                              badge: m.input?.includes("image") ? "Vision" : undefined,
                            })),
                          ),
                        ]}
                        onChange={(v) => {
                          const [provider, id] = v.split("|");
                          if (provider && id) void changeModel(provider, id);
                        }}
                        disabled={running || models.length === 0}
                        direction="up"
                        placeholder="Model"
                        ariaLabel="Model"
                        maxWidth={180}
                        footer={
                          <button
                            className="tsel-footer"
                            onClick={() => void invoke("omp_manage_models").catch(toastError)}
                          >
                            <Settings size={13} aria-hidden /> Manage models
                          </button>
                        }
                      />
                    </label>
                    <label
                      className="composer-chip"
                      title={started ? "Thinking level" : "Thinking level — applies once a session opens"}
                    >
                      <Brain size={12} aria-hidden />
                      <ThemedSelect
                        value={thinkingLevel || "auto"}
                        options={thinkingOptions.map((lvl) => ({ value: lvl, label: lvl }))}
                        onChange={(v) => void changeThinking(v)}
                        disabled={running || !started}
                        direction="up"
                        ariaLabel="Thinking level"
                        maxWidth={110}
                      />
                    </label>
                    {(fastMode.enabled || (fastModeSupported && started)) && (
                      <button
                        className={`composer-chip${fastMode.active ? " fast-active" : ""}`}
                        onClick={() => void toggleFastMode()}
                        disabled={running}
                        title="Fast mode — priority service tier"
                        aria-label="Toggle fast mode"
                      >
                        <Zap size={12} aria-hidden />
                        {fastMode.active ? "Fast" : "Fast mode"}
                      </button>
                    )}
                    <button
                      className="composer-chip"
                      onClick={() => void compact()}
                      disabled={running || compacting || session !== "ready"}
                      title="Compact context — summarize the transcript to free window space"
                      aria-label="Compact context"
                    >
                      <Minimize2 size={12} aria-hidden />
                      {compacting ? "Compacting…" : "Compact"}
                    </button>
                  </>
                  )}
                </div>
              </div>
              {running ? (
                <button className="composer-send stop" onClick={() => void stop()} title="Stop">
                  <Square size={12} aria-hidden />
                </button>
              ) : (
                <button
                  className="composer-send"
                  onClick={() => void send()}
                  disabled={(!input.trim() && attached.length === 0) || session === "starting" || compacting || !cwd.trim()}
                  title="Send"
                >
                  <ArrowUp size={15} aria-hidden />
                </button>
              )}
            </div>
          </div>
          <div className="composer-context">
            <MenuChip
              width={300}
              chip={
                <>
                  <FolderOpen size={12} aria-hidden />
                  {cwdInfo.project || projectLabel(cwd) || "Set directory"}
                </>
              }
            >
              {(close) => (
                <ProjectMenu
                  cwd={cwd}
                  home={home}
                  close={close}
                  onPick={(p) => {
                    setCwd(p);
                    saveCwd(p);
                  }}
                  onError={toastError}
                />
              )}
            </MenuChip>
            {cwdInfo.branch && (
              <MenuChip
                width={340}
                chip={
                  <>
                    <GitBranch size={12} aria-hidden />
                    {cwdInfo.branch}
                  </>
                }
              >
                {(close) => (
                  <BranchMenu
                    cwd={cwd.trim()}
                    project={cwdInfo.project}
                    close={close}
                    onDone={() => setRefreshTick((t) => t + 1)}
                    onError={toastError}
                  />
                )}
              </MenuChip>
            )}
            <MenuChip
              width={300}
              chip={
                <>
                  <HardDrive size={12} aria-hidden />
                  Local
                </>
              }
            >
              {(close) => (
                <WorktreeMenu
                  cwd={cwd.trim()}
                  close={close}
                  onPick={(p) => {
                    setCwd(p);
                    saveCwd(p);
                  }}
                  onError={toastError}
                />
              )}
            </MenuChip>
            <span className="context-spacer" />
            {queuedCount > 0 && (
              <span className="context-chip" title={`${queuedCount} message(s) queued while the agent runs`}>
                +{queuedCount} queued
              </span>
            )}
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
              <MenuChip
                width={300}
                chip={
                  <span className="context-gauge" title="Context window usage">
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
                }
              >
                {() => (
                  <div className="gauge-pop">
                    <div className="gauge-pop-head">
                      <span>Context window</span>
                      <span className="gauge-pop-nums">
                        {formatTokens(contextUsage.tokens)} / {formatTokens(contextUsage.contextWindow)} (
                        {contextUsage.percent >= 10
                          ? `${Math.round(contextUsage.percent)}`
                          : contextUsage.percent.toFixed(1)}
                        %)
                      </span>
                    </div>
                    <div className="gauge-bar big">
                      <span
                        className="gauge-fill"
                        style={{ width: `${Math.min(100, Math.max(1.5, contextUsage.percent))}%` }}
                      />
                    </div>
                  </div>
                )}
              </MenuChip>
            )}
            {running && <span className="context-spinner" aria-label="running" />}
          </div>
        </footer>
          </>
        )}
      </div>
      <CommandPalette
        onSelectSession={(session: SessionInfo) => {
          void resume({
            file: session.path,
            title: session.name ?? "",
            cwd: session.cwd,
            mtimeMs: Date.parse(session.modified) || 0,
          });
        }}
        onNewSession={() => void beginSession()}
        loadSessions={() =>
          invoke<SidebarSession[]>("omp_list_sessions").then((list) =>
            list.map<SessionInfo>((s) => ({
              path: s.file,
              id: s.file,
              cwd: s.cwd ?? "",
              name: s.title,
              created: new Date(s.mtimeMs).toISOString(),
              modified: new Date(s.mtimeMs).toISOString(),
              messageCount: 0,
              firstMessage: s.title,
            })),
          )
        }
      />
      {dialogInfo && (
        <SubagentDialog
          info={dialogInfo}
          activity={subagentActivity.get(dialogInfo.id) ?? []}
          onClose={() => setSelectedSubagentId(null)}
        />
      )}
    </div>
    </ToastProvider>
  );
}
