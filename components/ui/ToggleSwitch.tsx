"use client";

/** Shared switch used by native settings and MCP controls. */
export function ToggleSwitch({
  checked,
  onChange,
  disabled,
  id,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="ui-focus-ring"
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 44,
        height: 44,
        padding: 0,
        border: "none",
        background: "transparent",
        cursor: disabled ? "not-allowed" : "pointer",
        flexShrink: 0,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: "inline-flex",
          alignItems: "center",
          width: 40,
          height: 24,
          padding: 2,
          borderRadius: 12,
          background: checked ? "var(--accent-strong)" : "var(--border)",
          transition: "background var(--dur-fast)",
        }}
      >
        <span
          style={{
            width: 20,
            height: 20,
            borderRadius: 10,
            background: "#fff",
            transform: checked ? "translateX(16px)" : "translateX(0px)",
            transition: "transform var(--dur-fast)",
            boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
          }}
        />
      </span>
    </button>
  );
}
