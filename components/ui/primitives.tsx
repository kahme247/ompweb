"use client";

/**
 * Warm-paper UI primitives on top of @base-ui/react.
 * Theming contract: CSS variables from globals.css (--bg, --accent, --radius-*,
 * --shadow-*, --dur-*, --ease-out-warm). No hardcoded colors here.
 */
import { createContext, useContext } from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { Collapsible as BaseCollapsible } from "@base-ui/react/collapsible";

/* ---------------------------------- Dialog --------------------------------- */

const DialogCtx = createContext<{ onOpenChange?: (open: boolean) => void }>({});

export function Dialog({ open, onOpenChange, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <DialogCtx.Provider value={{ onOpenChange }}>
      <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
        {children}
      </BaseDialog.Root>
    </DialogCtx.Provider>
  );
}
export function DialogContent({ children, className, style, ariaLabel, zIndex, onClose }: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  ariaLabel?: string;
  zIndex?: number;
  onClose?: () => void;
}) {
  const { onOpenChange } = useContext(DialogCtx);
  const backdropZ = zIndex ?? 1000;
  const popupZ = (zIndex ?? 1000) + 1;
  const handleClose = () => {
    onClose?.();
    onOpenChange?.(false);
  };
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop
        onClick={(e) => {
          e.stopPropagation();
          handleClose();
        }}
        style={{
          position: "fixed", inset: 0,
          background: "var(--overlay-backdrop)",
          backdropFilter: "blur(2px)",
          zIndex: backdropZ,
          cursor: "pointer",
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
          zIndex: popupZ,
          background: "var(--bg)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-modal)",
          boxShadow: "var(--shadow-modal)",
          padding: 20,
          maxWidth: "min(92vw, 560px)",
          maxHeight: "85dvh",
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

export function CollapsiblePanel({ children, style }: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <BaseCollapsible.Panel style={style}>
      {children}
    </BaseCollapsible.Panel>
  );
}
