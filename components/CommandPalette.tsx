"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Command } from "cmdk";
import { Moon, Plus, Sun, MessageSquare } from "lucide-react";
import type { SessionInfo } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { useTheme } from "@/hooks/useTheme";

type Props = {
  onSelectSession: (session: SessionInfo) => void;
  onNewSession: () => void;
  currentModel?: string | null;
};

function relativeTime(value: string, locale: string): string {
  const diff = Date.now() - new Date(value).getTime();
  const mins = Math.max(0, Math.floor(diff / 60000));
  if (mins < 1) return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(0, "minute");
  if (mins < 60) return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(-mins, "minute");
  const hours = Math.floor(mins / 60);
  if (hours < 24) return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(-hours, "hour");
  return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(-Math.floor(hours / 24), "day");
}

export const CommandPalette = memo(function CommandPalette({ onSelectSession, onNewSession, currentModel }: Props) {
  const { t, locale } = useI18n();
  const { isDark, toggleTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const loadSeqRef = useRef(0);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);

  const loadSessions = useCallback(() => {
    // Sequence-guard: open→close→reopen within one RTT must not let response
    // #1 clobber #2 or drop the spinner early.
    const seq = ++loadSeqRef.current;
    setLoading(true);
    void fetch("/api/sessions")
      .then((response) => response.ok ? response.json() as Promise<{ sessions?: SessionInfo[] }> : Promise.reject(new Error("request failed")))
      .then((data) => {
        if (seq !== loadSeqRef.current) return;
        setSessions(data.sessions ?? []);
      })
      .catch(() => {
        if (seq !== loadSeqRef.current) return;
        setSessions([]);
      })
      .finally(() => {
        if (seq !== loadSeqRef.current) return;
        setLoading(false);
      });
  }, []);


  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      } else if (event.key === "Escape" && open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  // Restore focus to the element that had it before the palette opened; the
  // portal unmount would otherwise drop focus to <body>.
  useEffect(() => {
    if (open) {
      lastFocusedElementRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    } else {
      lastFocusedElementRef.current?.focus();
      lastFocusedElementRef.current = null;
    }
  }, [open]);

  useEffect(() => { if (open) loadSessions(); }, [open, loadSessions]);
  if (!open || typeof document === "undefined") return null;

  const choose = (action: () => void) => { action(); setOpen(false); };
  return createPortal(
    <div role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setOpen(false); }} style={{ position: "fixed", inset: 0, zIndex: 2000, background: "color-mix(in srgb, var(--text) 22%, transparent)", paddingTop: "20vh" }}>
      <Command label={t("commandPalette.label")} role="dialog" aria-modal="true" shouldFilter style={{ width: "min(92vw, 560px)", maxHeight: "min(70vh, 560px)", margin: "0 auto", overflow: "hidden", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius-modal)", boxShadow: "var(--shadow-modal)", animation: "ui-scale-in var(--dur-med) var(--ease-out-warm)" }}>
        <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
          <Command.Input autoFocus placeholder={t("commandPalette.placeholder")} style={{ width: "100%", border: 0, outline: 0, background: "transparent", color: "var(--text)", fontSize: 15 }} />
        </div>
        <Command.List style={{ padding: "8px", overflowY: "auto", maxHeight: "min(55vh, 440px)" }}>
          <Command.Empty style={{ padding: 20, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>{loading ? "Loading sessions..." : t("commandPalette.empty")}</Command.Empty>
          <Command.Group heading={t("commandPalette.sessions")}>
            {sessions.map((session) => <Command.Item key={session.id} value={`${session.name ?? session.id} ${session.cwd}`} onSelect={() => choose(() => onSelectSession(session))} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 10px", borderRadius: "var(--radius-control)", color: "var(--text)", cursor: "pointer" }}><MessageSquare size={15} color="var(--accent)" /><span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.name || session.id}</span><span style={{ color: "var(--text-dim)", fontSize: 11 }}>{relativeTime(session.modified, locale)}</span></Command.Item>)}
          </Command.Group>
          <Command.Group heading={t("commandPalette.actions")}>
            <Command.Item value={t("commandPalette.newSession")} onSelect={() => choose(onNewSession)} style={{ display: "flex", gap: 10, padding: "9px 10px", borderRadius: "var(--radius-control)", color: "var(--text)", cursor: "pointer" }}><Plus size={15} color="var(--accent)" />{t("commandPalette.newSession")}</Command.Item>
            <Command.Item value={t("commandPalette.toggleTheme")} onSelect={() => choose(toggleTheme)} style={{ display: "flex", gap: 10, padding: "9px 10px", borderRadius: "var(--radius-control)", color: "var(--text)", cursor: "pointer" }}>{isDark ? <Sun size={15} color="var(--accent)" /> : <Moon size={15} color="var(--accent)" />}{t("commandPalette.toggleTheme")}</Command.Item>
          </Command.Group>
          <Command.Group heading={t("commandPalette.models")}>
            <Command.Item value={currentModel ?? t("commandPalette.currentModel")} disabled style={{ padding: "9px 10px", color: "var(--text-muted)", fontSize: 13 }}>{t("commandPalette.currentModel")}: {currentModel ?? t("commandPalette.notAvailable")}</Command.Item>
          </Command.Group>
        </Command.List>
        <div style={{ borderTop: "1px solid var(--border)", padding: "8px 14px", color: "var(--text-dim)", fontSize: 11 }}>{t("commandPalette.hints")}</div>
      </Command>
    </div>,
    document.body
  );
});
