"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { copyText } from "@/lib/clipboard";
import { Dialog, DialogContent, DialogTitle, DialogClose, Tooltip } from "./ui/primitives";
import { toast } from "./ui/toast";
import type { ArchivedSessionInfo } from "@/lib/types";
import {
  Archive,
  Calendar,
  Check,
  Clock,
  Copy,
  Folder,
  HardDrive,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  Search,
  X,
  AlertCircle,
  Hash,
} from "lucide-react";

export interface ArchiveBrowserProps {
  open: boolean;
  onClose: () => void;
  onRestored: (sessionId: string) => void;
}

export function formatArchiveSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatArchiveRelativeTime(value: string, now: number): string | null {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;

  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

export function formatArchiveDateTime(isoString: string, locale: string): string {
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return isoString;
    return d.toLocaleString(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return isoString;
  }
}

/** Status badge color & text resolver */
function StatusBadge({ status }: { status?: ArchivedSessionInfo["status"] }) {
  if (!status) return null;

  const colorMap: Record<string, { bg: string; color: string; border: string }> = {
    complete: {
      bg: "color-mix(in srgb, var(--status-success) 12%, transparent)",
      color: "var(--status-success)",
      border: "color-mix(in srgb, var(--status-success) 28%, transparent)",
    },
    interrupted: {
      bg: "color-mix(in srgb, var(--status-warning) 12%, transparent)",
      color: "var(--status-warning)",
      border: "color-mix(in srgb, var(--status-warning) 28%, transparent)",
    },
    aborted: {
      bg: "color-mix(in srgb, var(--status-warning) 12%, transparent)",
      color: "var(--status-warning)",
      border: "color-mix(in srgb, var(--status-warning) 28%, transparent)",
    },
    error: {
      bg: "color-mix(in srgb, var(--status-error) 12%, transparent)",
      color: "var(--status-error)",
      border: "color-mix(in srgb, var(--status-error) 28%, transparent)",
    },
    pending: {
      bg: "var(--bg-subtle)",
      color: "var(--text-dim)",
      border: "var(--border)",
    },
    unknown: {
      bg: "var(--bg-subtle)",
      color: "var(--text-dim)",
      border: "var(--border)",
    },
  };

  const current = colorMap[status] ?? colorMap.unknown;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "1px 6px",
        borderRadius: "var(--radius-control)",
        fontSize: 10,
        fontWeight: 600,
        fontFamily: "var(--font-mono)",
        textTransform: "uppercase",
        letterSpacing: "0.03em",
        background: current.bg,
        color: current.color,
        border: `1px solid ${current.border}`,
        lineHeight: 1.3,
      }}
    >
      {status}
    </span>
  );
}

/** Detail item metadata block */
export function MetadataRow({
  icon: Icon,
  label,
  value,
  mono = false,
  action,
}: {
  icon: React.ComponentType<{ size?: number; className?: string; style?: CSSProperties; "aria-hidden"?: boolean | "true" | "false" }>;
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "8px 10px",
        borderRadius: "var(--radius-control)",
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 26,
          height: 26,
          borderRadius: 6,
          background: "var(--bg-subtle)",
          color: "var(--text-dim)",
          flexShrink: 0,
          marginTop: 1,
        }}
      >
        <Icon size={14} aria-hidden="true" />
      </div>
      <div style={{ minWidth: 0, flex: 1, overflow: "hidden" }}>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 2 }}>{label}</div>
        <div
          style={{
            fontSize: 12,
            color: "var(--text)",
            fontFamily: mono ? "var(--font-mono)" : "inherit",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            wordBreak: "break-all",
          }}
          title={typeof value === "string" ? value : undefined}
        >
          {value}
        </div>
      </div>
      {action && <div style={{ flexShrink: 0, marginLeft: 4 }}>{action}</div>}
    </div>
  );
}

