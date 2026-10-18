"use client";

import { translate as uiText, useI18n } from "@/lib/i18n";

/**
 * Warm-paper form field primitives + confirmation dialog.
 *
 * Tokens come from app/globals.css (--bg, --bg-panel, --border, --accent,
 * --accent-strong, --accent-hover, --text, --text-muted, --text-dim,
 * --radius-control, --radius-card, --shadow-card, --shadow-pop). No global
 * CSS edits — focus glow + invalid state are implemented inline via React
 * state on focus / blur so we don't need to touch globals.css.
 */
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEventHandler,
  type ReactElement,
  type ReactNode,
} from "react";
import { AlertCircle, Check as CheckIcon, Eye, EyeOff, Info, TriangleAlert, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/primitives";

/* ────────────────────────── Field wrapper ────────────────────────── */

interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  /** When true, the label is rendered with a required asterisk. */
  required?: boolean;
  children: ReactNode;
  /** Inline style overrides for the outer wrapper. */
  style?: CSSProperties;
  id?: string;
}

export function Field({ label, hint, error, required, children, style, id }: FieldProps) {
  const autoId = useId();
  const childId = isValidElement(children) ? (children.props as { id?: string }).id : undefined;
  const fieldId = id || childId || autoId;
  const errorId = error ? `${fieldId}-error` : undefined;
  const hintId = !error && hint ? `${fieldId}-hint` : undefined;
  const describedBy = errorId || hintId;

  let enhancedChildren = children;
  if (isValidElement(children)) {
    enhancedChildren = cloneElement(children as ReactElement<{ id?: string; "aria-describedby"?: string }>, {
      id: childId || fieldId,
      "aria-describedby": (children.props as { "aria-describedby"?: string })["aria-describedby"] || describedBy,
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, ...style }}>
      <label
        htmlFor={fieldId}
        style={{
          fontSize: 11,
          fontWeight: 500,
          color: error ? "var(--accent)" : "var(--text-muted)",
          letterSpacing: "0.01em",
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        {label}
        {required && <span style={{ color: "var(--accent)" }}>*</span>}
      </label>
      {enhancedChildren}
      {error ? (
        <FieldError id={errorId}>{error}</FieldError>
      ) : hint ? (
        <span id={hintId} style={{ fontSize: 10, color: "var(--text-dim)", lineHeight: 1.4 }}>{hint}</span>
      ) : null}
    </div>
  );
}

function FieldError({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <span
      id={id}
      role="alert"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 12,
        color: "var(--status-error)",
        lineHeight: 1.3,
        marginTop: 1,
      }}
    >
      <AlertCircle size={12} aria-hidden="true" />
      {children}
    </span>
  );
}

export type AlertVariant = "success" | "error" | "warning" | "info";

export function Alert({
  variant = "info",
  title,
  description,
  onDismiss,
  style,
}: {
  variant?: AlertVariant;
  title?: ReactNode;
  description: ReactNode;
  onDismiss?: () => void;
  style?: CSSProperties;
}) {
  useI18n();
  const isError = variant === "error";
  const isWarning = variant === "warning";
  const Icon = isError ? AlertCircle : variant === "success" ? CheckIcon : isWarning ? TriangleAlert : Info;
  const color = isError ? "var(--status-error)" : variant === "success" ? "var(--status-success)" : isWarning ? "var(--status-warning)" : "var(--text-muted)";
  const borderColor = isError ? "var(--status-error)" : variant === "success" ? "var(--status-success)" : isWarning ? "var(--status-warning)" : "var(--border)";
  const bg = isError
    ? "color-mix(in srgb, var(--status-error) 7%, var(--bg-panel))"
    : variant === "success"
      ? "color-mix(in srgb, var(--status-success) 7%, var(--bg-panel))"
      : isWarning
        ? "color-mix(in srgb, var(--status-warning) 7%, var(--bg-panel))"
        : "var(--bg-subtle)";
  return (
    <div
      role={isError ? "alert" : "status"}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "10px 12px",
        border: `1px solid ${borderColor}`,
        borderRadius: "var(--radius-control)",
        background: bg,
        color: "var(--text)",
        fontSize: 12,
        lineHeight: 1.5,
        ...style,
      }}
    >
      <Icon size={13} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1, color }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && <div style={{ fontWeight: 600, color }}>{title}</div>}
        <div style={{ color: isError ? "var(--status-error)" : isWarning ? "var(--status-warning)" : "var(--text-muted)", overflowWrap: "anywhere" }}>{description}</div>
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={uiText("common.dismiss")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 20,
            height: 20,
            border: 0,
            borderRadius: "var(--radius-control)",
            background: "transparent",
            color: "var(--text-dim)",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/* ──────────────────────── Form group / card ──────────────────────── */

export function FieldGroup({
  label,
  children,
  style,
}: {
  label: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: "12px 14px",
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-card)",
        minWidth: 0,
        ...style,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        {label}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>{children}</div>
    </section>
  );
}

