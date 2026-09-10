"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useGlobalKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { SessionSidebar } from "./SessionSidebar";
import { ToastProvider } from "./ui/toast";
import { toast } from "./ui/toast";
import { ChatWindow } from "./ChatWindow";
import { type Tab } from "./TabBar";
import { type FileExplorerHandle } from "./FileExplorer";
import type { RightPanelView } from "./RightPanel";
import { BranchNavigator } from "./BranchNavigator";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { Check, Folder, History, Menu, PanelLeft, Terminal, Wand2, Zap } from "lucide-react";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { translate, useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { useIsMobile } from "@/hooks/useIsMobile";
import { copyText } from "@/lib/clipboard";
import { encodeFilePathForApi, getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { buildAtMentionText, buildFileAtMentionsText, buildFileLineMentionText } from "@/lib/file-fuzzy";
import { getInitialNavigation } from "@/lib/initial-navigation";
import { comparableProjectPath } from "@/lib/comparable-path";
import { showCompletionNotification } from "@/lib/browser-notifications";
import {
  APP_UPDATE_COMPLETED_RELOAD_MS,
  APP_UPDATE_POLL_MS,
  APP_UPDATE_PREPARING_MIN_MS,
  APP_UPDATE_STOPPING_POLL_MS,
  APP_UPDATE_TIMEOUT_MS,
  APP_UPDATE_VISIBLE_STAGE_MIN_MS,
  AppUpdateTransportError,
  COMPLETED_APP_UPDATE_KEY,
  DISMISSED_APP_UPDATE_KEY,
  DISMISSED_OMP_UPDATE_KEY,
  fetchAppUpdateJson,
  isExactLegacyTargetCompletion,
  readDismissedVersion,
  rememberDismissedVersion,
  sanitizeAppUpdateError,
  waitForAppUpdateDwell,
} from "./AppShell-app-update";
import {
  PanelLoadingFallback,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_WIDTH_STORAGE_KEY,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
  clampRightPanelWidth,
  clampSidebarWidth,
  loadRightPanelWidth,
  loadSidebarWidth,
  projectLabel,
} from "./AppShell-layout";
import type { SessionInfo, SessionTreeNode } from "@/lib/types";
import type { ChatInputHandle } from "./ChatInput";
import type { SessionStatsInfo, GenerationSpeedInfo } from "@/lib/pi-types";
import type { SettingsTab } from "./SettingsTabs";
import { SettingsConfig } from "./SettingsConfig";
import {
  AppUpdateDialog,
  getAppUpdateStageIndex,
  getNextAppUpdateStage,
  getMonotonicAppUpdateStage,
  type AppUpdateInfo,
  type AppUpdatePhase,
  type AppUpdateStage,
} from "./AppUpdateDialog";
import { ArchiveBrowser } from "./ArchiveBrowser";
import { publishSessionsChanged } from "@/lib/session-change-bus";
// The settings shell is part of the app bundle so opening it does not fetch or compile a modal chunk. The right panel (viewer included) remains on demand.
const RightPanel = dynamic(() => import("./RightPanel").then((m) => m.RightPanel), {
  ssr: false,
  loading: () => <PanelLoadingFallback />,
});

const TOOL_CALLS_COLLAPSED_STORAGE_KEY = "omp-web:tool-calls-collapsed";
const PROVIDER_USAGE_VISIBLE_STORAGE_KEY = "omp-web:provider-usage-visible";

const CommandPalette = dynamic(() => import("./CommandPalette").then((m) => m.CommandPalette), {
  ssr: false,
});

type AutoNameStatus =
  | { kind: "idle" }
  | { kind: "naming" }
  | { kind: "success" }
  | { kind: "error"; message: string };
type TimerHandle = NodeJS.Timeout;

export function AppShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [initialNavigation] = useState(() => getInitialNavigation(searchParams));
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  // When user clicks +, we only store the cwd — no fake session id
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const [initialCwdStatus, setInitialCwdStatus] = useState<"idle" | "validating" | "ready" | "error">(
    () => initialNavigation.requestedCwd ? "validating" : "idle",
  );
  const [initialCwdError, setInitialCwdError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [explorerRefreshing, setExplorerRefreshing] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [archiveBrowserOpen, setArchiveBrowserOpen] = useState(false);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState<number>(SIDEBAR_DEFAULT_WIDTH);
  const [toolCallsDefaultCollapsed, setToolCallsDefaultCollapsed] = useState(true);
  const [providerUsageVisible, setProviderUsageVisible] = useState(true);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  // Active drag handlers so an unmount mid-drag can detach them.
  const sidebarResizeHandlersRef = useRef<{ onMove: (ev: MouseEvent) => void; onUp: () => void } | null>(null);
  // DOM element + live width during a drag (see handleSidebarResizeStart).
  const sidebarContainerRef = useRef<HTMLDivElement>(null);
  const pendingSidebarWidthRef = useRef<number>(SIDEBAR_DEFAULT_WIDTH);
  useEffect(() => {
    setSidebarWidth(loadSidebarWidth());
    try {
      setToolCallsDefaultCollapsed(window.localStorage.getItem(TOOL_CALLS_COLLAPSED_STORAGE_KEY) !== "false");
      setProviderUsageVisible(window.localStorage.getItem(PROVIDER_USAGE_VISIBLE_STORAGE_KEY) !== "false");
    } catch {
      // Keep the compact default when storage is unavailable.
    }
  }, []);
  const handleToolCallsDefaultCollapsedChange = useCallback((collapsed: boolean) => {
    setToolCallsDefaultCollapsed(collapsed);
    try {
      window.localStorage.setItem(TOOL_CALLS_COLLAPSED_STORAGE_KEY, String(collapsed));
    } catch {
      // The preference still applies for this page load.
    }
  }, []);
  const handleProviderUsageVisibleChange = useCallback((visible: boolean) => {
    setProviderUsageVisible(visible);
    try {
      window.localStorage.setItem(PROVIDER_USAGE_VISIBLE_STORAGE_KEY, String(visible));
    } catch {
      // The preference still applies for this page load.
    }
  }, []);
  // Persist the committed width (after each change; skipped mid-drag, then
  // written once the drag ends). The first run is skipped so the mount-time
  // default cannot overwrite the stored width before it is loaded.
  const sidebarWidthMountedRef = useRef(false);
  useEffect(() => {
    if (!sidebarWidthMountedRef.current) {
      sidebarWidthMountedRef.current = true;
      return;
    }
    if (sidebarResizing) return;
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
    } catch {
      // ignore storage quota / privacy-mode errors
    }
  }, [sidebarWidth, sidebarResizing]);
  const [appUpdate, setAppUpdate] = useState<AppUpdateInfo | null>(null);
  const [appUpdateDialogOpen, setAppUpdateDialogOpen] = useState(false);
  const [appUpdatePhase, setAppUpdatePhase] = useState<AppUpdatePhase>("idle");
  const [appUpdateError, setAppUpdateError] = useState<string | null>(null);
  const appUpdateAttemptRef = useRef<string | null>(null);
  const appUpdateStartInFlightRef = useRef(false);
  const appUpdateCompletingRef = useRef(false);
  const [appUpdateVisibleStage, setAppUpdateVisibleStage] = useState<AppUpdateStage | undefined>();
  const appUpdateVisibleStageRef = useRef<AppUpdateStage | undefined>(undefined);
  const appUpdateVisibleStageStartedAtRef = useRef<number | null>(null);
  const appUpdateCommittedAttemptRef = useRef<string | null>(null);
  const appUpdateRecoveryCommitAttemptRef = useRef<string | null>(null);
  const appUpdateStageFlowRef = useRef(0);
  const appUpdateAcknowledgementsRef = useRef<Map<string, Promise<boolean>>>(new Map());
  const advanceAppUpdateVisibleStage = useCallback((next: AppUpdateStage) => {
    const visible = getMonotonicAppUpdateStage(appUpdateVisibleStageRef.current, next);
    if (visible === appUpdateVisibleStageRef.current) return;
    appUpdateVisibleStageRef.current = visible;
    appUpdateVisibleStageStartedAtRef.current = Date.now();
    setAppUpdateVisibleStage(visible);
  }, []);
  const resetAppUpdateVisibleStage = useCallback(() => {
    appUpdateVisibleStageRef.current = undefined;
    appUpdateStageFlowRef.current += 1;
    appUpdateVisibleStageStartedAtRef.current = null;
    appUpdateCommittedAttemptRef.current = null;
    appUpdateRecoveryCommitAttemptRef.current = null;
    setAppUpdateVisibleStage(undefined);
    setAppUpdate((current) => current?.appUpdateDrain
      ? { ...current, appUpdateDrain: undefined }
      : current);
  }, []);
  const showAppUpdateStagesThrough = useCallback(async (target: AppUpdateStage) => {
    const stageFlow = appUpdateStageFlowRef.current;
    const targetIndex = getAppUpdateStageIndex(target);
    if (appUpdateVisibleStageRef.current === undefined) {
      advanceAppUpdateVisibleStage(target);
      return;
    }
    while (true) {
      const current = appUpdateVisibleStageRef.current;
      if (current === undefined || getAppUpdateStageIndex(current) >= targetIndex) return;
      await waitForAppUpdateDwell(
        appUpdateVisibleStageStartedAtRef.current,
        current === "preparing" ? APP_UPDATE_PREPARING_MIN_MS : APP_UPDATE_VISIBLE_STAGE_MIN_MS,
      );
      if (appUpdateStageFlowRef.current !== stageFlow) return;
      const latest = appUpdateVisibleStageRef.current;
      if (latest === undefined || getAppUpdateStageIndex(latest) >= targetIndex) return;
      const next = getNextAppUpdateStage(latest);
      if (next === undefined) return;
      advanceAppUpdateVisibleStage(next);
    }
  }, [advanceAppUpdateVisibleStage]);
  const [ompUpdateAvailable, setOmpUpdateAvailable] = useState(false);
  // Bumped on visibilitychange so the mount-time update checks re-run.
  const [updateCheckKey, setUpdateCheckKey] = useState(0);
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);
  useEffect(() => {
    setMobileSidebarReady(true);
  }, []);
  // Chrome does not blur a focused descendant when a subtree becomes
  // aria-hidden + inert (e.g. tapping a session button closes the mobile
  // drawer), which leaves focus trapped where assistive tech cannot see it.
  // Blur synchronously in the same commit so the AX tree never observes a
  // focused element inside the hidden sidebar.
  useLayoutEffect(() => {
    if (sidebarOpen || !mobileSidebarReady) return;
    const container = sidebarContainerRef.current;
    const active = document.activeElement;
    if (container && active instanceof HTMLElement && container.contains(active)) {
      active.blur();
    }
  }, [sidebarOpen, mobileSidebarReady]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/omp-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "check" }),
      signal: controller.signal,
    })
      .then((response) => response.ok ? response.json() : null)
      .then((data: { currentVersion?: string | null; availableVersion?: string | null; updateAvailable?: boolean; updateCommand?: string } | null) => {
        setOmpUpdateAvailable(Boolean(data?.updateAvailable));
        if (!data?.updateAvailable || !data.availableVersion) return;
        // This check re-runs on every visibilitychange back to the tab, so a
        // version the user already dismissed must not be re-announced.
        if (readDismissedVersion(DISMISSED_OMP_UPDATE_KEY) === data.availableVersion) return;
        const version = data.availableVersion;
        const cmd = data.updateCommand || "omp update";
        toast.info(
          translate("appShell.ompUpdateAvailable"),
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
            <div>{translate("appShell.updateVersion", { current: data.currentVersion ?? "?", available: data.availableVersion })}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <code style={{ background: "var(--bg-panel)", padding: "3px 7px", borderRadius: "var(--radius-control)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
                {cmd}
              </code>
              <button
                type="button"
                onClick={() => {
                  void copyText(cmd)
                    .then(() => toast.success(translate("appShell.commandCopied")))
                    .catch(() => toast.error(translate("appShell.commandCopyFailed")));
                }}
                style={{ padding: "3px 7px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 11 }}
              >
                {translate("appShell.copyCommand")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setSettingsTab("system");
                  toast.close("omp-update-available");
                }}
                style={{ padding: "3px 7px", border: "1px solid var(--accent-strong)", borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "var(--on-accent)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}
              >
                {translate("settingsConfig.ompUpdateAction")}
              </button>
            </div>
          </div>,
          { id: "omp-update-available", timeout: 0, onClose: () => rememberDismissedVersion(DISMISSED_OMP_UPDATE_KEY, version) }
        );
      })
      .catch(() => {});
    return () => controller.abort();
  }, [updateCheckKey]);
  useEffect(() => {
    const recheck = () => {
      if (document.visibilityState !== "visible") return;
      // A transient failure on mount reads as "no update" forever otherwise;
      // re-running the checks below on re-focus gives them another chance.
      setUpdateCheckKey((key) => key + 1);
    };
    document.addEventListener("visibilitychange", recheck);
    return () => document.removeEventListener("visibilitychange", recheck);
  }, []);
  const refreshAppUpdate = useCallback(async (force = false, autoOpen = false): Promise<AppUpdateInfo | null> => {
    const data = await fetchAppUpdateJson<AppUpdateInfo>(
      force ? "/api/app-update?force=1" : "/api/app-update",
      { cache: "no-store" },
    );
    if (
      autoOpen
      && (appUpdateStartInFlightRef.current || appUpdateAttemptRef.current !== null || appUpdateCompletingRef.current)
    ) return null;

    setAppUpdate(data);

    if (autoOpen && !data.selfUpdateStatus && data.updateAvailable && data.availableVersion) {
      if (data.selfUpdateSupported === true) {
        if (readDismissedVersion(DISMISSED_APP_UPDATE_KEY) !== data.availableVersion) {
          setAppUpdatePhase("idle");
          setAppUpdateError(null);
          setAppUpdateDialogOpen(true);
        }
      } else {
        const cmd = data.updateCommand || "npm install -g @kahme247/ompweb";
        const version = data.availableVersion;
        if (readDismissedVersion(DISMISSED_APP_UPDATE_KEY) === version) return data;
        toast.info(
          translate("appShell.appUpdateAvailable"),
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
            <div>{translate("appShell.updateVersion", { current: data.currentVersion ?? "?", available: data.availableVersion })}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <code style={{ background: "var(--bg-panel)", padding: "3px 7px", borderRadius: "var(--radius-control)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
                {cmd}
              </code>
              <button
                type="button"
                onClick={() => {
                  void copyText(cmd)
                    .then(() => toast.success(translate("appShell.commandCopied")))
                    .catch(() => toast.error(translate("appShell.commandCopyFailed")));
                }}
                style={{ padding: "3px 7px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 11 }}
              >
                {translate("appShell.copyCommand")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setSettingsTab("system");
                  toast.close("app-update-available");
                }}
                style={{ padding: "3px 7px", border: "1px solid var(--accent-strong)", borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "var(--on-accent)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}
              >
                {translate("settingsConfig.appUpdateAction")}
              </button>
            </div>
          </div>,
          { id: "app-update-available", timeout: 0, onClose: () => rememberDismissedVersion(DISMISSED_APP_UPDATE_KEY, version) }
        );
      }
    }
    return data;
  }, []);

  const acknowledgeAppUpdate = useCallback((attemptId: string): Promise<boolean> => {
    const existing = appUpdateAcknowledgementsRef.current.get(attemptId);
    if (existing) return existing;
    const request = (async () => {
      try {
        const response = await fetch("/api/app-update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "acknowledge", attemptId }),
        });
        return response.ok;
      } catch {
        return false;
      }
    })();
    appUpdateAcknowledgementsRef.current.set(attemptId, request);
    void request.then((acknowledged) => {
      if (!acknowledged && appUpdateAcknowledgementsRef.current.get(attemptId) === request) {
        appUpdateAcknowledgementsRef.current.delete(attemptId);
      }
    });
    return request;
  }, []);

  const showAppUpdateFailure = useCallback((error: unknown) => {
    appUpdateAttemptRef.current = null;
    appUpdateStartInFlightRef.current = false;
    appUpdateCommittedAttemptRef.current = null;
    setAppUpdateError(sanitizeAppUpdateError(error) || null);
    setAppUpdatePhase("failed");
    appUpdateStageFlowRef.current += 1;
    setAppUpdateDialogOpen(true);
  }, []);

  const submitAppUpdateCommit = useCallback((attemptId: string) => {
    void fetchAppUpdateJson<{ error?: string }>("/api/app-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "commit", attemptId }),
      keepalive: true,
    }, 202).then(() => {
      if (appUpdateAttemptRef.current === attemptId) {
        appUpdateCommittedAttemptRef.current = attemptId;
      }
    }).catch((error) => {
      if (error instanceof AppUpdateTransportError) {
        if (appUpdateRecoveryCommitAttemptRef.current === attemptId) {
          appUpdateRecoveryCommitAttemptRef.current = null;
        }
        return;
      }
      if (appUpdateAttemptRef.current !== attemptId) return;
      showAppUpdateFailure(error);
    });
  }, [showAppUpdateFailure]);

  const recoverPreparedAppUpdate = useCallback((data: AppUpdateInfo, attemptId: string) => {
    const status = data.selfUpdateStatus;
    if (
      status?.attemptId !== attemptId
      || status.state !== "prepared"
      || (status.stage !== "preparing" && status.stage !== "stopping")
    ) return;
    if (appUpdateRecoveryCommitAttemptRef.current === attemptId) return;
    appUpdateRecoveryCommitAttemptRef.current = attemptId;
    submitAppUpdateCommit(attemptId);
  }, [submitAppUpdateCommit]);

  const completeAppUpdate = useCallback(async (targetVersion: string) => {
    if (appUpdateCompletingRef.current) return;
    appUpdateCompletingRef.current = true;
    appUpdateAttemptRef.current = null;
    appUpdateCommittedAttemptRef.current = null;
    appUpdateStartInFlightRef.current = false;
    await showAppUpdateStagesThrough("finalizing");
    await waitForAppUpdateDwell(appUpdateVisibleStageStartedAtRef.current, APP_UPDATE_VISIBLE_STAGE_MIN_MS);
    setAppUpdateError(null);
    setAppUpdatePhase("completed");
    setAppUpdateDialogOpen(true);
    try {
      window.sessionStorage.setItem(COMPLETED_APP_UPDATE_KEY, JSON.stringify({ version: targetVersion }));
    } catch {}
    await new Promise<void>((resolve) => window.setTimeout(resolve, APP_UPDATE_COMPLETED_RELOAD_MS));
    appUpdateRecoveryCommitAttemptRef.current = null;
    window.location.reload();
  }, [showAppUpdateStagesThrough]);

  const handleTerminalAppUpdate = useCallback(async (
    data: AppUpdateInfo,
    attemptId: string,
    targetVersion: string,
  ): Promise<boolean> => {
    const status = data.selfUpdateStatus;
    if (status?.attemptId !== attemptId || status.cleanupReady !== true) return false;
    if (status.state === "failed") {
      if (!await acknowledgeAppUpdate(attemptId)) return false;
      showAppUpdateFailure(status.error);
      return true;
    }
    if (status.state === "succeeded" && data.currentVersion === targetVersion) {
      if (!await acknowledgeAppUpdate(attemptId)) return false;
      await completeAppUpdate(targetVersion);
      return true;
    }
    return false;
  }, [acknowledgeAppUpdate, completeAppUpdate, showAppUpdateFailure]);

  const monitorAppUpdate = useCallback(async (attemptId: string, targetVersion: string) => {
    if (appUpdateAttemptRef.current === attemptId) return;
    appUpdateAttemptRef.current = attemptId;
    const deadline = Date.now() + APP_UPDATE_TIMEOUT_MS;
    while (appUpdateAttemptRef.current === attemptId && Date.now() < deadline) {
      await new Promise<void>((resolve) => window.setTimeout(
        resolve,
        appUpdateVisibleStageRef.current === "stopping" ? APP_UPDATE_STOPPING_POLL_MS : APP_UPDATE_POLL_MS,
      ));
      try {
        const data = await refreshAppUpdate();
        if (!data) continue;
        const status = data.selfUpdateStatus;
        if (status?.attemptId === attemptId && status.stage !== undefined) {
          if (status.stage !== "preparing") appUpdateCommittedAttemptRef.current = attemptId;
          await showAppUpdateStagesThrough(status.stage);
        }
        recoverPreparedAppUpdate(data, attemptId);
        if (await handleTerminalAppUpdate(data, attemptId, targetVersion)) return;
        if (isExactLegacyTargetCompletion(data, targetVersion)) {
          // Legacy targets do not expose the status/acknowledge contract. Exact
          // version equality is the completion proof; updater artifacts expire
          // through the backend's terminal-status TTL instead of UI cleanup.
          await completeAppUpdate(targetVersion);
          return;
        }
      } catch (error) {
        if (error instanceof AppUpdateTransportError) {
          if (appUpdateCommittedAttemptRef.current === attemptId) {
            advanceAppUpdateVisibleStage("installing");
          }
          // Connection failures are expected after commit while the server is offline.
          continue;
        }
        showAppUpdateFailure(error);
        return;
      }
    }
    if (appUpdateAttemptRef.current === attemptId) {
      showAppUpdateFailure(t("appUpdateDialog.timeout"));
    }
  }, [advanceAppUpdateVisibleStage, completeAppUpdate, handleTerminalAppUpdate, recoverPreparedAppUpdate, refreshAppUpdate, showAppUpdateFailure, showAppUpdateStagesThrough, t]);

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(COMPLETED_APP_UPDATE_KEY);
      if (raw) {
        const completed = JSON.parse(raw) as { version?: unknown };
        window.sessionStorage.removeItem(COMPLETED_APP_UPDATE_KEY);
        if (typeof completed.version === "string") {
          toast.success(t("appUpdateDialog.completed", { version: completed.version }));
        }
      }
    } catch {}
    void refreshAppUpdate(false, true)
      .then(async (data) => {
        const status = data?.selfUpdateStatus;
        if (!data || !status) return;
        const recoveredStage = status.stage ?? "stopping";
        const initialStage = recoveredStage === "preparing" ? "preparing" : "stopping";
        if (initialStage === "stopping") appUpdateCommittedAttemptRef.current = status.attemptId;
        advanceAppUpdateVisibleStage(initialStage);
        setAppUpdatePhase(initialStage === "preparing" ? "preparing" : "restarting");
        setAppUpdateDialogOpen(true);
        await showAppUpdateStagesThrough(recoveredStage);
        if (await handleTerminalAppUpdate(data, status.attemptId, status.targetVersion)) return;
        void monitorAppUpdate(status.attemptId, status.targetVersion);
        recoverPreparedAppUpdate(data, status.attemptId);
      })
      .catch(() => {});
  }, [advanceAppUpdateVisibleStage, handleTerminalAppUpdate, monitorAppUpdate, recoverPreparedAppUpdate, refreshAppUpdate, showAppUpdateStagesThrough, t]);

  const proceedWithAppUpdate = useCallback(async () => {
    if (appUpdateStartInFlightRef.current) return;
    appUpdateStartInFlightRef.current = true;
    appUpdateCompletingRef.current = false;
    resetAppUpdateVisibleStage();
    advanceAppUpdateVisibleStage("preparing");
    setAppUpdatePhase("preparing");
    setAppUpdateError(null);
    try {
      const prepared = await fetchAppUpdateJson<{ attemptId?: string; targetVersion?: string }>("/api/app-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "prepare" }),
      });
      if (!prepared.attemptId || !prepared.targetVersion) {
        throw new Error("Invalid update response");
      }
      submitAppUpdateCommit(prepared.attemptId);
      void monitorAppUpdate(prepared.attemptId, prepared.targetVersion);
      await showAppUpdateStagesThrough("stopping");
      if (appUpdateAttemptRef.current !== prepared.attemptId) return;
      setAppUpdatePhase("restarting");
    } catch (error) {
      showAppUpdateFailure(error);
    }
  }, [advanceAppUpdateVisibleStage, monitorAppUpdate, resetAppUpdateVisibleStage, showAppUpdateFailure, showAppUpdateStagesThrough, submitAppUpdateCommit]);

  const dismissAppUpdate = useCallback(() => {
    if (appUpdatePhase === "idle" && appUpdate?.availableVersion) {
      rememberDismissedVersion(DISMISSED_APP_UPDATE_KEY, appUpdate.availableVersion);
      toast.info(t("appUpdateDialog.settingsLater"));
    }
    setAppUpdateDialogOpen(false);
    setAppUpdatePhase("idle");
    setAppUpdateError(null);
    appUpdateAttemptRef.current = null;
    resetAppUpdateVisibleStage();
  }, [appUpdate?.availableVersion, appUpdatePhase, resetAppUpdateVisibleStage, t]);

  const requestAppUpdateFromSettings = useCallback(() => {
    setSettingsTab(null);
    resetAppUpdateVisibleStage();
    setAppUpdateError(null);
    setAppUpdatePhase("idle");
    window.requestAnimationFrame(() => setAppUpdateDialogOpen(true));
  }, [resetAppUpdateVisibleStage]);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);

  // Branch navigator state — populated by ChatWindow via onBranchDataChange
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const branchLeafChangeFnRef = useRef<((leafId: string | null) => void) | null>(null);

  const handleBranchDataChange = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
    setBranchTree(tree);
    setBranchActiveLeafId(activeLeafId);
    branchLeafChangeFnRef.current = onLeafChange;
  }, []);

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    branchLeafChangeFnRef.current?.(leafId);
  }, []);

  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [systemPromptLoading, setSystemPromptLoading] = useState(false);
  const systemPromptLoaderRef = useRef<(() => Promise<void>) | null>(null);
  const systemPromptLoadIdRef = useRef(0);
  const systemBtnRef = useRef<HTMLButtonElement>(null);
  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
    setSystemPromptLoading(false);
  }, []);

  const handleSystemPromptLoaderChange = useCallback((loader: (() => Promise<void>) | null) => {
    systemPromptLoadIdRef.current += 1;
    systemPromptLoaderRef.current = loader;
    setSystemPromptLoading(false);
  }, []);

  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(null);
  const [autoNameStatus, setAutoNameStatus] = useState<AutoNameStatus>({ kind: "idle" });
  const autoNameTimerRef = useRef<TimerHandle | undefined>(undefined);
  const activeSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);
  const archiveRetryTimerRef = useRef<TimerHandle | undefined>(undefined);
  useEffect(() => () => clearTimeout(archiveRetryTimerRef.current), []);
  useLayoutEffect(() => {
    activeSessionIdRef.current = selectedSession?.id ?? null;
  }, [selectedSession?.id]);
  const handleSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    setSessionStats(stats);
  }, []);

  useEffect(() => {
    return () => {
      clearTimeout(autoNameTimerRef.current);
    };
  }, []);

  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<"branches" | "system" | null>(null);
  const toggleTopPanel = useCallback((panel: "branches" | "system") => {
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel((cur) => cur === panel ? null : panel);
  }, [isMobile]);

  // Generation speed — current live t/s and the session average.
  const [generationSpeed, setGenerationSpeed] = useState<GenerationSpeedInfo | null>(null);
  const handleGenerationSpeedChange = useCallback((speed: GenerationSpeedInfo | null) => {
    setGenerationSpeed(speed);
  }, []);
  const handleSystemPromptToggle = useCallback(() => {
    const opening = activeTopPanel !== "system";
    toggleTopPanel("system");
    if (!opening || systemPromptLoading || systemPrompt !== null) return;

    const load = systemPromptLoaderRef.current;
    if (!load) return;
    const loadId = ++systemPromptLoadIdRef.current;
    setSystemPromptLoading(true);
    void load().catch((error) => {
      console.error("Failed to load system prompt:", error);
    }).finally(() => {
      if (systemPromptLoadIdRef.current === loadId) setSystemPromptLoading(false);
    });
  }, [activeTopPanel, systemPrompt, systemPromptLoading, toggleTopPanel]);

  // The topbar session panel is gone (its content lives in the composer ring
  // popover), so /session opens that instead.
  const openSessionStatsPanel = useCallback(() => {
    chatInputRef.current?.openContextPanel();
  }, []);

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) setActiveTopPanel(null);
    setSidebarOpen((open) => !open);
  }, [isMobile]);

  const resetSidebarWidth = useCallback(() => {
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
  }, []);

  const changeSidebarWidth = useCallback((delta: number) => {
    setSidebarWidth((prev) => clampSidebarWidth(prev + delta));
  }, []);

  const handleSidebarResizeKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      changeSidebarWidth(-10);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      changeSidebarWidth(10);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      resetSidebarWidth();
    }
  }, [changeSidebarWidth, resetSidebarWidth]);

  const handleSidebarResizeStart = useCallback((e: React.MouseEvent) => {
    if (isMobile) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    // Interface Scale (html[data-ui-scale] zoom) leaves clientX in viewport
    // pixels while the sidebar width is zoomed layout pixels: scale the drag
    // delta so the edge tracks the pointer at any zoom (same --ui-scale
    // ground truth as the zoom-aware menus in SessionSidebar-chrome).
    let uiScale = 1;
    try {
      const raw = getComputedStyle(document.documentElement).getPropertyValue("--ui-scale");
      const value = parseFloat(raw);
      if (Number.isFinite(value) && value > 0) uiScale = value;
    } catch {
      // SSR/unavailable: fall back to unscaled math.
    }
    setSidebarResizing(true);
    const onMove = (ev: MouseEvent) => {
      const next = clampSidebarWidth(startWidth + (ev.clientX - startX) / uiScale);
      // Write the CSS variable straight to the DOM: the flex row follows the
      // pointer without re-rendering the whole AppShell on every mousemove.
      sidebarContainerRef.current?.style.setProperty("--sidebar-width", `${next}px`);
      pendingSidebarWidthRef.current = next;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      sidebarResizeHandlersRef.current = null;
      setSidebarResizing(false);
      // Commit the final width so state and the persisted value agree with
      // what the user actually dragged to.
      setSidebarWidth(pendingSidebarWidthRef.current);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    pendingSidebarWidthRef.current = startWidth;
    sidebarResizeHandlersRef.current = { onMove, onUp };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [isMobile, sidebarWidth]);

  // If the app unmounts mid-drag, remove the window listeners and restore the
  // body cursor; otherwise the handlers leak and body stays cursor:col-resize.
  useEffect(() => () => {
    const handlers = sidebarResizeHandlersRef.current;
    if (!handlers) return;
    window.removeEventListener("mousemove", handlers.onMove);
    window.removeEventListener("mouseup", handlers.onUp);
    sidebarResizeHandlersRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  const resetRightPanelWidth = useCallback(() => {
    rightPanelRef.current?.style.removeProperty("--right-panel-width");
    setRightPanelWidth(null);
  }, []);

  const changeRightPanelWidth = useCallback((delta: number) => {
    setRightPanelWidth((prev) => {
      // Keyboard steps from the fluid default start at the panel's live
      // width so the first press doesn't jump to the clamp minimum.
      const base = prev ?? rightPanelRef.current?.getBoundingClientRect().width ?? RIGHT_PANEL_MIN_WIDTH;
      const next = clampRightPanelWidth(base + delta);
      rightPanelRef.current?.style.setProperty("--right-panel-width", `${next}px`);
      return next;
    });
  }, []);

  const handleRightPanelResizeKey = useCallback((e: React.KeyboardEvent) => {
    // The handle sits on the panel's left edge: left widens, right narrows.
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      changeRightPanelWidth(10);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      changeRightPanelWidth(-10);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      resetRightPanelWidth();
    }
  }, [changeRightPanelWidth, resetRightPanelWidth]);

  const handleRightPanelResizeStart = useCallback((e: React.MouseEvent) => {
    if (isMobile) return;
    e.preventDefault();
    const startX = e.clientX;
    // Live rect, not state: it always reflects the committed width (custom or
    // fluid default), and keeps this callback above the state declarations
    // without a TDZ cycle. The handle only exists while the panel is open.
    const startWidth = rightPanelRef.current?.getBoundingClientRect().width
      ?? RIGHT_PANEL_MIN_WIDTH;
    // Same --ui-scale ground truth as the left sidebar handle: clientX is in
    // viewport pixels while the panel width is zoomed layout pixels.
    let uiScale = 1;
    try {
      const raw = getComputedStyle(document.documentElement).getPropertyValue("--ui-scale");
      const value = parseFloat(raw);
      if (Number.isFinite(value) && value > 0) uiScale = value;
    } catch {
      // SSR/unavailable: fall back to unscaled math.
    }
    setRightPanelResizing(true);
    const onMove = (ev: MouseEvent) => {
      // Dragging the left edge left grows the panel: inverse of the sidebar.
      const next = clampRightPanelWidth(startWidth - (ev.clientX - startX) / uiScale);
      // Write the CSS variable straight to the DOM: the flex row follows the
      // pointer without re-rendering the whole AppShell on every mousemove.
      rightPanelRef.current?.style.setProperty("--right-panel-width", `${next}px`);
      pendingRightPanelWidthRef.current = next;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      rightResizeHandlersRef.current = null;
      setRightPanelResizing(false);
      // Commit the final width so state and the persisted value agree with
      // what the user actually dragged to.
      setRightPanelWidth(pendingRightPanelWidthRef.current);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    pendingRightPanelWidthRef.current = startWidth;
    rightResizeHandlersRef.current = { onMove, onUp };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [isMobile]);

  // If the app unmounts mid-drag, remove the window listeners and restore the
  // body cursor; otherwise the handlers leak and body stays cursor:col-resize.
  useEffect(() => () => {
    const handlers = rightResizeHandlersRef.current;
    if (!handlers) return;
    window.removeEventListener("mousemove", handlers.onMove);
    window.removeEventListener("mouseup", handlers.onUp);
    rightResizeHandlersRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);


  // Dismiss the topbar dropdowns on outside click or Escape. The Escape
  // handler stops propagation so the global Esc (abort agent) does not fire
  // while a panel is open.
  useEffect(() => {
    // The branch panel manages its own outside-click and Escape dismissal.
    if (!activeTopPanel || activeTopPanel === "branches") return;
    const onPointerDown = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-top-panel]")) return;
      setActiveTopPanel(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setActiveTopPanel(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [activeTopPanel]);

  // Right panel tabs: Explorer | Git changes | open files (Tauri parity).
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightView, setRightView] = useState<"explorer" | "git" | "file">("explorer");
  // User-chosen pixel width (null = fluid 42% default), persisted.
  const [rightPanelWidth, setRightPanelWidth] = useState<number | null>(null);
  const [rightPanelResizing, setRightPanelResizing] = useState(false);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const pendingRightPanelWidthRef = useRef<number | null>(null);
  const rightResizeHandlersRef = useRef<{ onMove: (ev: MouseEvent) => void; onUp: () => void } | null>(null);
  useEffect(() => {
    setRightPanelWidth(loadRightPanelWidth());
  }, []);
  // One-shot request asking the explorer tab to expand + scroll to a file.
  const [revealPath, setRevealPath] = useState<string | null>(null);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [explorerUploadBusy, setExplorerUploadBusy] = useState(false);
  const [explorerGitCount, setExplorerGitCount] = useState(0);
  const [explorerIsRepo, setExplorerIsRepo] = useState(false);
  const fileExplorerRef = useRef<FileExplorerHandle>(null);
  const handleExplorerGitStatus = useCallback((changedCount: number, isRepo: boolean) => {
    setExplorerGitCount(changedCount);
    setExplorerIsRepo(isRepo);
  }, []);
  // Same guard as the left sidebar: skip the mount run and mid-drag writes. A
  // reset (null) removes the key so the fluid default returns.
  const rightPanelWidthMountedRef = useRef(false);
  useEffect(() => {
    if (!rightPanelWidthMountedRef.current) {
      rightPanelWidthMountedRef.current = true;
      return;
    }
    if (rightPanelResizing) return;
    try {
      if (rightPanelWidth === null) window.localStorage.removeItem(RIGHT_PANEL_WIDTH_STORAGE_KEY);
      else window.localStorage.setItem(RIGHT_PANEL_WIDTH_STORAGE_KEY, String(rightPanelWidth));
    } catch {
      // ignore storage quota / privacy-mode errors
    }
  }, [rightPanelWidth, rightPanelResizing]);

  // Same @mention format as the chat input's @ autocomplete, so the agent's
  // read tool resolves it the same way (it strips the @ prefix).
  const handleAtMention = useCallback((relativePath: string, isDir: boolean) => {
    chatInputRef.current?.insertText(buildAtMentionText(relativePath, isDir));
  }, []);

  const handleAtMentions = useCallback((relativePaths: string[]) => {
    const mentions = buildFileAtMentionsText(relativePaths);
    if (mentions) chatInputRef.current?.insertText(mentions);
  }, []);

  const handleFileLineMention = useCallback((relativePath: string, startLine: number, endLine: number) => {
    chatInputRef.current?.insertText(buildFileLineMentionText(relativePath, startLine, endLine));
  }, []);

  const initialSessionId = initialNavigation.sessionId;
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(() => !initialSessionId);
  // During the initial URL restore the sidebar adopts the restored cwd and
  // notifies us; that first onCwdChange must not bump sessionKey. We store the
  // expected cwd string and only skip when it matches, so a failure to fire
  // can't leave the suppression armed for the user's next genuine switch.
  const suppressCwdRef = useRef<string | null>(null);

  useEffect(() => {
    const requestedCwd = initialNavigation.requestedCwd;
    if (!requestedCwd) return;

    const controller = new AbortController();
    setInitialCwdStatus("validating");
    setInitialCwdError(null);

    void fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: requestedCwd }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string; code?: string };
        if (!response.ok || !data.cwd) {
          throw new Error(data.error || data.code ? formatApiError(data) : `HTTP ${response.status}`);
        }

        // The sidebar will notify us when it adopts this cwd. Avoid remounting
        // the just-created empty chat during that initial synchronization.
        suppressCwdRef.current = data.cwd;
        setInitialCwdStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setInitialCwdError(error instanceof Error ? error.message : String(error));
        setInitialCwdStatus("error");
      });

    return () => controller.abort();
  }, [initialNavigation]);

  const handleCwdChange = useCallback((cwd: string | null, projectRoot?: string | null) => {
    setActiveCwd(cwd);
    // Skip if cwd is null (initial mount) or during the initial URL restore.
    if (!cwd) return;
    // Skip only when the notification matches the cwd we're suppressing for.
    if (suppressCwdRef.current !== null && suppressCwdRef.current === cwd) {
      suppressCwdRef.current = null;
      return;
    }
    // Worktrees of one repo share a project root. Moving the effective cwd
    // within the same project (e.g. switching worktree, or clicking a session
    // that lives in another worktree) must not close the open session.
    // Compare case-folded: the same folder can be spelled with different
    // casing (Windows/NTFS) between the session's projectRoot and the
    // sidebar's resolved project root.
    const newProject = projectRoot ?? cwd;
    const sessionProject = selectedSession ? (selectedSession.projectRoot ?? selectedSession.cwd) : null;
    if (sessionProject && comparableProjectPath(sessionProject) === comparableProjectPath(newProject)) {
      return;
    }
    // Close any session that belongs to a different project — it no longer
    // matches the selected project directory.
    setSelectedSession(null);
    setNewSessionCwd((prev) => {
      if (prev && prev !== cwd) return null;
      return prev;
    });
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setSystemPromptLoading(false);
    setActiveTopPanel(null);
    router.replace("/", { scroll: false });
  }, [router, selectedSession]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false) => {
    // Re-picking the already-open session (sidebar double-click, palette
    // re-select, notification click) must not bump sessionKey: that remounts
    // ChatWindow, reconnects SSE, and drops the mid-run streaming view.
    setSettingsTab(null);
    if (!isRestore && session.id === selectedSession?.id) return;
    setNewSessionCwd(null);
    setSelectedSession(session);
    setSessionKey((k) => k + 1);
    setSystemPrompt(null);
    setSystemPromptLoading(false);
    setInitialSessionRestored(true);
    // On mobile, collapse the overlay drawer so the chat is revealed after pick.
    if (isMobile && !isRestore) setSidebarOpen(false);
    if (isRestore) {
      // Suppress the redundant sessionKey bump that would come from the
      // onCwdChange effect firing after setSelectedCwd in the sidebar. We
      // arm the expected cwd (compared in handleCwdChange) rather than a
      // sticky flag so a missed notification can't suppress the next
      // genuine project switch.
      suppressCwdRef.current = session.cwd;
    }
    // Skip router.replace when restoring from URL — the param is already correct
    // and calling replace in production Next.js triggers a Suspense remount loop
    if (!isRestore) {
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    }
  }, [router, isMobile, selectedSession?.id]);

  const handleNewSession = useCallback((_sessionId: string, cwd: string) => {
    setSettingsTab(null);
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setSystemPromptLoading(false);
    setActiveTopPanel(null);
    if (isMobile) setSidebarOpen(false);
    router.replace("/", { scroll: false });
  }, [router, isMobile]);

  // Global keyboard shortcuts (handles Esc, Ctrl+Alt+N etc.)
  useGlobalKeyboardShortcuts({
    onNewSession: (cwd: string) => handleNewSession(`kb-${Date.now()}`, cwd),
    activeCwd,
  });

  // Client-built transient SessionInfo (new session / fork) lacks the
  // server-computed projectRoot, which the same-project check in
  // handleCwdChange relies on. Hydrate it from the session list so switching
  // worktrees right after creating a session doesn't close the chat.
  const hydrateSelectedSession = useCallback((sessionId: string) => {
    void fetch("/api/sessions")
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        const full = d?.sessions.find((s) => s.id === sessionId);
        if (!full) return;
        setSelectedSession((prev) => (prev && prev.id === sessionId && !prev.projectRoot ? full : prev));
      })
      .catch(() => {});
  }, []);

  // Called by ChatWindow when a new session gets its real id from pi
  const handleSessionCreated = useCallback((session: SessionInfo) => {
    setNewSessionCwd(null);
    setSelectedSession(session);
    setRefreshKey((k) => k + 1);
    hydrateSelectedSession(session.id);
    router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
  }, [router, hydrateSelectedSession]);

  const handleAgentEnd = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
    if (document.visibilityState !== "hidden" || !("Notification" in window)) return;

    const targetSession = selectedSession;
    const notify = () => {
      showCompletionNotification(
        targetSession?.name ?? translate("appShell.sessionComplete"),
        translate("appShell.taskFinished"),
        () => {
          window.focus();
          if (targetSession) handleSelectSession(targetSession);
        },
      );
    };
    if (Notification.permission === "granted") notify();
    else if (Notification.permission === "default") {
      void Notification.requestPermission().then((permission) => { if (permission === "granted") notify(); });
    } else {
      // "denied": the OS blocks notifications, so surface the completion as an
      // in-app toast instead of leaving background completions silent.
      toast.info(targetSession?.name ?? translate("appShell.sessionComplete"), translate("appShell.taskFinished"));
    }
  }, [handleSelectSession, selectedSession]);

  const handleAutoName = useCallback(async () => {
    const sessionId = selectedSession?.id;
    if (!sessionId || autoNameStatus.kind === "naming") return;
    clearTimeout(autoNameTimerRef.current);
    setActiveTopPanel(null);
    setAutoNameStatus({ kind: "naming" });

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/auto-name`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as { title?: string; error?: string; code?: string };
      if (!response.ok || !body.title) {
        throw new Error(body.error || body.code ? formatApiError(body) : `HTTP ${response.status}`);
      }

      const title = body.title.trim();
      if (activeSessionIdRef.current !== sessionId) return;
      setRefreshKey((key) => key + 1);
      setSelectedSession((current) => current?.id === sessionId ? { ...current, name: title } : current);
      setSessionStats((current) => current?.sessionId === sessionId ? { ...current, sessionName: title } : current);
      setAutoNameStatus({ kind: "success" });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 1800);
    } catch (error) {
      if (activeSessionIdRef.current !== sessionId) return;
      const message = error instanceof Error ? error.message : String(error);
      setAutoNameStatus({ kind: "error", message });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 5000);
    }
  }, [autoNameStatus.kind, selectedSession?.id]);

  useEffect(() => {
    clearTimeout(autoNameTimerRef.current);
    setAutoNameStatus({ kind: "idle" });
  }, [selectedSession?.id]);

  const handleExplorerRefresh = useCallback(() => {
    setExplorerRefreshing(true);
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const handleExplorerRefreshDone = useCallback(() => {
    setExplorerRefreshing(false);
  }, []);

  const handleSessionForked = useCallback((newSessionId: string) => {
    setRefreshKey((k) => k + 1);
    setSessionKey((k) => k + 1);
    setNewSessionCwd(null);
    setSelectedSession((prev) => ({
      ...(prev ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      id: newSessionId,
      // path === "" is the sidebar's optimistic-row marker; keep it so the
      // fork shows up immediately instead of waiting for a refresh.
      path: "",
    }));
    hydrateSelectedSession(newSessionId);
    router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
  }, [router, hydrateSelectedSession]);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    setRefreshKey((k) => k + 1);
    if (selectedSession?.id === sessionId) {
      const cwd = selectedSession.cwd;
      setSelectedSession(null);
      setNewSessionCwd(cwd ?? null);
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      setActiveTopPanel(null);
      router.replace("/", { scroll: false });
    }
  }, [selectedSession, router]);
  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  const handleArchiveRestored = useCallback(async (sessionId: string) => {
    setArchiveBrowserOpen(false);
    publishSessionsChanged([sessionId]);
    setRefreshKey((k) => k + 1);

    // The poll must not yank the UI back to the restored session if the user
    // picks another one while we wait, and an untracked setTimeout chain would
    // keep retrying after unmount — so freeze the selection at start, bail out
    // of every attempt + the fallback when it changed, and track the timer.
    const sessionAtRestoreStart = activeSessionIdRef.current;
    const selectRestoredSession = async (attemptsLeft = 5): Promise<void> => {
      if (activeSessionIdRef.current !== sessionAtRestoreStart) return;
      try {
        const res = await fetch("/api/sessions");
        if (res.ok) {
          const data = (await res.json()) as { sessions?: SessionInfo[] };
          const found = data.sessions?.find((s) => s.id === sessionId);
          if (found) {
            if (activeSessionIdRef.current !== sessionAtRestoreStart) return;
            handleSelectSession(found, false);
            return;
          }
        }
      } catch {
        // network error / abort
      }

      if (attemptsLeft > 0) {
        archiveRetryTimerRef.current = setTimeout(() => void selectRestoredSession(attemptsLeft - 1), 300);
      } else if (activeSessionIdRef.current === sessionAtRestoreStart) {
        router.replace(`?session=${encodeURIComponent(sessionId)}`, { scroll: false });
      }
    };

    void selectRestoredSession();
  }, [handleSelectSession, router]);

  const handleCloseFileTab = useCallback((tabId: string) => {
    // Compute everything from the current list outside the updaters: no side
    // effect inside a state updater, and no stale-closure read (the callback
    // is recreated whenever fileTabs changes, but a batched double-close
    // would still have read the pre-close list from the closure).
    const next = fileTabs.filter((t) => t.id !== tabId);
    setFileTabs(next);
    // The panel now hosts the Explorer tab, so it stays open: closing the
    // last file falls back to the explorer instead of hiding the panel.
    if (next.length === 0) setRightView("explorer");
    setActiveFileTabId((cur) => {
      if (cur !== tabId) return cur;
      return next.length > 0 ? next[next.length - 1].id : null;
    });
  }, [fileTabs]);

  const handleOpenFile = useCallback((filePath: string, fileName: string, sourceSessionId?: string | null) => {
    const tabId = `file:${filePath}`;
    setFileTabs((prev) => {
      const existing = prev.find((t) => t.id === tabId);
      if (!existing) return [...prev, { id: tabId, label: fileName, filePath, sourceSessionId }];
      if (!sourceSessionId || existing.sourceSessionId === sourceSessionId) return prev;
      return prev.map((t) => t.id === tabId ? { ...t, sourceSessionId } : t);
    });
    setActiveFileTabId(tabId);
    setRightView("file");
    setRightPanelOpen(true);
    // On mobile the file panel is full-screen; close the drawer so it shows.
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  const activeFileTab = fileTabs.find((tab) => tab.id === activeFileTabId) ?? null;
  // Explorer tab browses the active workspace: live cwd first, then the
  // selected / new-session cwd (mirrors what the sidebar used to pass down).
  const explorerCwd = activeCwd ?? selectedSession?.cwd ?? newSessionCwd ?? null;
  const handleOpenLinkedFile = useCallback((filePath: string) => {
    handleOpenFile(filePath, getFileName(filePath), selectedSession?.id ?? null);
  }, [handleOpenFile, selectedSession?.id]);

  // File-panel integrations: every action works on the active tab so the right
  // panel behaves like an editor toolbar, not just a tab strip.
  const handleMentionActiveFile = useCallback(() => {
    if (!activeFileTab) return;
    handleAtMention(getRelativeFilePath(activeFileTab.filePath, activeCwd ?? undefined), false);
  }, [activeFileTab, activeCwd, handleAtMention]);

  const handleCopyActiveFilePath = useCallback(() => {
    if (!activeFileTab) return;
    const relative = getRelativeFilePath(activeFileTab.filePath, activeCwd ?? undefined);
    copyText(relative).then(
      () => toast.success(t("appShell.copied")),
      () => toast.error(t("appShell.commandCopyFailed")),
    );
  }, [activeFileTab, activeCwd, t]);

  const handleDownloadActiveFile = useCallback(() => {
    if (!activeFileTab) return;
    const link = document.createElement("a");
    link.href = `/api/files/${encodeFilePathForApi(activeFileTab.filePath)}?type=download`;
    link.download = activeFileTab.label;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, [activeFileTab]);
  const handleRevealActiveFile = useCallback(() => {
    if (!activeFileTab) return;
    setRevealPath(activeFileTab.filePath);
    setRightView("explorer");
    setRightPanelOpen(true);
  }, [activeFileTab]);

  const handleSelectFileTab = useCallback((tabId: string) => {
    setActiveFileTabId(tabId);
    setRightView("file");
  }, []);
  // Stable selectors for the memoized RightPanel: inline arrows here would be
  // new identities every render and defeat the memo boundary.
  const handleSelectRightView = useCallback((view: RightPanelView) => {
    setRightView(view);
  }, []);

  const handleRevealDone = useCallback(() => {
    setRevealPath(null);
  }, []);

  const handleToggleFileSearch = useCallback(() => {
    setFileSearchOpen((open) => !open);
  }, []);

  const handleCloseOtherFileTabs = useCallback(() => {
    if (!activeFileTab) return;
    setFileTabs([activeFileTab]);
  }, [activeFileTab]);

  const handleCloseAllFileTabs = useCallback(() => {
    setFileTabs([]);
    setActiveFileTabId(null);
    setRightView("explorer");
  }, []);

  const handleViewFullHistory = useCallback(() => {
    if (!selectedSession) return;
    window.open(
      `/api/sessions/${encodeURIComponent(selectedSession.id)}/export?inline=1`,
      "_blank",
      "noopener,noreferrer",
    );
  }, [selectedSession]);

  // Show chat area if a session is selected, or if we have a cwd to start a new session in
  const effectiveNewSessionCwd = newSessionCwd ?? (selectedSession === null && activeCwd ? activeCwd : null);
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat;

  const activeCwdName = activeCwd ? getFileName(activeCwd) || activeCwd : null;
  const windowTitle = activeCwdName ? `${activeCwdName} - omp web` : "omp web";

  useEffect(() => {
    const syncWindowTitle = () => {
      if (document.title !== windowTitle) document.title = windowTitle;
    };

    syncWindowTitle();
    const observer = new MutationObserver(syncWindowTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [windowTitle]);

  const sidebarContent = (
    <SessionSidebar
      selectedSessionId={selectedSession?.id ?? null}
      optimisticSession={selectedSession?.path === "" ? selectedSession : null}
      onSelectSession={handleSelectSession}
      onNewSession={handleNewSession}
      initialSessionId={initialSessionId}
      skipInitialProjectSelection={initialNavigation.requestedCwd !== null}
      onInitialRestoreDone={handleInitialRestoreDone}
      refreshKey={refreshKey}
      onSessionDeleted={handleSessionDeleted}
      selectedCwd={selectedSession?.cwd ?? newSessionCwd ?? null}
      onCwdChange={handleCwdChange}
      usageVisible={providerUsageVisible}
      settingsOpen={Boolean(settingsTab)}
      onOpenSettings={() => setSettingsTab((prev) => prev ? null : "general")}
      onOpenArchive={() => setArchiveBrowserOpen(true)}
      updateAvailable={Boolean(appUpdate?.updateAvailable) || ompUpdateAvailable}
    />
  );

  return (
    <>
    <ToastProvider>
      <CommandPalette
        onSelectSession={handleSelectSession}
        onNewSession={() => {
          // An empty cwd is truthy, so showChat would render the shell while
          // useAgentSession refuses to start — every send a silent no-op.
          // Fall back to the server's default cwd (~/omp-cwd-<date>) instead.
          if (activeCwd) {
            handleNewSession(`palette-${Date.now()}`, activeCwd);
            return;
          }
          void fetch("/api/default-cwd", { method: "POST" })
            .then(async (response) => {
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              const data = (await response.json()) as { cwd?: string };
              if (!data.cwd) throw new Error("Empty cwd returned");
              return data;
            })
            .then((data) => {
              if (!data.cwd) throw new Error("Empty cwd returned");
              handleNewSession(`palette-${Date.now()}`, data.cwd);
            })
            .catch(() => toast.error(translate("errors.generic")));
        }}
        currentModel={null}
      />
    <style>{`
      @keyframes session-info-pop {
        0% {
          opacity: 0;
          transform: translateY(-24px);
        }
        100% {
          opacity: 1;
          transform: translateY(0);
        }
      }
      @keyframes session-info-light-wash {
        0% {
          opacity: 0;
          transform: translateX(-110%) skewX(-16deg);
        }
        24% {
          opacity: 0.42;
        }
        100% {
          opacity: 0;
          transform: translateX(115%) skewX(-16deg);
        }
      }
      .session-info-popover {
        position: relative;
        overflow: visible;
        transform-origin: top right;
        animation: session-info-pop var(--dur-slow) var(--ease-out-warm) both;
        will-change: transform, opacity;
      }
      .session-info-popover::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 44%;
        pointer-events: none;
        background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 24%, transparent), transparent);
        animation: session-info-light-wash var(--dur-slow) var(--ease-out-warm) both;
      }
      @media (prefers-reduced-motion: reduce) {
        .session-info-popover,
        .session-info-popover::after {
          animation: none;
        }
      }
      @media (max-width: 640px) {
        .sidebar-overlay-backdrop.sidebar-mobile-pending {
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .sidebar-container.sidebar-mobile-pending.sidebar-open {
          transform: translateX(-100%);
          box-shadow: none;
        }
      }
    `}</style>
    <div style={{ display: "flex", height: "100%", flex: 1, overflow: "hidden", background: "var(--bg)" }}>
      {/* Left sidebar: hidden on full-page Settings */}
      {!settingsTab && (
        <>
      {/* Mobile overlay backdrop */}
      <div
        className={`sidebar-overlay-backdrop${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
        onClick={() => setSidebarOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "color-mix(in srgb, var(--text) 28%, transparent)",
          opacity: sidebarOpen ? 1 : 0,
          pointerEvents: sidebarOpen ? "auto" : "none",
          transition: "opacity var(--dur-slow) var(--ease-out-warm)",
        }}
      />

      {/* Left sidebar */}
      <div
        ref={sidebarContainerRef}
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}${sidebarResizing ? " sidebar-resizing" : ""}`}
        aria-hidden={mobileSidebarReady && !sidebarOpen ? true : undefined}
        inert={mobileSidebarReady && !sidebarOpen ? true : undefined}
        style={{
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          zIndex: 200,
          // Desktop-only: the width is user-adjustable via the resize handle.
          ...(!isMobile ? { "--sidebar-width": `${sidebarWidth}px` } : {}),
        }}
      >
        {sidebarContent}
      </div>

      {/* Resize handle — desktop only, hidden while the sidebar is closed */}
      {!isMobile && sidebarOpen && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("appShell.resizeSidebar")}
          tabIndex={0}
          onMouseDown={handleSidebarResizeStart}
          onDoubleClick={resetSidebarWidth}
          onKeyDown={handleSidebarResizeKey}
          title={t("appShell.resizeSidebarTitle")}
          style={{
            width: 5,
            flexShrink: 0,
            marginLeft: -5,
            cursor: "col-resize",
            background: "transparent",
            zIndex: 205,
            outline: "none",
            transition: "background var(--dur-fast) var(--ease-out-warm)",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 35%, transparent)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          onFocus={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 35%, transparent)"; }}
          onBlur={(e) => { e.currentTarget.style.background = "transparent"; }}
        />
      )}
        </>
      )}

      {/* Center: chat */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {settingsTab ? (
          <SettingsConfig
            activeTab={settingsTab}
            toolCallsDefaultCollapsed={toolCallsDefaultCollapsed}
            onToolCallsDefaultCollapsedChange={handleToolCallsDefaultCollapsedChange}
            providerUsageVisible={providerUsageVisible}
            onProviderUsageVisibleChange={handleProviderUsageVisibleChange}
            cwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd}
            sessionId={selectedSession?.id ?? null}
            onModelsSaved={() => setModelsRefreshKey((k) => k + 1)}
            onPluginsReloaded={() => setSessionKey((k) => k + 1)}
            appUpdate={appUpdate}
            onRefreshAppUpdate={refreshAppUpdate}
            onOmpUpdateAvailabilityChange={setOmpUpdateAvailable}
            onRequestAppUpdate={requestAppUpdateFromSettings}
            onSelectTab={setSettingsTab}
            onClose={() => setSettingsTab(null)}
          />
        ) : (
          <>
        {/* Top bar: 3-zone segmented control bar */}
        <div ref={topBarRef} className="shell-topbar" style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
          borderBottom: "1px solid var(--border)",
          height: isMobile ? 44 : 36,
          background: "var(--bg-panel)",
          padding: isMobile ? "0 4px" : "0 8px",
          gap: 8,
          minWidth: 0,
        }}>
          {/* Left Zone: Utility group (sidebar, theme, language) & session controls (history, branches, system) */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, height: "100%", flexShrink: 0 }}>
            <button
              onClick={handleSidebarToggle}
              title={sidebarOpen ? t("appShell.hideSidebar") : t("appShell.showSidebar")}
              aria-label={sidebarOpen ? t("appShell.hideSidebar") : t("appShell.showSidebar")}
              className="shell-toolbar-btn ui-focus-ring"
            >
              {sidebarOpen ? <PanelLeft size={16} strokeWidth={1.8} aria-hidden="true" /> : <Menu size={16} strokeWidth={1.8} aria-hidden="true" />}
            </button>
            <ThemeSwitcher />
            <LanguageSwitcher />
            {showChat && (
              <>
                <div className="shell-toolbar-divider" aria-hidden="true" />
                <button
                  onClick={handleViewFullHistory}
                  disabled={!selectedSession}
                  title={selectedSession ? t("appShell.fullHistory") : t("appShell.fullHistoryUnavailable")}
                  aria-label={t("appShell.fullHistory")}
                  className="shell-toolbar-btn ui-focus-ring"
                >
                  <History size={16} strokeWidth={1.8} aria-hidden="true" />
                </button>
                <BranchNavigator
                  tree={branchTree}
                  activeLeafId={branchActiveLeafId}
                  onLeafChange={handleBranchLeafChange}
                  inline
                  containerRef={topBarRef}
                  open={activeTopPanel === "branches"}
                  onToggle={() => toggleTopPanel("branches")}
                  hasSession
                />
                <button
                  ref={systemBtnRef}
                  onClick={handleSystemPromptToggle}
                  title={t("appShell.system")}
                  aria-label={t("appShell.system")}
                  aria-pressed={activeTopPanel === "system"}
                  className="shell-toolbar-btn ui-focus-ring"
                >
                  <Terminal size={16} strokeWidth={1.8} aria-hidden="true" style={{ color: systemPrompt ? "var(--accent)" : undefined }} />
                </button>
              </>
            )}
          </div>

          {/* Center Zone: Workspace & Session Breadcrumb + Auto-name action */}
          {showChat && (() => {
            const effectiveProject = selectedSession?.projectRoot ?? selectedSession?.cwd ?? activeCwd ?? "";
            const sessionTitle = selectedSession?.name || selectedSession?.firstMessage || t("appShell.newSession");
            const hasMessages = Boolean(
              selectedSession
              && (sessionStats?.userMessages ?? selectedSession.messageCount) > 0,
            );
            const wandDisabled = !selectedSession || !hasMessages || autoNameStatus.kind === "naming";
            const wandIsSuccess = autoNameStatus.kind === "success";
            const wandIsError = autoNameStatus.kind === "error";
            const wandLabel = autoNameStatus.kind === "naming"
              ? t("appShell.generating")
              : wandIsSuccess
                ? t("appShell.titleUpdated")
                : wandIsError
                  ? t("appShell.generationFailed")
                  : t("appShell.generateTitle");
            const wandTooltip = !selectedSession
              ? t("appShell.titleGenUnavailable")
              : !hasMessages
                ? t("appShell.titleGenNeedsMessage")
                : wandIsError
                  ? autoNameStatus.message
                  : t("appShell.generateSessionTitle");

            return (
              <div
                className="shell-topbar-center"
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <div
                  className="shell-topbar-breadcrumb"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    height: 26,
                    padding: "0 8px",
                    borderRadius: "var(--radius-control)",
                    background: "var(--bg-subtle)",
                    border: "1px solid var(--border)",
                    fontSize: 11,
                    color: "var(--text-muted)",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                    maxWidth: "min(400px, 30vw)",
                    flexShrink: 1,
                  }}
                >
                  {effectiveProject ? (
                    <>
                      <Folder size={12} strokeWidth={1.8} style={{ opacity: 0.6, flexShrink: 0 }} aria-hidden="true" />
                      <span
                        style={{
                          fontWeight: 600,
                          color: "var(--text)",
                          flexShrink: 0,
                          maxWidth: 120,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={effectiveProject}
                      >
                        {projectLabel(effectiveProject)}
                      </span>
                      <span style={{ color: "var(--text-dim)", flexShrink: 0, opacity: 0.5 }}>/</span>
                    </>
                  ) : null}
                  <span
                    style={{
                      color: "var(--text)",
                      fontWeight: 500,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      minWidth: 0,
                    }}
                    title={sessionTitle}
                  >
                    {sessionTitle}
                  </span>
                  {selectedSession && (
                    <button
                      type="button"
                      onClick={() => void handleAutoName()}
                      disabled={wandDisabled}
                      title={wandTooltip}
                      aria-label={wandLabel}
                      className="ui-focus-ring"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 18,
                        height: 18,
                        padding: 0,
                        marginLeft: 2,
                        border: "none",
                        borderRadius: 4,
                        background: "transparent",
                        color: wandIsSuccess ? "var(--accent)" : wandIsError ? "var(--status-error)" : "var(--text-dim)",
                        cursor: wandDisabled ? "default" : "pointer",
                        flexShrink: 0,
                        opacity: autoNameStatus.kind === "naming" ? 1 : wandDisabled ? 0.35 : 0.75,
                        transition: "color var(--dur-fast), opacity var(--dur-fast)",
                      }}
                    >
                      {autoNameStatus.kind === "naming" ? (
                        <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                          <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                      ) : wandIsSuccess ? (
                        <Check size={12} strokeWidth={2} aria-hidden="true" />
                      ) : (
                        <Wand2 size={12} strokeWidth={1.8} aria-hidden="true" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Right Zone: Segmented metric pills (Provider limits, Session Stats/Usage, Speed) */}
          <div
            data-topbar-right-group
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: "100%",
              paddingRight: isMobile ? (rightPanelOpen ? 0 : 44) : rightPanelOpen ? 8 : 44,
              flexShrink: 0,
            }}
          >

            {/* Generation speed pill */}
            {showChat && (() => {
              const currentSpeedStr = generationSpeed?.current !== null && generationSpeed?.current !== undefined
                ? `${generationSpeed.current.toFixed(1)} t/s`
                : null;
              const averageSpeedStr = generationSpeed?.average !== null && generationSpeed?.average !== undefined
                ? `AVG ${generationSpeed.average.toFixed(1)} t/s`
                : null;
              if (!currentSpeedStr && !averageSpeedStr) return null;
              const speedTitle = currentSpeedStr
                ? t("appShell.tooltipCurrentSpeed", { value: currentSpeedStr })
                : t("appShell.tooltipAverageSpeed", { value: averageSpeedStr! });

              return (
                <div
                  title={speedTitle}
                  className="shell-metric-pill shell-pill-extra"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    height: 26,
                    padding: "0 8px",
                    borderRadius: "var(--radius-control)",
                    border: "1px solid var(--border)",
                    background: "var(--bg-subtle)",
                    color: currentSpeedStr ? "var(--accent)" : "var(--text-muted)",
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    fontVariantNumeric: "tabular-nums",
                    whiteSpace: "nowrap",
                    cursor: "default",
                    flexShrink: 0,
                  }}
                >
                  <Zap size={11} strokeWidth={2} aria-hidden="true" style={{ color: currentSpeedStr ? "var(--accent)" : "var(--text-dim)" }} />
                  <span style={{ fontWeight: currentSpeedStr ? 600 : 400 }}>
                    {currentSpeedStr ?? averageSpeedStr}
                  </span>
                </div>
              );
            })()}
          </div>
          {activeTopPanel === "system" && (
            <div data-top-panel className="dropdown-surface" style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              left: isMobile ? 4 : 8,
              right: "auto",
              width: "auto",
              minWidth: isMobile ? undefined : 420,
              maxWidth: "min(680px, calc(100vw - 24px))",
              maxHeight: "min(70vh, calc(100dvh - 56px))",
              overflowY: "auto",
              overflowX: "hidden",
              zIndex: 500,
            }}>
              {activeTopPanel === "system" && (
                <div className="session-info-popover" style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                  boxShadow: "var(--shadow-pop)",
                  minWidth: isMobile ? undefined : 420,
                }}>
                  {systemPrompt ? (
                    <div style={{
                      maxHeight: "min(600px, 75vh)",
                      overflowY: "auto",
                      padding: "12px 16px",
                      color: "var(--text-muted)",
                      fontSize: 12,
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                      fontFamily: "var(--font-mono)",
                    }}>
                      {systemPrompt}
                    </div>
                  ) : systemPrompt === "" ? (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                      {t("appShell.systemPromptEmpty")}
                    </div>
                  ) : (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                      {systemPromptLoading ? t("appShell.systemPromptLoading") : t("appShell.systemPromptLoadHint")}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        </div>

        {/* Chat content */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          {showChat ? (
            <ChatWindow
              key={sessionKey}
              session={selectedSession}
              newSessionCwd={effectiveNewSessionCwd}
              onAgentEnd={handleAgentEnd}
              onSessionCreated={handleSessionCreated}
              onSessionForked={handleSessionForked}
              modelsRefreshKey={modelsRefreshKey}
              chatInputRef={chatInputRef}
              onOpenFile={handleOpenLinkedFile}
              onBranchDataChange={handleBranchDataChange}
              onSystemPromptChange={handleSystemPromptChange}
              onSystemPromptLoaderChange={handleSystemPromptLoaderChange}
              onSessionStatsChange={handleSessionStatsChange}
              onSessionStatsPanelOpen={openSessionStatsPanel}
              onGenerationSpeedChange={handleGenerationSpeedChange}
              onOpenProviders={() => setSettingsTab("providers")}
            />
          ) : initialCwdStatus === "validating" ? (
            <div
              role="status"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
              <div style={{ fontSize: 14, color: "var(--text)" }}>{t("appShell.openingWorkspace")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
            </div>
          ) : initialCwdStatus === "error" ? (
            <div
              role="alert"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
              <div style={{ fontSize: 14, color: "var(--status-error)" }}>{t("appShell.unableToOpenWorkspace")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
              <div style={{ maxWidth: 720, fontSize: 12 }}>{initialCwdError}</div>
            </div>
          ) : !showPlaceholder ? (
            <PanelLoadingFallback />
          ) : (
            activeCwd ? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 16 }}>
                <span className="display-serif">{t("appShell.selectSessionHint")}</span>
              </div>
            ) : (
              <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "flex-start", gap: 8, userSelect: "none", pointerEvents: "none" }}>
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
                  <line x1="20" y1="12" x2="4" y2="12" /><polyline points="10 6 4 12 10 18" />
                </svg>
                <div>
                  <div className="display-serif" style={{ fontSize: 20, color: "var(--text)", marginBottom: 8 }}>{t("appShell.getStarted")}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                    <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>{t("appShell.getStartedStep1")}<br />
                    <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>
                    {(() => {
                      // One translatable sentence; the {models} slot is rendered
                      // as the emphasized button name so word order stays free.
                      const [before, after] = t("appShell.getStartedStep2").split("{models}");
                      return (
                        <>
                          {before}
                          <strong style={{ color: "var(--text)" }}>{t("appShell.models")}</strong>
                          {after}
                        </>
                      );
                    })()}
                  </div>
                </div>
              </div>
            )
          )}
        </div>
          </>
        )}
      </main>
      {!settingsTab && (
        <RightPanel
        fileTabs={fileTabs}
        activeFileTabId={activeFileTabId}
        rightView={rightView}
        onSelectView={handleSelectRightView}
        rightPanelOpen={rightPanelOpen}
        rightPanelWidth={rightPanelWidth}
        rightPanelResizing={rightPanelResizing}
        rightPanelRef={rightPanelRef}
        fileExplorerRef={fileExplorerRef}
        revealPath={revealPath}
        onRevealDone={handleRevealDone}
        explorerCwd={explorerCwd}
        activeCwd={activeCwd}
        explorerRefreshKey={explorerRefreshKey}
        fileSearchOpen={fileSearchOpen}
        onToggleFileSearch={handleToggleFileSearch}
        onFileSearchOpenChange={setFileSearchOpen}
        explorerUploadBusy={explorerUploadBusy}
        onUploadBusyChange={setExplorerUploadBusy}
        explorerGitCount={explorerGitCount}
        explorerIsRepo={explorerIsRepo}
        explorerRefreshing={explorerRefreshing}
        isMobile={isMobile}
        onOpenFile={handleOpenFile}
        onSelectFileTab={handleSelectFileTab}
        onCloseFileTab={handleCloseFileTab}
        onCloseOtherFileTabs={handleCloseOtherFileTabs}
        onCloseAllFileTabs={handleCloseAllFileTabs}
        onMentionActiveFile={handleMentionActiveFile}
        onCopyActiveFilePath={handleCopyActiveFilePath}
        onDownloadActiveFile={handleDownloadActiveFile}
        onRevealActiveFile={handleRevealActiveFile}
        onExplorerRefresh={handleExplorerRefresh}
        onExplorerRefreshDone={handleExplorerRefreshDone}
        onAtMention={handleAtMention}
        onAtMentions={handleAtMentions}
        onMentionLines={handleFileLineMention}
        onExplorerGitStatus={handleExplorerGitStatus}
        onResetRightPanelWidth={resetRightPanelWidth}
        onRightPanelResizeStart={handleRightPanelResizeStart}
        onRightPanelResizeKey={handleRightPanelResizeKey}
      />
      )}

    </div>
    {!settingsTab && (
      <button
      onClick={() => setRightPanelOpen((v) => !v)}
      title={rightPanelOpen ? t("appShell.hideFilePanel") : t("appShell.showFilePanel")}
      aria-label={rightPanelOpen ? t("appShell.hideFilePanel") : t("appShell.showFilePanel")}
      style={{
        position: "fixed", top: 0, right: 0, zIndex: 300,
        display: "flex", alignItems: "center", justifyContent: "center",
        width: isMobile ? 44 : 36, height: isMobile ? 44 : 36, padding: 0,
        background: "var(--bg-panel)", border: "none", borderLeft: "1px solid var(--border)", borderBottom: "1px solid var(--border)",
        color: rightPanelOpen ? "var(--text)" : "var(--text-muted)",
        cursor: "pointer", transition: "color var(--dur-fast) var(--ease-out-warm)",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = rightPanelOpen ? "var(--text)" : "var(--text-muted)"; }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
      </svg>
    </button>
    )}
    <AppUpdateDialog open={appUpdateDialogOpen} update={appUpdate} phase={appUpdatePhase} visibleStage={appUpdateVisibleStage} error={appUpdateError} onProceed={() => void proceedWithAppUpdate()} onNotNow={dismissAppUpdate} />
    {archiveBrowserOpen && (
      <ArchiveBrowser
        open={archiveBrowserOpen}
        onClose={() => setArchiveBrowserOpen(false)}
        onRestored={handleArchiveRestored}
      />
    )}
    </ToastProvider>
    </>
  );
}