export function ArchiveBrowser({ open, onClose, onRestored }: ArchiveBrowserProps) {
  const { t, locale } = useI18n();
  const [archives, setArchives] = useState<ArchivedSessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [restoringKey, setRestoringKey] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState(false);
  const [relativeTimeNow] = useState(() => Date.now());
  const searchInputRef = useRef<HTMLInputElement>(null);

  const fetchArchives = useCallback(async (isManualRefresh = false) => {
    if (isManualRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/sessions/archive");
      if (!res.ok) {
        const payload = await res.json().catch(() => ({})) as { error?: string; code?: string };
        throw new Error(formatApiError(payload, `errors.http${res.status}`));
      }
      const data = (await res.json()) as { archives?: ArchivedSessionInfo[] };
      const items = Array.isArray(data.archives) ? data.archives : [];
      setArchives(items);
      setSelectedKey((prevKey) => {
        if (prevKey && items.some((item) => item.key === prevKey)) return prevKey;
        return items.length > 0 ? items[0].key : null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void fetchArchives(false);
    }
  }, [open, fetchArchives]);

  // Focus search on open
  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // Filtered archives
  const filteredArchives = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return archives;
    return archives.filter((archive) => {
      const name = (archive.name ?? "").toLowerCase();
      const id = (archive.id ?? "").toLowerCase();
      const cwd = (archive.cwd ?? "").toLowerCase();
      const firstMessage = (archive.firstMessage ?? "").toLowerCase();
      const status = (archive.status ?? "").toLowerCase();
      return (
        name.includes(query) ||
        id.includes(query) ||
        cwd.includes(query) ||
        firstMessage.includes(query) ||
        status.includes(query)
      );
    });
  }, [archives, searchQuery]);

  // Update selectedKey if current selection is filtered out
  useEffect(() => {
    if (filteredArchives.length > 0) {
      if (!selectedKey || !filteredArchives.some((item) => item.key === selectedKey)) {
        setSelectedKey(filteredArchives[0].key);
      }
    } else {
      setSelectedKey(null);
    }
  }, [filteredArchives, selectedKey]);

  const selectedArchive = useMemo(() => {
    if (!selectedKey) return null;
    return archives.find((a) => a.key === selectedKey) ?? null;
  }, [archives, selectedKey]);

  const handleCopyId = useCallback(async (id: string) => {
    try {
      await copyText(id);
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 2000);
      toast.success(t("archiveBrowser.copied"));
    } catch {
      toast.error(t("appShell.commandCopyFailed"));
    }
  }, [t]);

  const handleRestore = useCallback(
    async (archive: ArchivedSessionInfo) => {
      if (restoringKey) return;
      setRestoringKey(archive.key);

      try {
        const res = await fetch("/api/sessions/archive", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ key: archive.key }),
        });

        if (!res.ok) {
          const payload = await res.json().catch(() => ({})) as { error?: string; code?: string };
          throw new Error(formatApiError(payload, `errors.http${res.status}`));
        }

        const data = (await res.json()) as { ok?: boolean; sessionId?: string };
        const restoredId = data.sessionId || archive.id;
        toast.success(t("archiveBrowser.restoreSuccess", {
          name: archive.name || archive.firstMessage.slice(0, 30) || archive.id.slice(0, 10),
        }));
        onRestored(restoredId);
        onClose();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(t("archiveBrowser.restoreFailed", { detail: message }));
      } finally {
        setRestoringKey(null);
      }
    },
    [restoringKey, t, onRestored, onClose],
  );

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        ariaLabel={t("archiveBrowser.title")}
        style={{
          width: "min(95vw, 920px)",
          maxWidth: "min(95vw, 920px)",
          height: "min(90dvh, 680px)",
          display: "flex",
          flexDirection: "column",
          padding: 0,
          overflow: "hidden",
        }}
      >
        {/* Modal Header */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            padding: "16px 20px 14px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 32,
                  height: 32,
                  borderRadius: "var(--radius-control)",
                  background: "var(--bg-subtle)",
                  color: "var(--accent)",
                }}
              >
                <Archive size={17} strokeWidth={2} aria-hidden="true" />
              </div>
              <div>
                <DialogTitle style={{ margin: 0, fontSize: 17, lineHeight: 1.2 }}>
                  {t("archiveBrowser.title")}
                </DialogTitle>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                  {t("archiveBrowser.description")}
                </div>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Tooltip content={t("archiveBrowser.refresh")} side="bottom">
                <button
                  type="button"
                  onClick={() => void fetchArchives(true)}
                  disabled={loading || refreshing}
                  aria-label={t("archiveBrowser.refresh")}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 30,
                    height: 30,
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-control)",
                    background: "var(--bg-panel)",
                    color: "var(--text)",
                    cursor: loading || refreshing ? "wait" : "pointer",
                    transition: "background var(--dur-fast), border-color var(--dur-fast)",
                  }}
                >
                  <RefreshCw
                    size={14}
                    strokeWidth={2}
                    className={refreshing ? "icon-spin" : undefined}
                    aria-hidden="true"
                  />
                </button>
              </Tooltip>

              <DialogClose
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 30,
                  height: 30,
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-control)",
                  background: "var(--bg-panel)",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 16,
                  lineHeight: 1,
                  padding: 0,
                }}
                aria-label={t("archiveBrowser.close")}
              >
                <X size={15} strokeWidth={2} aria-hidden="true" />
              </DialogClose>
            </div>
          </div>

          {/* Search Bar */}
          <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
            <Search
              size={14}
              strokeWidth={2}
              style={{
                position: "absolute",
                left: 10,
                color: "var(--text-dim)",
                pointerEvents: "none",
              }}
              aria-hidden="true"
            />
            <input
              className="archive-search-input"
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("archiveBrowser.searchPlaceholder")}
              aria-label={t("archiveBrowser.searchPlaceholder")}
              style={{
                width: "100%",
                height: 34,
                padding: "0 32px 0 32px",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-control)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                fontSize: 12.5,
                outline: "none",
                transition: "border-color var(--dur-fast)",
              }}
            />
            {searchQuery && (
              <button
                className="archive-search-clear"
                type="button"
                onClick={() => setSearchQuery("")}
                aria-label={t("fileExplorer.clearSearch")}
                style={{
                  position: "absolute",
                  right: 8,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 20,
                  height: 20,
                  border: "none",
                  borderRadius: 4,
                  background: "transparent",
                  color: "var(--text-dim)",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                <X size={12} strokeWidth={2} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        {/* Content Area */}
        <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
          {loading && archives.length === 0 ? (
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
                color: "var(--text-dim)",
                fontSize: 13,
              }}
            >
              <RefreshCw size={22} strokeWidth={2} className="icon-spin" aria-hidden="true" />
              <span>{t("archiveBrowser.loading")}</span>
            </div>
          ) : error && archives.length === 0 ? (
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
                padding: 24,
                textAlign: "center",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 40,
                  height: 40,
                  borderRadius: "var(--radius-card)",
                  background: "color-mix(in srgb, var(--status-error) 12%, transparent)",
                  color: "var(--status-error)",
                }}
              >
                <AlertCircle size={20} strokeWidth={2} aria-hidden="true" />
              </div>
              <div style={{ maxWidth: 420 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
                  {t("archiveBrowser.loadFailed", { detail: "" }).replace(/:\s*$/, "")}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", wordBreak: "break-word" }}>
                  {error}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void fetchArchives(false)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 14px",
                  borderRadius: "var(--radius-control)",
                  background: "var(--accent-strong)",
                  color: "var(--on-accent)",
                  border: "none",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                <RefreshCw size={13} strokeWidth={2} aria-hidden="true" />
                {t("archiveBrowser.retry")}
              </button>
            </div>
          ) : archives.length === 0 ? (
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
                padding: 24,
                textAlign: "center",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 44,
                  height: 44,
                  borderRadius: "var(--radius-card)",
                  background: "var(--bg-subtle)",
                  color: "var(--text-dim)",
                }}
              >
                <Archive size={22} strokeWidth={1.8} aria-hidden="true" />
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                {t("archiveBrowser.noArchives")}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", maxWidth: 320 }}>
                {t("archiveBrowser.noArchivesDescription")}
              </div>
            </div>
          ) : (
            <>
              {/* Left Pane: Archive List */}
              <div
                style={{
                  width: "min(340px, 40%)",
                  flexShrink: 0,
                  borderRight: "1px solid var(--border)",
                  background: "var(--bg-panel)",
                  display: "flex",
                  flexDirection: "column",
                  minHeight: 0,
                }}
              >
                <div
                  style={{
                    padding: "8px 12px",
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--text-dim)",
                    borderBottom: "1px solid var(--border)",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <span>{t("archiveBrowser.count", { count: filteredArchives.length })}</span>
                </div>

                <div
                  style={{
                    flex: 1,
                    overflowY: "auto",
                    padding: "6px 8px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  {filteredArchives.length === 0 ? (
                    <div
                      style={{
                        padding: "32px 16px",
                        textAlign: "center",
                        color: "var(--text-dim)",
                        fontSize: 12,
                      }}
                    >
                      <div style={{ fontWeight: 600, marginBottom: 4, color: "var(--text-muted)" }}>
                        {t("archiveBrowser.noMatches")}
                      </div>
                      <div>{t("archiveBrowser.noMatchesDescription")}</div>
                    </div>
                  ) : (
                    filteredArchives.map((archive) => {
                      const isSelected = archive.key === selectedKey;
                      const title =
                        archive.name ||
                        archive.firstMessage.trim().slice(0, 48) ||
                        archive.id.slice(0, 12);
                      const relativeTime = formatArchiveRelativeTime(
                        archive.archivedAt || archive.created,
                        relativeTimeNow,
                      );

                      return (
                        <button
                          key={archive.key}
                          type="button"
                          onClick={() => setSelectedKey(archive.key)}
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 4,
                            padding: "9px 10px",
                            borderRadius: "var(--radius-control)",
                            border: isSelected
                              ? "1px solid var(--accent)"
                              : "1px solid transparent",
                            background: isSelected ? "var(--bg-selected)" : "transparent",
                            color: "var(--text)",
                            textAlign: "left",
                            cursor: "pointer",
                            transition:
                              "background var(--dur-fast), border-color var(--dur-fast)",
                            outline: "none",
                          }}
                          className="sidebar-session-row"
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: 6,
                              minWidth: 0,
                            }}
                          >
                            <span
                              style={{
                                fontSize: 12.5,
                                fontWeight: isSelected ? 600 : 500,
                                color: isSelected ? "var(--accent)" : "var(--text)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                flex: 1,
                              }}
                            >
                              {title}
                            </span>
                            {relativeTime && (
                              <span
                                style={{
                                  fontSize: 10,
                                  color: "var(--text-dim)",
                                  flexShrink: 0,
                                  fontVariantNumeric: "tabular-nums",
                                }}
                              >
                                {relativeTime}
                              </span>
                            )}
                          </div>

                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              fontSize: 11,
                              color: "var(--text-dim)",
                              overflow: "hidden",
                            }}
                          >
                            <span
                              style={{
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                flex: 1,
                              }}
                              title={archive.cwd}
                            >
                              {archive.cwd}
                            </span>
                          </div>

                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              fontSize: 10.5,
                              color: "var(--text-muted)",
                              marginTop: 2,
                            }}
                          >
                            <span>{t("chatWindow.messageCount.other", { count: archive.messageCount })}</span>
                            <span>•</span>
                            <span>{formatArchiveSize(archive.size)}</span>
                            {archive.status && (
                              <div style={{ marginLeft: "auto" }}>
                                <StatusBadge status={archive.status} />
                              </div>
                            )}
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Right Pane: Selected Archive Details & Actions */}
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  minHeight: 0,
                  background: "var(--bg)",
                  overflowY: "auto",
                }}
              >
                {selectedArchive ? (
                  <div
                    style={{
                      padding: "20px 24px",
                      display: "flex",
                      flexDirection: "column",
                      gap: 18,
                    }}
                  >
                    {/* Detail Header with Title and Primary Restore Action */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        justifyContent: "space-between",
                        gap: 16,
                        flexWrap: "wrap",
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                          <h3
                            style={{
                              margin: 0,
                              fontSize: 16,
                              fontWeight: 600,
                              color: "var(--text)",
                              wordBreak: "break-word",
                            }}
                          >
                            {selectedArchive.name ||
                              selectedArchive.firstMessage.trim().slice(0, 60) ||
                              selectedArchive.id}
                          </h3>
                          {selectedArchive.status && (
                            <StatusBadge status={selectedArchive.status} />
                          )}
                        </div>
                        <div
                          style={{
                            fontSize: 11.5,
                            color: "var(--text-muted)",
                            fontFamily: "var(--font-mono)",
                            wordBreak: "break-all",
                          }}
                        >
                          {selectedArchive.id}
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => void handleRestore(selectedArchive)}
                        disabled={restoringKey !== null}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 7,
                          padding: "8px 16px",
                          borderRadius: "var(--radius-control)",
                          background: "var(--accent-strong)",
                          color: "var(--on-accent)",
                          border: "none",
                          fontSize: 13,
                          fontWeight: 600,
                          cursor: restoringKey !== null ? "wait" : "pointer",
                          opacity: restoringKey !== null ? 0.7 : 1,
                          boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
                          transition: "opacity var(--dur-fast), transform var(--dur-fast)",
                          flexShrink: 0,
                        }}
                      >
                        <RotateCcw
                          size={14}
                          strokeWidth={2.2}
                          className={restoringKey === selectedArchive.key ? "icon-spin" : undefined}
                          aria-hidden="true"
                        />
                        <span>
                          {restoringKey === selectedArchive.key
                            ? t("archiveBrowser.restoring")
                            : t("archiveBrowser.restore")}
                        </span>
                      </button>
                    </div>

                    {/* Notice card */}
                    <div
                      style={{
                        padding: "10px 12px",
                        borderRadius: "var(--radius-control)",
                        background: "var(--bg-panel)",
                        border: "1px solid var(--border)",
                        fontSize: 12,
                        color: "var(--text-muted)",
                        lineHeight: 1.45,
                      }}
                    >
                      {t("archiveBrowser.restoreNotice")}
                    </div>

                    {/* Metadata Grid */}
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                        gap: 10,
                      }}
                    >
                      <MetadataRow
                        icon={Folder}
                        label={t("archiveBrowser.directory")}
                        value={selectedArchive.cwd}
                        mono
                      />
                      <MetadataRow
                        icon={Hash}
                        label={t("archiveBrowser.sessionId")}
                        value={selectedArchive.id}
                        mono
                        action={
                          <Tooltip content={t("archiveBrowser.copyId")} side="left">
                            <button
                              type="button"
                              onClick={() => void handleCopyId(selectedArchive.id)}
                              aria-label={t("archiveBrowser.copyId")}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                width: 22,
                                height: 22,
                                border: "none",
                                borderRadius: 4,
                                background: "transparent",
                                color: "var(--text-dim)",
                                cursor: "pointer",
                                padding: 0,
                              }}
                            >
                              {copiedId ? (
                                <Check size={13} style={{ color: "var(--status-success)" }} aria-hidden="true" />
                              ) : (
                                <Copy size={13} aria-hidden="true" />
                              )}
                            </button>
                          </Tooltip>
                        }
                      />
                      <MetadataRow
                        icon={Calendar}
                        label={t("archiveBrowser.created")}
                        value={formatArchiveDateTime(selectedArchive.created, locale)}
                      />
                      <MetadataRow
                        icon={Clock}
                        label={t("archiveBrowser.archivedAt")}
                        value={formatArchiveDateTime(selectedArchive.archivedAt, locale)}
                      />
                      <MetadataRow
                        icon={MessageSquare}
                        label={t("archiveBrowser.messages")}
                        value={`${selectedArchive.messageCount}`}
                      />
                      <MetadataRow
                        icon={HardDrive}
                        label={t("archiveBrowser.size")}
                        value={formatArchiveSize(selectedArchive.size)}
                      />
                    </div>

                    {/* Initial Prompt Preview */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: "var(--text-dim)",
                          textTransform: "uppercase",
                          letterSpacing: "0.04em",
                        }}
                      >
                        {t("archiveBrowser.firstMessage")}
                      </div>
                      <div
                        style={{
                          padding: "12px 14px",
                          borderRadius: "var(--radius-card)",
                          background: "var(--bg-panel)",
                          border: "1px solid var(--border)",
                          fontSize: 12.5,
                          lineHeight: 1.55,
                          color: selectedArchive.firstMessage.trim()
                            ? "var(--text)"
                            : "var(--text-dim)",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          maxHeight: 200,
                          overflowY: "auto",
                          fontStyle: selectedArchive.firstMessage.trim() ? "normal" : "italic",
                        }}
                      >
                        {selectedArchive.firstMessage.trim() || t("archiveBrowser.noFirstMessage")}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div
                    style={{
                      flex: 1,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "var(--text-dim)",
                      fontSize: 13,
                      padding: 24,
                      textAlign: "center",
                    }}
                  >
                    <Archive size={28} strokeWidth={1.5} style={{ marginBottom: 10, opacity: 0.6 }} aria-hidden="true" />
                    <span>{t("archiveBrowser.selectPrompt")}</span>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
