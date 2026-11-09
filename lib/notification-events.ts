import { isRecord } from "./type-guards";

/**
 * Notification events shared by the server (detection, routing, push) and the
 * browser (in-app toasts, in-page system notifications, settings).
 */

export const NOTIFICATION_TYPES = ["completed", "input", "error", "modelSwitch"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** One question of an `ask` dialog, reduced to what a notification can answer. */
export interface NotificationDialogQuestion {
  id: string;
  question: string;
  /** Option labels (the web dialog sends labels back as `selectedOptions`). */
  options?: string[];
  multi?: boolean;
  /** The web dialog always offers an "Other" free-text field unless omp forbids it. */
  allowCustom?: boolean;
}

/**
 * The blocking extension dialog behind an `input` notification. Carried in the
 * SSE frame, the history entry and the push body so the native app can render
 * Yes/No/option buttons or a reply field without an open chat tab.
 */
export interface NotificationDialog {
  requestId: string;
  method: "select" | "confirm" | "input" | "editor" | "ask";
  title?: string;
  message?: string;
  options?: string[];
  questions?: NotificationDialogQuestion[];
  placeholder?: string;
  /** Wall-clock expiry (ms), present when omp set a timeout. */
  expiresAt?: number;
}

export interface NotificationEvent {
  /** `test` is only sent by the settings "Send test notification" button. */
  type: NotificationType | "test";
  sessionId: string;
  sessionName: string | null;
  /** Question, error text, or model-switch reason. */
  detail?: string;
  from?: string;
  to?: string;
  /** Earlier ids of this conversation (omp moved it to a new file); tabs may still show one. */
  aliases?: string[];
  /** `input` only: the id a retraction (`publishNotificationDismiss`) matches. */
  requestId?: string;
  /** `input` only: the dialog waiting for an answer, when it fits a push payload. */
  dialog?: NotificationDialog;
}

/** One entry of the persisted notification history; `id` is the replace-tag `<sessionId>:<type>`. */
export interface NotificationHistoryEntry {
  id: string;
  event: NotificationEvent;
  at: number;
  read: boolean;
}

export interface NotificationPrefs {
  enabled: boolean;
  types: Record<NotificationType, boolean>;
  /** While the user is active in another omp-web tab: in-app toast or system notification. */
  whenActive: "toast" | "system";
  /** UI locale, so pushes are written in the device's language. */
  locale: string;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  enabled: false,
  types: { completed: true, input: true, error: true, modelSwitch: false },
  whenActive: "toast",
  locale: "en",
};

/** Validate untrusted prefs (request bodies, localStorage); unknown fields fall back to defaults. */
export function parseNotificationPrefs(value: unknown): NotificationPrefs {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rawTypes = raw.types && typeof raw.types === "object" ? (raw.types as Record<string, unknown>) : {};
  const types = { ...DEFAULT_NOTIFICATION_PREFS.types };
  for (const type of NOTIFICATION_TYPES) {
    if (typeof rawTypes[type] === "boolean") types[type] = rawTypes[type] as boolean;
  }
  return {
    enabled: raw.enabled === true,
    types,
    whenActive: raw.whenActive === "system" ? "system" : "toast",
    locale: typeof raw.locale === "string" && /^[A-Za-z-]{2,10}$/.test(raw.locale) ? raw.locale : "en",
  };
}

export interface RenderedNotification {
  title: string;
  body: string;
  url: string;
  tag: string;
  sessionId: string;
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;

const MAX_DETAIL = 180;
/** Session names can be pasted at any length; push payloads are capped near 4 KB. */
const MAX_TITLE = 100;

function clip(text: string, max = MAX_DETAIL): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Title, body, click target, and replace-tag for one event in the caller's language. */
export function renderNotification(event: NotificationEvent, t: Translate): RenderedNotification {
  const detail = event.detail ? clip(event.detail) : "";
  let body: string;
  switch (event.type) {
    case "completed":
      body = t("notifications.completedBody");
      break;
    case "input":
      body = detail ? t("notifications.inputBody", { detail }) : t("notifications.inputBodyNoDetail");
      break;
    case "error":
      body = detail ? t("notifications.errorBody", { detail }) : t("notifications.errorBodyNoDetail");
      break;
    case "modelSwitch":
      if (event.from && event.to) {
        body = detail
          ? t("notifications.modelSwitchBody", { from: event.from, to: event.to, detail })
          : t("notifications.modelSwitchBodyNoDetail", { from: event.from, to: event.to });
      } else {
        body = detail;
      }
      break;
    case "test":
      body = t("notifications.testBody");
      break;
  }
  return {
    title: (event.sessionName && clip(event.sessionName, MAX_TITLE)) || t("notifications.untitledSession"),
    body,
    url: event.sessionId ? `/?session=${encodeURIComponent(event.sessionId)}` : "/",
    tag: `${event.sessionId}:${event.type}`,
    sessionId: event.sessionId,
  };
}

const MODEL_SWITCH_NOTICE_SOURCES = new Set(["prewalk", "plan-yolo"]);

/** Extension UI methods that block the agent until the user answers (rpc-manager replays these too). */
export const BLOCKING_UI_METHODS = new Set(["select", "confirm", "input", "editor", "ask", "open_url"]);

const NOTIFICATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Client and device ids: generated by the browser, checked by the server. */
export function isValidNotificationId(value: unknown): value is string {
  return typeof value === "string" && NOTIFICATION_ID_PATTERN.test(value);
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);

// Push payloads must stay well under the 4 KB Web Push limit. A dialog that
// cannot be represented within these caps is omitted entirely so the app falls
// back to "Open" instead of showing a partial question.
const DIALOG_TEXT = { title: 160, message: 480, placeholder: 80, option: 160, question: 240, questionOption: 120 };
const DIALOG_COUNTS = { options: 12, questions: 5, questionOptions: 9 };
const DIALOG_ID_CHARS = 128;
const MAX_DIALOG_BYTES = 1800;
const DIALOG_METHODS: Record<string, true> = { select: true, confirm: true, input: true, editor: true, ask: true };
const encoder = new TextEncoder();

/** Flatten and clip one line of dialog text that is only displayed. */
function clipDialogText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Option labels travel back to omp as the answer and are compared verbatim
 * (`extension_ui_response.selectedOptions`), so they are never trimmed,
 * flattened or clipped. A set that has to be altered to fit the notification
 * makes the whole dialog unrepresentable: the notification then only opens
 * the session instead of sending an answer omp would not match.
 */
function exactDialogOptions(value: unknown, maxCount: number, maxChars: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > maxCount) return undefined;
  const labels: string[] = [];
  for (const entry of value) {
    const label = typeof entry === "string" ? entry : isRecord(entry) ? entry.label : undefined;
    if (typeof label !== "string" || label.length === 0 || label.length > maxChars) return undefined;
    labels.push(label);
  }
  return labels.length > 0 ? labels : undefined;
}

/** `ask` questions: ids must be unique and complete, or the whole dialog is unusable. */
function dialogQuestions(value: unknown): NotificationDialogQuestion[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > DIALOG_COUNTS.questions) return undefined;
  const questions: NotificationDialogQuestion[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw)) return undefined;
    // The id is the key omp matches the answer against; trimming it could
    // answer a different question, so a padded id makes the dialog unusable.
    const id = typeof raw.id === "string" ? raw.id : "";
    const question = clipDialogText(raw.question, DIALOG_TEXT.question);
    if (!id || id.trim() !== id || id.length > DIALOG_ID_CHARS || ids.has(id) || !question) return undefined;
    ids.add(id);
    const entry: NotificationDialogQuestion = { id, question };
    // A non-empty list must survive exactly or the question would lose
    // choices; an empty list is just a free-text question.
    if (raw.options !== undefined && raw.options !== null) {
      if (!Array.isArray(raw.options)) return undefined;
      if (raw.options.length > 0) {
        const options = exactDialogOptions(raw.options, DIALOG_COUNTS.questionOptions, DIALOG_TEXT.questionOption);
        if (!options) return undefined;
        entry.options = options;
      }
    }
    if (raw.multi === true) entry.multi = true;
    // Same rule as ExtensionDialog: every question may be answered with "Other".
    if (raw.allowCustom !== false) entry.allowCustom = true;
    questions.push(entry);
  }
  return questions;
}

