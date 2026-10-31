"use client";

import { useEffect, useRef, useState } from "react";
import { Check, GitFork, Plus, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { comparableProjectPath } from "@/lib/comparable-path";
import { displayCwd, type WorktreeContext } from "./SessionSidebar-helpers";
import { PathLabel } from "./SessionSidebar-chrome";

/** File-panel Worktrees tab: the active Git workspace's worktrees — the only
 *  place to switch, create, and remove them. Switching moves the sidebar's
 *  effective cwd (where a new session starts); the open session is unchanged. */
export function WorktreesPanel({ ctx, remoteHost = false }: { ctx: WorktreeContext | null; remoteHost?: boolean }) {
  const { t } = useI18n();
  const [homeDir, setHomeDir] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const newInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/home").then((r) => r.json()).then((d: { home?: string }) => {
      if (d.home) setHomeDir(d.home);
    }).catch(() => {});
  }, []);

  if (!ctx) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, textAlign: "center" }}>
        <GitFork size={26} strokeWidth={1.5} aria-hidden="true" style={{ color: "var(--text-dim)" }} />
        <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 600 }}>{t("tabBar.worktrees")}</div>
        <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.6, maxWidth: 260 }}>{t(remoteHost ? "hosts.notAvailableRemote" : "sessionSidebar.gitRepoRootOnlyTitle")}</div>
      </div>
    );
  }

  const closeNew = () => {
    setNewOpen(false);
    setNewBranch("");
    setError(null);
  };

  const handleCreate = async () => {
    const branch = newBranch.trim();
    if (!branch || busy) return;
    setBusy(true);
    setError(null);
    try {
      await ctx.create(branch);
      setNewOpen(false);
      setNewBranch("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (path: string, force: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // Dirty worktree — ask the user to confirm a force removal.
      setConfirmRemove(await ctx.remove(path, force) === "dirty" ? path : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const foldedCurrent = comparableProjectPath(ctx.currentPath);

  return (
    <div style={{ height: "100%", overflowY: "auto" }}>
      {ctx.worktrees.map((wt) => {
        const isCurrent = comparableProjectPath(wt.path) === foldedCurrent;
        if (confirmRemove === wt.path) {
          return (
            <div key={wt.path} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", borderBottom: "1px solid var(--border)", background: "color-mix(in srgb, var(--accent) 6%, transparent)" }}>
              <span style={{ flex: 1, fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t("sessionSidebar.uncommittedForceRemove")}
              </span>
              <button
                onClick={() => void handleRemove(wt.path, true)}
                disabled={busy}
                style={{ padding: "3px 9px", background: "var(--accent-strong)", border: "none", borderRadius: "var(--radius-control)", color: "var(--on-accent)", fontSize: 11, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}
              >
                {t("sessionSidebar.force")}
              </button>
              <button
                onClick={() => setConfirmRemove(null)}
                style={{ padding: "3px 9px", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", color: "var(--text-muted)", fontSize: 11, cursor: "pointer", flexShrink: 0 }}
              >
                {t("sessionSidebar.cancel")}
              </button>
            </div>
          );
        }
        return (
          <div key={wt.path} style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)" }}>
            <button
              onClick={() => ctx.select(wt.path)}
              aria-pressed={isCurrent}
              title={wt.path}
              style={{
                flex: 1,
                minWidth: 0,
                display: "flex",
                alignItems: "center",
                gap: 7,
                padding: "8px 10px",
                background: "var(--bg)",
                border: "none",
                color: isCurrent ? "var(--text)" : "var(--text-muted)",
                cursor: "pointer",
                textAlign: "left",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
              }}
            >
              {isCurrent ? (
                <Check size={10} strokeWidth={2} style={{ flexShrink: 0, color: "var(--accent)" }} aria-hidden="true" />
              ) : (
                <span style={{ width: 10, flexShrink: 0 }} />
              )}
              <PathLabel text={wt.branch ?? displayCwd(wt.path, homeDir)} style={{ flex: 1 }} />
              {wt.isMain && <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>{t("sessionSidebar.mainBadge")}</span>}
            </button>
            {!wt.isMain && (
              <button
                onClick={() => void handleRemove(wt.path, false)}
                disabled={busy}
                title={t("sessionSidebar.removeWorktreeTitle", { path: wt.path })}
                aria-label={t("sessionSidebar.removeWorktreeTitle", { path: wt.path })}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 34, height: 28, padding: 0, marginRight: 4,
                  background: "none", border: "none",
                  color: "var(--text-dim)", cursor: "pointer",
                  borderRadius: "var(--radius-control)", flexShrink: 0,
                  transition: "color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 8%, transparent)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
              >
                <Trash2 size={12} strokeWidth={2} aria-hidden="true" />
              </button>
            )}
          </div>
        );
      })}

      {!newOpen ? (
        <button
          onClick={() => {
            setNewOpen(true);
            setError(null);
            setTimeout(() => newInputRef.current?.focus(), 0);
          }}
          title={t("sessionSidebar.newWorktreeTitle")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            width: "100%",
            padding: "8px 10px",
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            textAlign: "left",
            fontSize: 11,
          }}
        >
          <Plus size={12} strokeWidth={1.8} style={{ flexShrink: 0 }} aria-hidden="true" />
          <span>{t("sessionSidebar.newWorktree")}</span>
        </button>
      ) : (
        <div style={{ padding: "6px 8px" }}>
          <input
            ref={newInputRef}
            value={newBranch}
            onChange={(e) => {
              setNewBranch(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleCreate();
              }
              if (e.key === "Escape") closeNew();
            }}
            placeholder={t("sessionSidebar.branchNamePlaceholder")}
            aria-label={t("sessionSidebar.newWorktreeTitle")}
            style={{
              width: "100%",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              padding: "5px 8px",
              border: "1px solid var(--accent)",
              borderRadius: "var(--radius-control)",
              outline: "none",
              background: "var(--bg)",
              color: "var(--text)",
              boxSizing: "border-box",
            }}
          />
          <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
            <button
              onClick={() => void handleCreate()}
              disabled={busy || !newBranch.trim()}
              style={{
                flex: 1,
                padding: "4px 0",
                background: "var(--accent-strong)",
                border: "none",
                borderRadius: "var(--radius-control)",
                color: "var(--on-accent)",
                fontSize: 11,
                fontWeight: 600,
                cursor: busy || !newBranch.trim() ? "not-allowed" : "pointer",
                opacity: busy || !newBranch.trim() ? 0.65 : 1,
              }}
            >
              {busy ? t("sessionSidebar.creating") : t("sessionSidebar.create")}
            </button>
            <button
              onClick={closeNew}
              style={{
                flex: 1,
                padding: "4px 0",
                background: "var(--bg-hover)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-control)",
                color: "var(--text-muted)",
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              {t("sessionSidebar.cancel")}
            </button>
          </div>
        </div>
      )}
      {error && (
        <div role="alert" style={{
          padding: "5px 10px 8px",
          color: "var(--accent)",
          fontSize: 11,
          lineHeight: 1.35,
          overflowWrap: "anywhere",
        }}>
          {error}
        </div>
      )}
    </div>
  );
}