/* ──────────────────────── Inputs / selects ──────────────────────── */

interface InputShellStyleOptions {
  invalid: boolean;
}

function inputShellStyle({ invalid }: InputShellStyleOptions): CSSProperties {
  return {
    padding: "6px 9px",
    background: "var(--bg)",
    border: `1px solid ${invalid ? "var(--status-error)" : "var(--border)"}`,
    borderRadius: "var(--radius-control)",
    color: "var(--text)",
    fontSize: 12,
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
    transition: "border-color var(--dur-fast) var(--ease-out-warm), box-shadow var(--dur-fast) var(--ease-out-warm)",
  };
}

/** Internal: applied border + box-shadow on focus. */
function focusGlowStyle(focused: boolean, invalid: boolean): CSSProperties {
  if (!focused) return {};
  return {
    borderColor: invalid ? "var(--status-error)" : "var(--accent)",
    boxShadow: invalid
      ? "0 0 0 2px color-mix(in srgb, var(--status-error) 28%, transparent)"
      : "0 0 0 2px color-mix(in srgb, var(--accent) 28%, transparent)",
  };
}

/* ─── Text input ─── */

interface TextInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  invalid?: boolean;
  error?: string | null;
  onBlurValidate?: () => void;
  disabled?: boolean;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  autoComplete?: string;
  spellCheck?: boolean;
  id?: string;
}

export function TextInput({
  value,
  onChange,
  placeholder,
  mono,
  invalid,
  error,
  onBlurValidate,
  disabled,
  onKeyDown,
  autoComplete,
  spellCheck,
  id,
}: TextInputProps) {
  const [focused, setFocused] = useState(false);
  const isInvalid = Boolean(invalid || error);
  return (
    <input
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      onKeyDown={onKeyDown}
      autoComplete={autoComplete}
      spellCheck={spellCheck}
      aria-invalid={isInvalid || undefined}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        onBlurValidate?.();
      }}
      style={{
        ...inputShellStyle({ invalid: isInvalid }),
        ...focusGlowStyle(focused, isInvalid),
        fontFamily: mono ? "var(--font-mono)" : "inherit",
        opacity: disabled ? 0.6 : 1,
      }}
    />
  );
}

/* ─── Number input ─── */

interface NumInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  invalid?: boolean;
  error?: string | null;
  onBlurValidate?: () => void;
  disabled?: boolean;
  id?: string;
}

export function NumInput({
  value,
  onChange,
  placeholder,
  invalid,
  error,
  onBlurValidate,
  disabled,
  id,
}: NumInputProps) {
  const [focused, setFocused] = useState(false);
  const isInvalid = Boolean(invalid || error);
  return (
    <input
      id={id}
      type="number"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      aria-invalid={isInvalid || undefined}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        onBlurValidate?.();
      }}
      style={{
        ...inputShellStyle({ invalid: isInvalid }),
        ...focusGlowStyle(focused, isInvalid),
        opacity: disabled ? 0.6 : 1,
      }}
    />
  );
}

/* ─── Secret (password) input with show / hide ─── */

interface SecretInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  invalid?: boolean;
  error?: string | null;
  onBlurValidate?: () => void;
  disabled?: boolean;
  showLabel: string;
  hideLabel: string;
  id?: string;
}

export function SecretInput({
  value,
  onChange,
  placeholder,
  invalid,
  error,
  onBlurValidate,
  disabled,
  showLabel,
  hideLabel,
  id,
}: SecretInputProps) {
  const [visible, setVisible] = useState(false);
  const [focused, setFocused] = useState(false);
  const isInvalid = Boolean(invalid || error);

  useEffect(() => {
    if (!value) setVisible(false);
  }, [value]);

  return (
    <div style={{ position: "relative", width: "100%" }}>
      <input
        id={id}
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={isInvalid || undefined}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          onBlurValidate?.();
        }}
        style={{
          ...inputShellStyle({ invalid: isInvalid }),
          ...focusGlowStyle(focused, isInvalid),
          paddingRight: 34,
          fontFamily: "var(--font-mono)",
          opacity: disabled ? 0.6 : 1,
        }}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? hideLabel : showLabel}
        title={visible ? hideLabel : showLabel}
        style={{
          position: "absolute",
          right: 5,
          top: "50%",
          transform: "translateY(-50%)",
          width: 24,
          height: 24,
          padding: 0,
          border: "none",
          background: "transparent",
          color: "var(--text-dim)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 4,
        }}
      >
        {visible ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
      </button>
    </div>
  );
}

