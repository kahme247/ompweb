"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/lib/i18n";
import { formatCompactNumber } from "@/lib/format";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/primitives";
import { useIsMobile } from "@/hooks/useIsMobile";
import { X } from "lucide-react";

/** One flattened models.dev entry as served by /api/models-config/catalog. */
export interface CatalogModelEntry {
  key: string;
  providerId: string;
  providerName: string;
  providerBaseUrl?: string;
  id: string;
  name: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

/** The subset of a models.yml model entry the picker can populate. */
export interface CatalogPickedModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

interface ModelCatalogPickerProps {
  open: boolean;
  providerName: string;
  providerBaseUrl: string;
  existingIds: ReadonlySet<string>;
  onAdd: (model: CatalogPickedModel, baseUrl?: string) => void;
  onClose: () => void;
}

const SEARCH_DEBOUNCE_MS = 250;
const RESULT_LIMIT = 30;

function formatContext(n: number): string {
  return formatCompactNumber(n);
}

function toPickedModel(entry: CatalogModelEntry): CatalogPickedModel {
  // omp's models.yml schema requires ALL FOUR cost fields when cost is
  // present (models-config-schema-bundle.ts); default missing cache fields to
  // 0 exactly like the catalog recommendation does, and skip cost entirely
  // when the catalog entry has no usable input/output price.
  const hasPrice = entry.cost.input !== undefined && entry.cost.output !== undefined;
  return {
    id: entry.id,
    ...(entry.name && entry.name !== entry.id ? { name: entry.name } : {}),
    ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {}),
    ...(entry.input ? { input: entry.input } : {}),
    ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
    ...(entry.maxTokens !== undefined ? { maxTokens: entry.maxTokens } : {}),
    ...(hasPrice
      ? {
          cost: {
            input: entry.cost.input,
            output: entry.cost.output,
            cacheRead: entry.cost.cacheRead ?? 0,
            cacheWrite: entry.cost.cacheWrite ?? 0,
          },
        }
      : {}),
  };
}