/**
 * Reduce a blocking `extension_ui_request` frame to the answerable dialog a
 * notification carries. Returns undefined for `open_url` (no answer) and for
 * frames whose payload would not fit a push payload.
 */
export function buildNotificationDialog(frame: Record<string, unknown>): NotificationDialog | undefined {
  const method = typeof frame.method === "string" ? frame.method : "";
  if (!DIALOG_METHODS[method]) return undefined;
  // The id is echoed in the answer; never trim it into a different request.
  const requestId = typeof frame.id === "string" ? frame.id : "";
  if (!requestId || requestId.trim() !== requestId || requestId.length > DIALOG_ID_CHARS) return undefined;

  const dialog: NotificationDialog = { requestId, method: method as NotificationDialog["method"] };
  const title = clipDialogText(frame.title, DIALOG_TEXT.title);
  if (title) dialog.title = title;

  switch (dialog.method) {
    case "select": {
      const options = exactDialogOptions(frame.options, DIALOG_COUNTS.options, DIALOG_TEXT.option);
      if (!options) return undefined;
      dialog.options = options;
      break;
    }
    case "confirm": {
      const message = clipDialogText(frame.message, DIALOG_TEXT.message);
      if (message) dialog.message = message;
      break;
    }
    case "input": {
      const placeholder = clipDialogText(frame.placeholder, DIALOG_TEXT.placeholder);
      if (placeholder) dialog.placeholder = placeholder;
      break;
    }
    case "editor":
      // The editor body (prefill) is not part of the notification contract: the
      // app opens the session to edit it. The title is enough to name it.
      break;
    case "ask": {
      const questions = dialogQuestions(frame.questions);
      if (!questions) return undefined;
      dialog.questions = questions;
      break;
    }
  }

  // Nothing user-visible to show: the notification body already carries detail.
  if (!dialog.title && !dialog.message && !dialog.placeholder && !dialog.questions && !dialog.options) return undefined;
  if (typeof frame.expiresAt === "number" && Number.isFinite(frame.expiresAt) && frame.expiresAt > 0) dialog.expiresAt = frame.expiresAt;
  if (encoder.encode(JSON.stringify(dialog)).byteLength > MAX_DIALOG_BYTES) return undefined;
  return dialog;
}

