"use client";

import { memo, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Ban, Check, ChevronDown, CircleAlert, Copy, Loader2, MessageCircleQuestion, Reply, Square, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { btwTurns, latestBtwAnswer, latestBtwTurn, type BtwRecord, type BtwStatus, type BtwTurn } from "@/lib/btw";
import { copyText } from "@/lib/clipboard";
import { SafeMarkdownBody } from "./MessageView";
import { toast } from "./ui/toast";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "./ui/primitives";

const STATUS_KEYS: Record<BtwStatus, string> = {
  running: "btw.statusRunning",
  complete: "btw.statusComplete",
  cancelled: "btw.statusCancelled",
  error: "btw.statusError",
  interrupted: "btw.statusInterrupted",
};

const actionStyle = {
  display: "inline-flex", alignItems: "center", gap: 5,
  padding: "4px 10px",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 12,
  fontFamily: "inherit",
} as const;

function BtwStatusLabel({ status }: { status: BtwStatus }) {
  const { t } = useI18n();
  const Icon = status === "running" ? Loader2 : status === "complete" ? Check : status === "error" ? CircleAlert : Ban;
  return (
    <span className="inline-flex shrink-0 items-center gap-1" style={{ color: status === "error" ? "var(--status-error)" : undefined }}>
      <Icon size={12} strokeWidth={2} aria-hidden className={status === "running" ? "animate-spin" : undefined} />
      {t(STATUS_KEYS[status] ?? "btw.statusError")}
    </span>
  );
}

/** Markdown links to workspace files open in the file viewer, as in chat. */
interface FileLinkProps {
  cwd?: string;
  sourceSessionId?: string | null;
  onOpenFile?: (filePath: string) => void;
}

/** One question/answer exchange. `live` marks the turn whose answer streams:
 * it is a polite live region, busy until the answer settles so screen readers
 * read it once instead of per token, then hear how it ended. Memoized: only
 * the streaming turn changes per delta, so earlier answers are not re-parsed. */
const BtwTurnView = memo(function BtwTurnView({ turn, live = false, cwd, sourceSessionId, onOpenFile }: FileLinkProps & { turn: BtwTurn; live?: boolean }) {
  const { t } = useI18n();
  const running = turn.status === "running";
  return (
    <div className="grid min-w-0 gap-1">
      <p className="m-0 text-xs font-medium text-text-muted" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{turn.question}</p>
      <div aria-live={live ? "polite" : undefined} aria-busy={live && running ? true : undefined} className="min-w-0 text-sm text-text">
        {turn.answer
          ? <SafeMarkdownBody isStreaming={running} cwd={cwd} onOpenFile={onOpenFile} sourceSessionId={sourceSessionId}>{turn.answer}</SafeMarkdownBody>
          : running ? <span className="text-xs text-text-dim">{t("btw.waiting")}</span> : null}
        {turn.error && <p className="m-0 text-xs" style={{ color: "var(--status-error)", overflowWrap: "anywhere" }}>{turn.error}</p>}
        {live && !running && turn.status !== "complete" && <span className="sr-only">{t(STATUS_KEYS[turn.status])}</span>}
      </div>
    </div>
  );
});

function CopyAnswerButton({ answer }: { answer: string }) {
  const { t } = useI18n();
  if (!answer) return null;
  return (
    <button
      type="button"
      className="ui-focus-ring"
      style={actionStyle}
      onClick={() => void copyText(answer).then(() => toast.success(t("btw.copied"))).catch(() => toast.error(t("btw.copyFailed")))}
    >
      <Copy size={12} strokeWidth={2} aria-hidden />
      {t("btw.copy")}
    </button>
  );
}

export interface BtwPanelProps extends FileLinkProps {
  record: BtwRecord;
  onCancel: () => void;
  /** Resolves false when omp refused the follow-up (already toasted). */
  onFollowUp: (question: string) => Promise<boolean>;
  onClose: () => void;
}

/** Composer-attached side-question panel: the active topic's turns with the
 * latest answer streaming, plus cancel / copy / follow-up actions. Callers key
 * it by record id so each new topic starts expanded with an empty follow-up. */
export function BtwPanel({ record, onCancel, onFollowUp, onClose, cwd, sourceSessionId, onOpenFile }: BtwPanelProps) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const turns = btwTurns(record);
  const latest = latestBtwTurn(record);
  const running = latest.status === "running";
  // Follow the streaming tail like the chat does, until the user scrolls up.
  const turnsRef = useRef<HTMLDivElement>(null);
  const followTailRef = useRef(true);
  useLayoutEffect(() => {
    const el = turnsRef.current;
    if (el && followTailRef.current) el.scrollTop = el.scrollHeight;
  }, [latest.answer, turns.length, collapsed]);

  // Cancel and the follow-up form swap places when a turn starts or settles.
  // Keyboard focus in that row would drop to <body> with the unmounted
  // control; hand it to the one that replaced it instead.
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusInActionsRef = useRef(false);
  useEffect(() => {
    if (!focusInActionsRef.current || document.activeElement !== document.body) return;
    (running ? cancelRef.current : inputRef.current)?.focus();
  }, [running]);

  const submitFollowUp = async (event: FormEvent) => {
    event.preventDefault();
    const question = draft.trim();
    if (!question || running || sending) return;
    setSending(true);
    followTailRef.current = true;
    if (await onFollowUp(question)) setDraft("");
    setSending(false);
  };

  return (
    <section
      aria-label={t("btw.panelTitle")}
      className="overflow-hidden border border-border bg-bg-subtle"
      style={{ borderRadius: "var(--radius-card)" }}
    >
      <div className={`flex items-center ${collapsed ? "" : "border-b border-border"}`}>
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
          title={collapsed ? t("chatWindow.expandPanel") : t("chatWindow.collapsePanel")}
          className="ui-focus-ring flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs text-text-muted"
          style={{ background: "none", border: "none", fontFamily: "inherit" }}
        >
          <MessageCircleQuestion size={14} strokeWidth={1.8} aria-hidden />
          <strong className="shrink-0 font-medium text-text">{t("btw.panelTitle")}</strong>
          <span className="min-w-0 truncate">{record.question}</span>
          <span className="ml-auto inline-flex shrink-0"><BtwStatusLabel status={latest.status} /></span>
          <ChevronDown
            size={14}
            strokeWidth={1.8}
            aria-hidden
            style={{
              flexShrink: 0,
              color: "var(--text-dim)",
              transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
              transition: "transform var(--dur-med) var(--ease-out-warm)",
            }}
          />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("btw.close")}
          title={t("btw.close")}
          className="ui-focus-ring mr-1.5 inline-flex shrink-0 cursor-pointer p-1 text-text-dim"
          style={{ background: "none", border: "none", borderRadius: "var(--radius-control)" }}
        >
          <X size={14} strokeWidth={1.8} aria-hidden />
        </button>
      </div>
      {!collapsed && (
        <div className="grid gap-2 px-3 py-2.5 animate-slide-down">
          <div
            ref={turnsRef}
            onScroll={(event) => {
              const el = event.currentTarget;
              followTailRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
            className="grid gap-2.5"
            style={{ maxHeight: "min(36vh, 320px)", overflowY: "auto" }}
          >
            {turns.map((turn, index) => (
              <BtwTurnView key={`${turn.createdAt}:${index}`} turn={turn} live={index === turns.length - 1} cwd={cwd} onOpenFile={onOpenFile} sourceSessionId={sourceSessionId} />
            ))}
          </div>
          <div
            className="flex flex-wrap items-center gap-1.5"
            onFocus={() => { focusInActionsRef.current = true; }}
            // Focus that left for another element is the user's choice; a null
            // target (unmounted or disabled control) is not.
            onBlur={(event) => { if (event.relatedTarget) focusInActionsRef.current = event.currentTarget.contains(event.relatedTarget); }}
          >
            {running ? (
              <button ref={cancelRef} type="button" className="ui-focus-ring" style={actionStyle} onClick={onCancel}>
                <Square size={11} strokeWidth={2} aria-hidden />
                {t("btw.cancel")}
              </button>
            ) : (
              <form onSubmit={submitFollowUp} className="flex min-w-0 flex-1 items-center gap-1.5" style={{ minWidth: "min(100%, 220px)" }}>
                <input
                  ref={inputRef}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  // The Enter that commits an IME composition must not submit.
                  onKeyDown={(event) => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }}
                  aria-label={t("btw.followUpLabel")}
                  placeholder={t("btw.followUpPlaceholder")}
                  disabled={sending}
                  className="ui-focus-ring min-w-0 flex-1 text-sm text-text"
                  style={{
                    padding: "4px 8px",
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-control)",
                    fontFamily: "inherit",
                  }}
                />
                <button type="submit" className="ui-focus-ring" style={actionStyle} disabled={sending || !draft.trim()}>
                  <Reply size={12} strokeWidth={2} aria-hidden />
                  {t("btw.ask")}
                </button>
              </form>
            )}
            <CopyAnswerButton answer={latestBtwAnswer(record)} />
          </div>
        </div>
      )}
    </section>
  );
}

