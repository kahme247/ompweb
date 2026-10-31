"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalDialog } from "@/hooks/useModalDialog";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { appendProgress, cloneDirectoryName } from "@/lib/git-clone";

interface DirectoryEntry {
  name: string;
  path: string;
}

interface BrowseResponse {
  path?: string;
  parentPath?: string | null;
  directories?: DirectoryEntry[];
  drives?: DirectoryEntry[];
  error?: string;
  code?: string;
}

async function loadDirectories(directory?: string): Promise<BrowseResponse> {
  const query = directory ? `?path=${encodeURIComponent(directory)}` : "";
  const response = await fetch(`/api/cwd/browse${query}`);
  const data = await response.json() as BrowseResponse;
  if (!response.ok || data.error) {
    throw new Error(formatApiError({ ...data, error: data.error ?? `HTTP ${response.status}` }));
  }
  return data;
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M1.5 3h4l1.5 2h7.5v7.5h-13z" />
    </svg>
  );
}

function DriveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 9h12" />
      <circle cx="11.5" cy="11" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function isWindowsDriveRoot(directory: string): boolean {
  return /^[a-zA-Z]:[\\/]?$/.test(directory);
}

interface Props {
  onCancel: () => void;
  onSelect: (path: string, launchConfig?: { profile?: string; advisor?: boolean; extraArgs?: string[] }) => void;
  busy?: boolean;
  error?: string | null;
  /** A remote host the workspace is added on. Its folders cannot be browsed from
   *  here yet: the path is typed and validated by that host when selected. */
  host?: { name: string } | null;
}