/** Search the models.dev catalog and add a fully-populated model entry. */
export function ModelCatalogPicker({ open, providerName, providerBaseUrl, existingIds, onAdd, onClose }: ModelCatalogPickerProps) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CatalogModelEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // the newer query's results or clear its loading state.
  const searchSeqRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const q = query.trim();
    if (!q) {
      searchSeqRef.current += 1;
      setResults(null);
      setError(null);
      setLoading(false);
      return;
    }
    const params = new URLSearchParams({ q, limit: String(RESULT_LIMIT) });
    if (providerName) params.set("provider", providerName);
    if (providerBaseUrl) params.set("baseUrl", providerBaseUrl);
    const controller = new AbortController();
    const seq = searchSeqRef.current + 1;
    searchSeqRef.current = seq;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/models-config/catalog?${params.toString()}`, { signal: controller.signal });
        const data = await res.json() as { models?: CatalogModelEntry[]; error?: string };
        if (searchSeqRef.current !== seq) return;
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setResults(data.models ?? []);
        setError(null);
      } catch (e) {
        if (searchSeqRef.current !== seq) return;
        if ((e as Error).name !== "AbortError") setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (searchSeqRef.current === seq) setLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, open, providerName, providerBaseUrl]);

  const rowStyle: CSSProperties = {
    display: "flex", flexDirection: "row", alignItems: "center", gap: 10,
    padding: "9px 12px",
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-control)",
    marginBottom: 6,
    minWidth: 0,
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        ariaLabel={t("modelsConfig.catalogTitle")}
        zIndex={1100}
        style={{
          width: isMobile ? "100vw" : 720,
          maxWidth: isMobile ? "100vw" : "min(92vw, 720px)",
          maxHeight: isMobile ? "88dvh" : "min(72dvh, calc(100dvh - 32px))",
          height: isMobile ? "88dvh" : undefined,
          position: "fixed",
          top: isMobile ? "auto" : "50%",
          bottom: isMobile ? 0 : "auto",
          left: isMobile ? 0 : "50%",
          transform: isMobile ? "none" : "translate(-50%, -50%)",
          borderRadius: isMobile ? "20px 20px 0 0" : "var(--radius-modal)",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          animation: "none",
        }}
      >
        {isMobile && (
          <div style={{ width: 36, height: 4, borderRadius: 2, background: "var(--border)", margin: "8px auto 0", flexShrink: 0 }} />
        )}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px 8px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <DialogTitle style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", margin: 0 }}>{t("modelsConfig.catalogTitle")}</DialogTitle>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("settingsConfig.closeSettings") || "Close"}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              padding: "4px 6px",
              minWidth: 28,
              minHeight: 28,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "var(--radius-control)",
            }}
          >
            <X size={17} aria-hidden="true" />
          </button>
        </div>
        {/* Search */}
        <div style={{ padding: "8px 14px 12px", flexShrink: 0 }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "6px 10px",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
          }}>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={t("modelsConfig.catalogSearchPlaceholder")}
              placeholder={t("modelsConfig.catalogSearchPlaceholder")}
              style={{
                flex: 1, background: "none", border: "none", outline: "none",
                color: "var(--text)", fontSize: 13, boxSizing: "border-box", minWidth: 0,
              }}
            />
          </div>
        </div>

        {/* Results */}
        <div style={{ flex: 1, overflowY: "auto", padding: "4px 14px 14px" }}>
          {error ? (
            <div role="alert" style={{ padding: "20px 0", fontSize: 12, color: "var(--status-error)", textAlign: "center" }}>
              {t("modelsConfig.catalogError", { error })}
            </div>
          ) : loading ? (
            <div role="status" aria-live="polite" style={{ padding: "20px 0", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>{t("modelsConfig.catalogLoading")}</div>
          ) : results === null ? (
            <div style={{ padding: "20px 0", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>{t("modelsConfig.catalogSearchPlaceholder")}</div>
          ) : results.length === 0 ? (
            <div style={{ padding: "20px 0", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>{t("modelsConfig.catalogNoResults")}</div>
          ) : (
            results.map((entry) => {
              const alreadyAdded = existingIds.has(entry.id);
              const setsBaseUrl = Boolean(entry.providerBaseUrl) && !providerBaseUrl;
              return (
                <div key={entry.key} style={rowStyle}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.id}</span>
                      {entry.reasoning && (
                        <span style={{ fontSize: 9, padding: "1px 4px", background: "color-mix(in srgb, var(--accent) 12%, transparent)", color: "var(--accent)", borderRadius: 3, flexShrink: 0 }}>T</span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {entry.providerName}
                      {entry.contextWindow !== undefined ? ` · ${t("modelsConfig.catalogContext", { n: formatContext(entry.contextWindow) })}` : ""}
                      {entry.cost.input !== undefined && entry.cost.output !== undefined
                        ? ` · ${t("modelsConfig.catalogPrice", { input: entry.cost.input, output: entry.cost.output })}`
                        : ""}
                      {setsBaseUrl ? ` · ${t("modelsConfig.catalogSetBaseUrl")}` : ""}
                    </div>
                  </div>
                  {alreadyAdded ? (
                    <span style={{ flexShrink: 0, padding: "5px 12px", background: "none", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", color: "var(--text-dim)", fontSize: 12 }}>
                      {t("modelsConfig.catalogAdded")}
                    </span>
                  ) : (
                    <button
                      type="button"
                      aria-label={"Add " + entry.id + " (" + entry.providerName + ")"}
                      onClick={() => onAdd(toPickedModel(entry), entry.providerBaseUrl)}
                      style={{ flexShrink: 0, padding: "5px 12px", background: "var(--accent)", border: "none", borderRadius: "var(--radius-control)", color: "var(--on-accent)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
                    >
                      {t("modelsConfig.catalogAdd")}
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