/** `/btw` with no question: the session's side questions, newest first, each
 * expandable to all its turns with Copy and Follow-up. */
export function BtwHistoryDialog({ open, onOpenChange, records, onFollowUp, cwd, sourceSessionId, onOpenFile }: FileLinkProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  records: BtwRecord[];
  /** Reopen this topic in the composer panel to ask a follow-up. */
  onFollowUp: (recordId: string) => void;
}) {
  const { t, locale } = useI18n();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent ariaLabel={t("btw.historyTitle")} style={{ width: "min(92vw, 640px)", maxWidth: "min(92vw, 640px)" }}>
        <div className="flex items-start justify-between gap-3">
          <DialogTitle>{t("btw.historyTitle")}</DialogTitle>
          <DialogClose
            aria-label={t("chatWindow.close")}
            className="ui-focus-ring inline-flex cursor-pointer p-1 text-text-muted"
            style={{ background: "none", border: "none", borderRadius: "var(--radius-control)" }}
          >
            <X size={16} strokeWidth={1.8} aria-hidden />
          </DialogClose>
        </div>
        {records.length === 0 ? (
          <p className="m-0 text-sm text-text-muted">{t("btw.historyEmpty")}</p>
        ) : (
          <ul className="m-0 grid list-none gap-2 p-0">
            {records.map((record) => {
              const latest = latestBtwTurn(record);
              const expanded = expandedId === record.id;
              const updated = new Date(latest.updatedAt);
              return (
                <li key={record.id} className="overflow-hidden border border-border bg-bg-subtle" style={{ borderRadius: "var(--radius-card)" }}>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setExpandedId(expanded ? null : record.id)}
                    className="ui-focus-ring flex w-full cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-left text-xs text-text-muted"
                    style={{ background: "none", border: "none", fontFamily: "inherit" }}
                  >
                    <ChevronDown
                      size={13}
                      strokeWidth={1.8}
                      aria-hidden
                      style={{
                        flexShrink: 0,
                        color: "var(--text-dim)",
                        transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
                        transition: "transform var(--dur-med) var(--ease-out-warm)",
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-text">{record.question}</span>
                    <BtwStatusLabel status={latest.status} />
                    <time dateTime={updated.toISOString()} className="shrink-0 text-text-dim">
                      {updated.toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}
                    </time>
                  </button>
                  {expanded && (
                    <div className="grid gap-2.5 border-t border-border px-3 py-2.5">
                      {btwTurns(record).map((turn, index) => (
                        <BtwTurnView key={`${turn.createdAt}:${index}`} turn={turn} cwd={cwd} onOpenFile={onOpenFile} sourceSessionId={sourceSessionId} />
                      ))}
                      <div className="flex flex-wrap items-center gap-1.5">
                        {latest.status !== "running" && (
                          <button type="button" className="ui-focus-ring" style={actionStyle} onClick={() => onFollowUp(record.id)}>
                            <Reply size={12} strokeWidth={2} aria-hidden />
                            {t("btw.followUp")}
                          </button>
                        )}
                        <CopyAnswerButton answer={latestBtwAnswer(record)} />
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
