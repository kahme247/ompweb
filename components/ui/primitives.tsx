"use client";

/**
 * Warm-paper UI primitives on top of @base-ui/react.
 * Theming contract: CSS variables from globals.css (--bg, --accent, --radius-*,
 * --shadow-*, --dur-*, --ease-out-warm). No hardcoded colors here.
 */
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { Collapsible as BaseCollapsible } from "@base-ui/react/collapsible";
import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronDown, Plus } from "lucide-react";
import { forwardRef } from "react";
import type React from "react";

export interface ThemedSelectOption {
  value: string | number;
  label: React.ReactNode;
  disabled?: boolean;
  action?: boolean;
}

type ThemedSelectProps = Omit<React.ComponentPropsWithoutRef<"button">, "value" | "onChange" | "children"> & {
  value: string | number;
  onChange: (value: string) => void;
  options: readonly ThemedSelectOption[];
  required?: boolean;
};

export const ThemedSelect = forwardRef<HTMLButtonElement, ThemedSelectProps>(function ThemedSelect({
  value, onChange, options, disabled, required, name, className, ...triggerProps
}, ref) {
  const items = options.map((option) => ({ ...option, value: String(option.value) }));
  return (
    <BaseSelect.Root value={String(value)} items={items} disabled={disabled} required={required} name={name}
      onValueChange={(next) => { if (next !== null) onChange(next); }}>
      <BaseSelect.Trigger {...triggerProps} ref={ref} className={`themed-select-trigger${className ? ` ${className}` : ""}`}>
        <BaseSelect.Value className="themed-select-value" />
        <ChevronDown className="themed-select-chevron" size={14} strokeWidth={1.8} aria-hidden="true" />
      </BaseSelect.Trigger>
      {/* Nonzero bounds let the positioner measure both axes of Interface Scale. */}
      <BaseSelect.Portal style={{ position: "relative", height: 1, zIndex: 1100 }}>
        <BaseSelect.Positioner className="themed-select-positioner" sideOffset={6} align="start" alignItemWithTrigger={false}>
          <BaseSelect.Popup className="themed-select-popup">
            <BaseSelect.List className="themed-select-list">
              {items.map((option) => (
                <BaseSelect.Item key={option.value} value={option.value} label={typeof option.label === "string" ? option.label : undefined}
                  disabled={option.disabled} data-action={option.action || undefined} className="themed-select-item">
                  <span className="themed-select-indicator" aria-hidden="true">
                    {option.action ? <Plus size={14} /> : <BaseSelect.ItemIndicator><Check size={14} /></BaseSelect.ItemIndicator>}
                  </span>
                  <BaseSelect.ItemText className="themed-select-item-text">{option.label}</BaseSelect.ItemText>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
});

/* ---------------------------------- Dialog --------------------------------- */

export function Dialog({ open, onOpenChange, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      {children}
    </BaseDialog.Root>
  );
}

export function DialogContent({ children, className, style, ariaLabel }: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  ariaLabel?: string;
}) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop
        style={{
          position: "fixed", inset: 0,
          background: "var(--overlay-backdrop)",
          backdropFilter: "blur(2px)",
          zIndex: 1000,
        }}
      />
      <BaseDialog.Popup
        aria-label={ariaLabel}
        className={className}
        style={{
          position: "fixed", top: "50%", left: "50%",
          transform: "translate(-50%, -50%)",
          // Entrance animation must include the centering transform in its
          // keyframes: an animation overrides the inline transform for its
          // whole (fill: both) lifetime.
          animation: "dialog-pop-in var(--dur-med) var(--ease-out-warm) both",
           zIndex: 1001,
          background: "var(--bg)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-modal)",
          boxShadow: "var(--shadow-modal)",
          padding: 20,
          maxWidth: "min(92vw, 560px)",
          maxHeight: "calc(100dvh - 24px - env(safe-area-inset-top) - env(safe-area-inset-bottom))",
          overflow: "auto",
          ...style,
        }}
      >
        {children}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}

export function DialogTitle({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <BaseDialog.Title className="display-serif" style={{ fontSize: 20, margin: "0 0 12px", ...style }}>
      {children}
    </BaseDialog.Title>
  );
}

export const DialogClose = BaseDialog.Close;

/* ---------------------------------- Tooltip -------------------------------- */

export function Tooltip({ content, children, side = "top" }: {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <BaseTooltip.Provider delay={350} closeDelay={0}>
      <BaseTooltip.Root>
        <BaseTooltip.Trigger render={children} />
        <BaseTooltip.Portal>
          <BaseTooltip.Positioner side={side} sideOffset={6} style={{ zIndex: 1100 }}>
            <BaseTooltip.Popup
              style={{
                background: "var(--bg-panel)",
                color: "var(--text)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-control)",
                boxShadow: "var(--shadow-pop)",
                padding: "4px 9px",
                fontSize: 12,
                lineHeight: 1.4,
                maxWidth: 260,
              }}
            >
              {content}
            </BaseTooltip.Popup>
          </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
      </BaseTooltip.Root>
    </BaseTooltip.Provider>
  );
}

/* -------------------------------- Collapsible ------------------------------- */

export function Collapsible({ open, onOpenChange, defaultOpen, children }: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <BaseCollapsible.Root open={open} onOpenChange={onOpenChange} defaultOpen={defaultOpen}>
      {children}
    </BaseCollapsible.Root>
  );
}

export const CollapsibleTrigger = BaseCollapsible.Trigger;