export function DirectoryPicker({ onCancel, onSelect, busy = false, error, host = null }: Props) {
  const { t } = useI18n();
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [currentPath, setCurrentPath] = useState("");
  const [parentDirectory, setParentDirectory] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [directories, setDirectories] = useState<DirectoryEntry[]>([]);
  const [drives, setDrives] = useState<DirectoryEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [profile, setProfile] = useState("");
  const [advisor, setAdvisor] = useState(false);
  const [extraArgs, setExtraArgs] = useState("");
  const remote = host !== null;
  const [loading, setLoading] = useState(!remote);
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneId, setCloneId] = useState<string | null>(null);
  const [cloneLog, setCloneLog] = useState("");
  const [cloneStatus, setCloneStatus] = useState<string | null>(null);
  const cloneAbortRef = useRef<AbortController | null>(null);
  const cloneRespondedRef = useRef(false);
  const cloneLogRef = useRef<HTMLPreElement>(null);
  const cloning = cloneId !== null;
  const locked = busy || cloning;
  const dialogRef = useModalDialog<HTMLDivElement>({
    onClose: () => { if (!locked) onCancel(); },
    active: portalTarget !== null,
  });

  const navigateTo = useCallback(async (directory?: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await loadDirectories(directory);
      const nextPath = data.path ?? directory ?? "/";
      setCurrentPath(nextPath);
      setParentDirectory(data.parentPath ?? null);
      setPathInput(nextPath);
      setDirectories(data.directories ?? []);
      setDrives(data.drives ?? null);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setPortalTarget(document.body);
    if (!remote) void navigateTo();
  }, [navigateTo, remote]);

  // Unmounting mid-clone drops the stream; the server cancels and cleans up.
  useEffect(() => () => cloneAbortRef.current?.abort(), []);

  useEffect(() => {
    const log = cloneLogRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [cloneLog]);

  const handlePathSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const candidate = pathInput.trim();
    if (candidate && !remote) void navigateTo(candidate);
  };
  const hasUncommittedPath = !remote && pathInput.trim() !== currentPath;
  const cloneName = cloneUrl.trim() ? cloneDirectoryName(cloneUrl) : null;
  const cloneTarget = cloneName && currentPath ? `${currentPath.replace(/[\\/]+$/, "")}${currentPath.includes("\\") ? "\\" : "/"}${cloneName}` : null;
  const canSelect = Boolean(remote ? pathInput.trim() : currentPath) && !hasUncommittedPath && !locked && (!cloneUrl.trim() || cloneName !== null);
  const goDisabled = loading || remote || !pathInput.trim();
  const canNavigateUp = !remote && (Boolean(parentDirectory) || isWindowsDriveRoot(currentPath));
  const submitSelection = async () => {
    const args = extraArgs.split("\n").map((arg) => arg.trim()).filter(Boolean);
    const launchConfig = { profile: profile.trim() || undefined, advisor: advisor || undefined, extraArgs: args.length ? args : undefined };
    if (!cloneUrl.trim()) {
      onSelect(remote ? pathInput.trim() : currentPath, launchConfig);
      return;
    }
    const id = crypto.randomUUID();
    const abort = new AbortController();
    cloneAbortRef.current = abort;
    cloneRespondedRef.current = false;
    setCloneId(id);
    setCloneLog("");
    setCloneStatus(t("directoryPicker.cloning"));
    try {
      const response = await fetch("/api/projects/clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, parent: currentPath, url: cloneUrl.trim() }),
        signal: abort.signal,
      });
      cloneRespondedRef.current = true;
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({})) as { error?: string; code?: string };
        setCloneStatus(formatApiError({ ...data, error: data.error ?? `HTTP ${response.status}` }));
        return;
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffered = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += value;
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          const frame = JSON.parse(line) as { type: string; text?: string; path?: string; error?: string; code?: string };
          if (frame.type === "output") setCloneLog((log) => appendProgress(log, frame.text ?? ""));
          else if (frame.type === "done" && frame.path) {
            setCloneStatus(t("directoryPicker.cloneSucceeded", { path: frame.path }));
            // If registering fails, "Select this folder" can retry on the clone.
            setCloneUrl("");
            void navigateTo(frame.path);
            onSelect(frame.path, launchConfig);
            return;
          } else if (frame.type === "cancelled") {
            setCloneStatus(t("directoryPicker.cloneCancelled", { path: frame.path ?? "" }));
            return;
          } else if (frame.type === "error") {
            setCloneStatus(formatApiError(frame));
            return;
          }
        }
      }
      setCloneStatus(t("directoryPicker.cloneInterrupted"));
    } catch (cause) {
      if (!abort.signal.aborted) setCloneStatus(cause instanceof Error ? cause.message : String(cause));
    } finally {
      cloneAbortRef.current = null;
      setCloneId(null);
    }
  };
  const cancelClone = () => {
    if (!cloneId) return;
    setCloneStatus(t("directoryPicker.cloneCancelling"));
    const dropStream = () => {
      // Nothing was created yet (or the server cleans up on disconnect).
      setCloneStatus(t("directoryPicker.cloneCancelled", { path: cloneTarget ?? "" }));
      cloneAbortRef.current?.abort();
    };
    // Once the POST has responded, the stream stays open to report the cleanup
    // (a 404 then means the clone is already finishing and reports itself).
    // A 404 before that means the server has not registered the clone yet, so
    // drop the POST: the server cancels it on disconnect before or during git.
    void fetch("/api/projects/clone", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: cloneId }) })
      .then((response) => { if (response.status === 404 && !cloneRespondedRef.current) dropStream(); }, dropStream);
  };

  if (!portalTarget) return null;

  return createPortal(
    <div
      className="directory-picker-backdrop animate-fade-in"
      onClick={(event) => {
        if (event.target === event.currentTarget && !locked) onCancel();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 1002, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--overlay-backdrop)" }}
    >
      <div className="directory-picker-panel animate-scale-in" ref={dialogRef} role="dialog" aria-modal="true" aria-label={t("directoryPicker.selectDirectory")} tabIndex={-1} style={{ width: 520, maxWidth: "calc(100vw - 16px)", height: "min(620px, calc(100dvh - 16px))", maxHeight: "calc(100dvh - 16px)", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius-modal)", boxShadow: "var(--shadow-modal)", outline: "none" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, padding: "12px 18px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: "var(--text)", fontWeight: 700, fontSize: 15 }}>{t("directoryPicker.selectDirectory")}</div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={locked}
            title={t("directoryPicker.close")}
            aria-label={t("directoryPicker.close")}
            style={{ padding: "2px 6px", border: 0, background: "none", color: "var(--text-muted)", fontSize: 20, lineHeight: 1, cursor: locked ? "default" : "pointer", opacity: locked ? 0.5 : 1, transition: "color var(--dur-fast) var(--ease-out-warm), opacity var(--dur-fast) var(--ease-out-warm)" }}
            onMouseEnter={(e) => { if (!locked) e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            ×
          </button>
        </div>

        <form onSubmit={handlePathSubmit} style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
          <button className="directory-picker-back" type="button" onClick={() => void navigateTo(parentDirectory ?? undefined)} disabled={loading || !canNavigateUp} title={t("directoryPicker.goToParent")} aria-label={t("directoryPicker.goToParent")} style={{ width: 36, height: 36, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text-muted)", cursor: canNavigateUp ? "pointer" : "default", opacity: canNavigateUp ? 1 : 0.45, transition: "background-color var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)" }} onMouseEnter={(e) => { if (canNavigateUp && !loading) { e.currentTarget.style.background = "var(--bg-selected)"; e.currentTarget.style.color = "var(--text)"; } }} onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text-muted)"; }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m18 15-6-6-6 6" />
            </svg>
          </button>
          <label htmlFor="directory-path" style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}>
            {t("directoryPicker.directoryPath")}
          </label>
          <input
            className="directory-picker-path"
            id="directory-path"
            type="text"
            value={pathInput}
            aria-label={t("directoryPicker.pathPlaceholder") || "Directory path"}
            placeholder={t("directoryPicker.pathPlaceholder")}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setPathInput(event.target.value);
              setLoadError(null);
            }}
            style={{ minWidth: 0, flex: 1, height: 36, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 6, outline: "none", background: "var(--bg-panel)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12, transition: "border-color var(--dur-fast) var(--ease-out-warm)" }}
          />
          <button
            className="directory-picker-action"
            type="submit"
            disabled={goDisabled}
            title={remote ? t("hosts.notAvailableRemote") : t("directoryPicker.goToDirectory")}
            style={{ minWidth: 58, height: 36, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text-muted)", cursor: goDisabled ? "default" : "pointer", opacity: goDisabled ? 0.6 : 1, transition: "background-color var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm), opacity var(--dur-fast) var(--ease-out-warm)" }}
            onMouseEnter={(e) => { if (!goDisabled) { e.currentTarget.style.background = "var(--bg-selected)"; e.currentTarget.style.color = "var(--text)"; } }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {t("directoryPicker.go")}
          </button>
        </form>

        <div className="directory-picker-list" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "8px 10px" }}>
          {remote ? (
            <div role="status" style={{ padding: 8, color: "var(--text-dim)", fontSize: 11, lineHeight: 1.6 }}>
              <div style={{ color: "var(--text-muted)", fontWeight: 600 }}>{t("hosts.notAvailableRemote")}</div>
              <div>{t("hosts.remotePathHint", { host: host.name })}</div>
            </div>
          ) : loading ? (
            <div style={{ display: "grid", gap: 6, padding: 8 }} aria-busy="true" aria-label={t("directoryPicker.loadingDirectories")}>
              {Array.from({ length: 7 }).map((_, i) => (
                <div
                  key={i}
                  className="skeleton"
                  style={{ height: 22, width: `${55 + ((i * 37) % 40)}%` }}
                />
              ))}
            </div>
          ) : drives !== null ? (
            drives.length > 0 ? drives.map((entry) => (
              <button key={entry.path} className="directory-picker-entry" type="button" onClick={() => void navigateTo(entry.path)} title={entry.path} style={{ width: "100%", minHeight: 30, display: "flex", alignItems: "center", gap: 7, padding: "5px 8px", border: 0, borderRadius: 5, background: "none", color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                <DriveIcon />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</span>
              </button>
            )) : <div style={{ padding: 8, color: "var(--text-dim)", fontSize: 11 }}>{t("directoryPicker.noDrives")}</div>
          ) : directories.length > 0 ? (
            directories.map((entry) => (
              <button
                key={entry.path}
                className="directory-picker-entry"
                type="button"
                onClick={() => void navigateTo(entry.path)}
                title={entry.path}
                style={{ width: "100%", minHeight: 30, display: "flex", alignItems: "center", gap: 7, padding: "5px 8px", border: 0, borderRadius: 5, background: "none", color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontFamily: "var(--font-mono)", fontSize: 11, transition: "background-color var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
              >
                <FolderIcon />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</span>
              </button>
            ))
          ) : (
            <div style={{ padding: 8, color: "var(--text-dim)", fontSize: 11 }}>{t("directoryPicker.noSubdirectories")}</div>
          )}
          {(loadError || error) && (
            <div role="alert" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px", color: "var(--status-error)", fontSize: 11 }}>
              <span>{loadError ?? error}</span>
              {!remote && <button className="load-retry-button" type="button" onClick={() => void navigateTo(currentPath || undefined)} style={{ minHeight: 32, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>{t("directoryPicker.retry")}</button>}
            </div>
          )}
        </div>

        {/* Shrinks and scrolls on short viewports (phone landscape) so the footer — incl. Cancel clone — stays reachable. */}
        <div style={{ flexShrink: 1, minHeight: 0, overflowY: "auto", padding: "10px 18px", borderTop: "1px solid var(--border)" }}>
          <input className="directory-picker-clone-url" type="text" value={cloneUrl} disabled={cloning || remote} title={remote ? t("hosts.notAvailableRemote") : undefined} onChange={(event) => { setCloneUrl(event.target.value); setCloneStatus(null); }} placeholder={t("directoryPicker.cloneUrlPlaceholder")} aria-label={t("directoryPicker.cloneUrlLabel")} autoComplete="off" spellCheck={false} style={{ width: "100%", height: 30, boxSizing: "border-box", marginBottom: 7, padding: "0 8px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 11 }} />
          {cloneUrl.trim() && !cloning && !cloneStatus && (
            <div style={{ marginBottom: 7, color: cloneTarget ? "var(--text-muted)" : "var(--status-error)", fontSize: 11, overflowWrap: "anywhere" }}>
              {cloneTarget ? t("directoryPicker.cloneInto", { path: cloneTarget }) : t("errors.invalid_git_url")}
            </div>
          )}
          {cloneStatus && <div role="status" style={{ marginBottom: 7, color: "var(--text-muted)", fontSize: 11, overflowWrap: "anywhere" }}>{cloneStatus}</div>}
          {cloneLog && (
            <pre ref={cloneLogRef} aria-label={t("directoryPicker.cloneOutputLabel")} tabIndex={0} style={{ maxHeight: 140, overflow: "auto", margin: "0 0 7px", padding: "6px 8px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {cloneLog.replace(/\r/g, "")}
            </pre>
          )}
          <input className="directory-picker-profile" value={profile} onChange={(event) => setProfile(event.target.value)} placeholder={t("directoryPicker.profilePlaceholder")} aria-label={t("directoryPicker.profileLabel")} style={{ width: "100%", height: 30, boxSizing: "border-box", marginBottom: 7, padding: "0 8px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 11 }} />
          <label className="directory-picker-launch" style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 7, color: "var(--text-muted)", fontSize: 11 }}><input type="checkbox" checked={advisor} onChange={(event) => setAdvisor(event.target.checked)} />{t("projectLaunchConfig.advisorLabel")}</label>
          <textarea className="directory-picker-extra-args" value={extraArgs} onChange={(event) => setExtraArgs(event.target.value)} placeholder={t("directoryPicker.extraArgsPlaceholder")} aria-label={t("directoryPicker.extraArgsLabel")} rows={2} style={{ width: "100%", boxSizing: "border-box", resize: "vertical", padding: "6px 8px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 11 }} />
        </div>
        <div className="directory-picker-footer" style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, flexShrink: 0, padding: "10px 18px", borderTop: "1px solid var(--border)" }}>
          {cloning ? (
            <button className="directory-picker-action" type="button" autoFocus onClick={cancelClone} style={{ padding: "6px 14px", border: "1px solid var(--border)", borderRadius: 6, background: "none", color: "var(--status-error)", cursor: "pointer", fontSize: 13 }}>{t("directoryPicker.cancelClone")}</button>
          ) : (
            <button className="directory-picker-action" type="button" onClick={onCancel} disabled={busy} style={{ padding: "6px 14px", border: "1px solid var(--border)", borderRadius: 6, background: "none", color: "var(--text-muted)", cursor: busy ? "default" : "pointer", fontSize: 13 }}>{t("directoryPicker.cancel")}</button>
          )}
          <button className="directory-picker-action" type="button" onClick={() => void submitSelection()} disabled={!canSelect} title={hasUncommittedPath ? t("directoryPicker.openPathBeforeSelecting") : cloneTarget ? t("directoryPicker.cloneInto", { path: cloneTarget }) : t("directoryPicker.selectCurrentDirectory")} style={{ padding: "6px 16px", border: 0, borderRadius: 6, background: "var(--accent-strong)", color: "var(--on-accent)", fontSize: 13, fontWeight: 600, opacity: canSelect ? 1 : 0.6, cursor: canSelect ? "pointer" : "default" }}>
            {busy ? t("directoryPicker.checking") : cloning ? t("directoryPicker.cloning") : cloneUrl.trim() ? t("directoryPicker.cloneHere") : t("directoryPicker.selectThisFolder")}
          </button>
        </div>
      </div>
    </div>,
    portalTarget,
  );
}