type Detect = (frame: Record<string, unknown>, session: { sessionId: string; sessionName: string | null }) => NotificationEvent[];

/**
 * Per-session detector: feed it every top-level rpc-ui frame in order. Subagent
 * activity arrives wrapped in `subagent_*` frames and is never inspected.
 *
 * "completed" fires on `session_settled` (the run and any background work it
 * started are done), unless the last prompt in that stretch failed or was
 * aborted. Errors fire on the failing `prompt_result` itself.
 *
 * omp announces a retry fallback (`retry_fallback_applied`) before the
 * `auto_retry_start` carrying the error that caused it, so a fallback without
 * its own `reason` waits for that frame and takes its error as the reason.
 */
export function createNotificationDetector(): Detect {
  let lastOutcome: string | null = null;
  let heldFallback: NotificationEvent | null = null;
  /** omp-web already reported this run's failure (from a failed `response`); its `prompt_result` must not repeat it. */
  let failureReported = false;

  const releaseFallback = (detail?: string): NotificationEvent[] => {
    const held = heldFallback;
    heldFallback = null;
    return held ? [{ ...held, detail }] : [];
  };

  return (frame, { sessionId, sessionName }) => {
    const base = { sessionId, sessionName };
    switch (frame.type) {
      case "agent_start":
        failureReported = false;
        return [];
      // omp-web's own frames: an async prompt failure (`response` with
      // success: false) and the omp child exiting mid-run.
      case "prompt_error":
      case "process_exit": {
        const events = releaseFallback();
        lastOutcome = "error";
        if (failureReported) return events;
        failureReported = true;
        return [...events, { ...base, type: "error", detail: str(frame.errorMessage) ?? str(frame.detail) }];
      }
      case "auto_retry_start":
        return releaseFallback(str(frame.errorMessage));
      case "retry_fallback_applied": {
        const from = str(frame.from);
        const to = str(frame.to);
        if (!from || !to) return [];
        const event: NotificationEvent = { ...base, type: "modelSwitch", from, to };
        const reason = str(frame.reason);
        if (reason) return [...releaseFallback(), { ...event, detail: reason }];
        const earlier = releaseFallback();
        heldFallback = event;
        return earlier;
      }
      case "notice": {
        const source = str(frame.source);
        const message = str(frame.message);
        if (!source || !message || !MODEL_SWITCH_NOTICE_SOURCES.has(source)) return [];
        return [{ ...base, type: "modelSwitch", detail: message }];
      }
      case "prompt_result": {
        const events = releaseFallback();
        if (frame.agentInvoked !== true) return events;
        lastOutcome = str(frame.status) ?? null;
        if (lastOutcome !== "error" || failureReported) return events;
        failureReported = true;
        return [...events, { ...base, type: "error", detail: isRecord(frame.error) ? str(frame.error.message) : undefined }];
      }
      case "auto_retry_end":
        return releaseFallback();
      case "session_settled": {
        const events = releaseFallback();
        const outcome = lastOutcome;
        lastOutcome = null;
        failureReported = false;
        if (outcome === "error" || outcome === "aborted") return events;
        return [...events, { ...base, type: "completed" }];
      }
      case "extension_ui_request": {
        // Only reached for requests that wait on the user (omp-web answers
        // auto-approved ones before they are emitted).
        if (typeof frame.method !== "string" || !BLOCKING_UI_METHODS.has(frame.method)) return [];
        const firstQuestion = Array.isArray(frame.questions) && isRecord(frame.questions[0]) ? str(frame.questions[0].question) : undefined;
        const event: NotificationEvent = { ...base, type: "input", detail: str(frame.title) ?? firstQuestion ?? str(frame.message) ?? str(frame.instructions) };
        // Carried even without a dialog (open_url, oversized payload) so the
        // matching retraction can still close this notification.
        if (typeof frame.id === "string" && frame.id) event.requestId = frame.id;
        // `open_url` has no answerable dialog; buildNotificationDialog rejects it.
        const dialog = buildNotificationDialog(frame);
        if (dialog) event.dialog = dialog;
        return [event];
      }
      default:
        return [];
    }
  };
}