/* ─── Select ─── */

interface SelectProps {
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  required?: boolean;
  placeholder?: string;
  invalid?: boolean;
  error?: string | null;
  disabled?: boolean;
  id?: string;
}

export function Select({
  value,
  onChange,
  options,
  required,
  placeholder,
  invalid,
  error,
  disabled,
  id,
}: SelectProps) {
  const [focused, setFocused] = useState(false);
  const isInvalid = Boolean(invalid || error);
  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      aria-invalid={isInvalid || undefined}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        ...inputShellStyle({ invalid: isInvalid }),
        ...focusGlowStyle(focused, isInvalid),
        color: value ? "var(--text)" : "var(--text-dim)",
        appearance: "none",
        width: "100%",
        paddingRight: 24,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {!required && <option value="">{placeholder ?? ""}</option>}
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ position: "absolute", right: 8, color: "var(--text-dim)", pointerEvents: "none" }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
    </div>
  );
}

/* ─── Checkbox ─── */

interface CheckProps {
  label: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}

export function Check({ label, checked, onChange, disabled }: CheckProps) {
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        cursor: disabled ? "not-allowed" : "pointer",
        fontSize: 12,
        color: disabled ? "var(--text-dim)" : "var(--text-muted)",
        opacity: disabled ? 0.7 : 1,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 14, height: 14, accentColor: "var(--accent)", cursor: disabled ? "not-allowed" : "pointer" }}
      />
      {label}
    </label>
  );
}

/* ──────────────────── Convenience hooks ──────────────────── */

/**
 * Tiny controller for inline validation: validate on blur (and on demand from
 * submit), clear on change. Caller owns the message strings and the validator.
 */
export function useFieldValidation(validate: () => string | null) {
  const [error, setError] = useState<string | null>(null);
  const validateRef = useRef(validate);
  validateRef.current = validate;

  const onBlur = useCallback(() => {
    setError(validateRef.current());
  }, []);

  const onChange = useCallback(() => {
    setError((prev) => (prev === null ? null : null));
  }, []);

  const onSubmit = useCallback((): string | null => {
    const e = validateRef.current();
    setError(e);
    return e;
  }, []);

  return { error, onBlur, onChange, onSubmit };
}

/* ──────────────────── Confirm dialog ──────────────────── */

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel?: ReactNode;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  danger,
  busy,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ariaLabel={typeof title === "string" ? title : undefined}
        style={{ width: 420, maxWidth: "min(92vw, 420px)", padding: 22, display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <DialogTitle>{title}</DialogTitle>
        <div style={{ height: 8 }} />
        {description && (
          <p
            style={{
              flex: "1 1 auto",
              minHeight: 0,
              overflowY: "auto",
              whiteSpace: "pre-wrap",
              margin: "0 0 12px",
              fontSize: 13,
              lineHeight: 1.55,
              color: "var(--text-muted)",
            }}
          >
            {description}
          </p>
        )}
        <div className="dialog-actions" style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexShrink: 0, paddingTop: 4 }}>
          <button
            type="button"
            className="dialog-action"
            onClick={() => onOpenChange(false)}
            style={{
              padding: "6px 14px",
              background: "none",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-control)",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            {cancelLabel ?? "Cancel"}
          </button>
          <button
            type="button"
            className="dialog-action"
            disabled={busy}
            onClick={onConfirm}
            style={{
              padding: "6px 14px",
              background: danger ? "var(--status-error)" : "var(--accent-strong)",
              border: "none",
              borderRadius: "var(--radius-control)",
              color: "var(--on-accent)",
              cursor: busy ? "wait" : "pointer",
              fontSize: 13,
              fontWeight: 600,
              opacity: busy ? 0.7 : 1,
              transition: "background var(--dur-fast) var(--ease-out-warm)",
            }}
            onMouseEnter={(e) => {
              if (!busy) e.currentTarget.style.background = danger ? "color-mix(in srgb, var(--status-error) 82%, black)" : "var(--accent-hover)";
            }}
            onMouseLeave={(e) => {
              if (!busy) e.currentTarget.style.background = danger ? "var(--status-error)" : "var(--accent-strong)";
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
