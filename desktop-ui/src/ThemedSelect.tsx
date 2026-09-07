import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";

export type SelectOption = {
  value: string;
  label: string;
  group?: string;
  /** Second line rendered under the label (approval-mode style menus). */
  description?: string;
  /** Small pill after the label (capability badges, e.g. "Vision"). */
  badge?: string;
  /** Leading icon for rich menus. */
  icon?: ReactNode;
};

type ThemedSelectProps = {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** Opens the list upward (composer/context row) or downward (settings). */
  direction?: "up" | "down";
  disabled?: boolean;
  placeholder?: string;
  title?: string;
  ariaLabel?: string;
  className?: string;
  /** Max rendered label width before ellipsis. */
  maxWidth?: number;
  /** Show a filter box on top of the open menu (long lists like models). */
  searchable?: boolean;
  /** Filter input placeholder. */
  searchPlaceholder?: string;
  /** Bottom action row inside the open menu (e.g. "Manage models"). */
  footer?: ReactNode;
  /** Hide the trigger label (icon-only triggers). */
  hideLabel?: boolean;
};

/** Themed dropdown replacing native <select> — one consistent, dark-aware
 *  menu everywhere (WebView2 native option popups ignore color-scheme). */
export function ThemedSelect({
  value,
  options,
  onChange,
  direction = "down",
  disabled,
  placeholder,
  title,
  ariaLabel,
  className,
  maxWidth = 220,
  footer,
  hideLabel,
  searchable,
  searchPlaceholder = "Search…",
}: ThemedSelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  useEffect(() => {
    if (open && searchable) searchRef.current?.focus();
  }, [open, searchable]);

  useLayoutEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const selected = options.find((o) => o.value === value);
  const label = selected?.label ?? placeholder ?? value;
  const needle = searchable ? query.trim().toLowerCase() : "";
  const visible =
    needle.length === 0
      ? options
      : options.filter((o) =>
          `${o.label} ${o.group ?? ""} ${o.description ?? ""} ${o.value}`.toLowerCase().includes(needle),
        );

  const openList = () => {
    if (disabled) return;
    setQuery("");
    const idx = options.findIndex((o) => o.value === value);
    setActive(idx >= 0 ? idx : 0);
    setOpen(true);
  };

  const commit = (option: SelectOption) => {
    setOpen(false);
    if (option.value !== value) onChange(option.value);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        openList();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(visible.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(visible.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const option = visible[active];
      if (option) commit(option);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  let lastGroup: string | undefined;

  return (
    <div className={`tsel-wrap${className ? ` ${className}` : ""}`} ref={wrapRef}>
      <button
        type="button"
        className="tsel-trigger"
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        style={{ maxWidth }}
      >
        {!hideLabel && <span className="tsel-label" style={{ maxWidth: maxWidth - 22 }}>{label}</span>}
        <ChevronDown size={12} aria-hidden className="tsel-chevron" />
      </button>
      {open && (
        <div
          className={`tsel-menu ${direction === "up" ? "tsel-up" : "tsel-down"}`}
          role="listbox"
          ref={listRef}
          style={{ maxWidth: Math.max(maxWidth, 240) }}
        >
          {searchable && (
            <div className="tsel-search">
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onKeyDown}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
              />
            </div>
          )}
          {visible.map((option, i) => {
            const showGroup = option.group && option.group !== lastGroup;
            lastGroup = option.group;
            return (
              <div key={option.value}>
                {showGroup && <div className="tsel-group">{option.group}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  data-index={i}
                  className={`tsel-option${i === active ? " active" : ""}${option.value === value ? " selected" : ""}${option.description ? " rich" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => commit(option)}
                >
                  {option.icon && <span className="tsel-option-icon">{option.icon}</span>}
                  <span className="tsel-option-body">
                    <span className="tsel-option-line">
                      <span className="tsel-option-label" title={option.label}>{option.label}</span>
                      {option.badge && <span className="tsel-badge">{option.badge}</span>}
                    </span>
                    {option.description && <span className="tsel-option-desc">{option.description}</span>}
                  </span>
                  {option.value === value && <Check size={13} aria-hidden />}
                </button>
              </div>
            );
          })}
          {visible.length === 0 && <div className="tsel-empty">{needle ? "No matches" : "No options"}</div>}
          {footer && (
            <>
              <div className="tsel-sep" />
              {footer}
            </>
          )}
        </div>
      )}
    </div>
  );
}
