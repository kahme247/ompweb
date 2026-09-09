"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/lib/i18n";
import { isSafeExternalUrl } from "@/lib/safe-url";
import { omitUntouchedModelDrafts } from "@/lib/models-config-drafts";
import { formatApiError } from "@/lib/i18n/api-error";
import {
  DialogTitle,
} from "@/components/ui/primitives";
import {
  Field as FormField,
  FieldGroup,
  TextInput,
  NumInput,
  SecretInput,
  Select as FormSelect,
  Check as FormCheck,
  ConfirmDialog,
  useFieldValidation,
} from "@/components/ui/field";
import { Plus, Trash2, RefreshCw, AlertCircle, Cpu, Settings, Sparkles, Check as CheckIcon, Layers, RotateCcw, SlidersHorizontal, BookOpen, Search, KeyRound, ArrowLeft } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { SettingsTabs, type SettingsTab } from "./SettingsTabs";
import { ModelCatalogPicker } from "./ModelCatalogPicker";
import {
  API_OPTIONS,
  COMPOSER_MODELS_STORAGE_KEY,
  COST_LABEL_KEYS,
  ENDPOINT_PRESETS,
  LEVEL_COLORS,
  THINKING_LEVELS,
  presetButtonStyle,
  type EndpointPreset,
  type ModelEntry,
  type ModelTestState,
  type ModelsFileData,
  type OAuthLoginState,
  type OAuthProvider,
  type ApiKeyProvider,
  type ProviderEntry,
  type ConnectedProvider,
  type RuntimeModelEntry,
  type Selection,
  type ThinkingConfig,
  type ThinkingLevel,
} from "./ModelsConfig-types";
import {
  AddProviderPicker,
  ApiKeyDetail,
  CodeText,
  ModelRolesDetail,
  ModelsConfigSurface,
  NativeRegistryDetail,
  ProviderIcon,
  RetryFallbackDetail,
  SectionTitle,
} from "./ModelsConfig-panels";
export { providerInitials } from "./ModelsConfig-types";











// ── Provider detail ───────────────────────────────────────────────────────────


function ProviderDetail({ name, provider, onChange, onRename, onDelete }: {
  name: string; provider: ProviderEntry;
  onChange: (p: ProviderEntry) => void; onRename: (n: string) => void; onDelete: () => void;
}) {
  const { t } = useI18n();
  const [editingName, setEditingName] = useState(name);
  const [deleteOpen, setDeleteOpen] = useState(false);
  useEffect(() => setEditingName(name), [name]);
  const set = <K extends keyof ProviderEntry>(k: K, v: ProviderEntry[K]) => onChange({ ...provider, [k]: v });

  useEffect(() => {
    if (!provider.api) onChange({ ...provider, api: "openai-completions" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.api]);

  const renameValidate = () => {
    if (!editingName.trim()) return t("modelsConfig.errorNameRequired");
    return null;
  };
  const renameV = useFieldValidation(renameValidate);

  const baseUrlValidate = () => {
    const v = provider.baseUrl ?? "";
    if (!v.trim()) return null;
    try {
      const u = new URL(v);
      if (u.protocol !== "http:" && u.protocol !== "https:") return t("modelsConfig.errorUrlInvalid");
      return null;
    } catch {
      return t("modelsConfig.errorUrlInvalid");
    }
  };
  const baseUrlV = useFieldValidation(baseUrlValidate);

  const apiKeyValidate = () => {
    if (provider.auth === "none") return null;
    if (!provider.apiKey || !provider.apiKey.trim()) return t("modelsConfig.errorApiKeyRequired");
    return null;
  };
  const apiKeyV = useFieldValidation(apiKeyValidate);

  const trimmedRename = editingName.trim();
  const hostName = provider.baseUrl ? (provider.baseUrl.replace(/^https?:\/\//, "").split("/")[0] || provider.baseUrl) : t("modelsConfig.defaultEndpoint");

  const applyPreset = (preset: EndpointPreset) => {
    onChange({
      ...provider,
      baseUrl: preset.baseUrl,
      api: "openai-completions",
      auth: preset.auth === "keep" ? provider.auth : preset.auth,
    });
    toast.success(t("modelsConfig.appliedPreset", { url: preset.baseUrl }));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Hero Provider Header Card */}
      <div style={{ padding: "14px 16px", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", display: "flex", flexDirection: "column", gap: 10, boxShadow: "var(--shadow-card)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <ProviderIcon id={name} size={20} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--text)" }}>{name}</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{hostName}</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {provider.auth === "none" ? (
              <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 4, background: "var(--bg-subtle)", color: "var(--text-muted)", fontWeight: 500 }}>
                {t("modelsConfig.authNone")}
              </span>
            ) : provider.apiKey ? (
              <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 4, background: "color-mix(in srgb, var(--accent) 15%, transparent)", color: "var(--accent)", fontWeight: 600 }}>
                {t("modelsConfig.keySet")}
              </span>
            ) : (
              <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 4, background: "color-mix(in srgb, var(--status-error) 15%, transparent)", color: "var(--status-error)", fontWeight: 600 }}>
                {t("modelsConfig.keyMissing")}
              </span>
            )}
          </div>
        </div>

        {/* {t("modelsConfig.quickEndpointPresets")} */}
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, marginTop: 4 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
            Quick Endpoint Presets
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {ENDPOINT_PRESETS.map((preset) => (
              <button
                key={preset.baseUrl}
                type="button"
                onClick={() => applyPreset(preset)}
                style={presetButtonStyle}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <FieldGroup
        label={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Settings size={12} aria-hidden="true" /> {t("modelsConfig.configurationDetails")}
          </span>
        }
      >
        <FormField label={t("modelsConfig.providerName")} required error={renameV.error}>
          <TextInput
            value={editingName}
            onChange={(v) => { setEditingName(v); renameV.onChange(); }}
            placeholder="provider-name"
            mono
            invalid={Boolean(renameV.error)}
            error={renameV.error}
            onBlurValidate={renameV.onBlur}
          />
        </FormField>
        {trimmedRename !== name && (
          <button
            type="button"
            onClick={() => {
              const err = renameV.onSubmit();
              if (!err) onRename(trimmedRename);
            }}
            style={{
              alignSelf: "flex-start",
              padding: "5px 12px",
              background: "var(--accent-strong)",
              border: "none",
              borderRadius: "var(--radius-control)",
              color: "var(--on-accent)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {t("modelsConfig.rename")}
          </button>
        )}

        <FormField label={t("modelsConfig.baseUrl")} error={baseUrlV.error}>
          <TextInput
            value={provider.baseUrl ?? ""}
            onChange={(v) => { set("baseUrl", v || undefined); baseUrlV.onChange(); }}
            placeholder="https://api.example.com/v1"
            mono
            invalid={Boolean(baseUrlV.error)}
            error={baseUrlV.error}
            onBlurValidate={baseUrlV.onBlur}
          />
        </FormField>

        <FormField
          label={t("modelsConfig.apiKey")}
          hint={<CodeText text={t("modelsConfig.apiKeyHint")} />}
          error={apiKeyV.error}
        >
          <SecretInput
            value={provider.apiKey ?? ""}
            onChange={(v) => { set("apiKey", v || undefined); apiKeyV.onChange(); }}
            placeholder={t("modelsConfig.apiKeyPlaceholder")}
            invalid={Boolean(apiKeyV.error)}
            error={apiKeyV.error}
            onBlurValidate={apiKeyV.onBlur}
            showLabel={t("modelsConfig.showApiKey")}
            hideLabel={t("modelsConfig.hideApiKey")}
          />
        </FormField>

        <FormCheck
          label={t("modelsConfig.noApiKeyRequired")}
          checked={provider.auth === "none"}
          onChange={(v) => {
            set("auth", v ? "none" : undefined);
            if (v) apiKeyV.onChange();
            apiKeyV.onBlur();
          }}
        />

        <FormField label={t("modelsConfig.api")}>
          <FormSelect
            value={provider.api ?? "openai-completions"}
            onChange={(v) => set("api", v)}
            options={API_OPTIONS}
            required
            placeholder={t("modelsConfig.inheritNone")}
          />
        </FormField>
      </FieldGroup>

      {/* Danger Zone */}
      <section style={{ padding: "14px 16px", border: "1px solid color-mix(in srgb, var(--status-error) 25%, transparent)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{t("modelsConfig.removeProvider")}</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{t("modelsConfig.removeProviderDesc", { name })}</div>
        </div>
        <button
          type="button"
          onClick={() => setDeleteOpen(true)}
          style={{
            padding: "6px 12px",
            background: "none",
            border: "1px solid var(--status-error)",
            borderRadius: "var(--radius-control)",
            color: "var(--status-error)",
            cursor: "pointer",
            fontSize: 12,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontWeight: 500,
            flexShrink: 0,
          }}
        >
          <Trash2 size={13} aria-hidden="true" /> {t("modelsConfig.delete")}
        </button>
      </section>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("modelsConfig.deleteProviderTitle", { name })}
        description={t("modelsConfig.deleteProviderBody", { name })}
        confirmLabel={t("modelsConfig.delete")}
        cancelLabel={t("modelsConfig.cancel")}
        danger
        onConfirm={() => {
          setDeleteOpen(false);
          onDelete();
        }}
      />
    </div>
  );
}

// ── Thinking levels editor ────────────────────────────────────────────────────
// Edits omp's `thinking` config: `efforts` lists the enabled levels, and
// `effortMap` overrides the string sent on the wire for a level. When every
// row is Default the config is omitted and omp derives the ladder itself.


function ThinkingEditor({
  value,
  onChange,
}: {
  value: ThinkingConfig | undefined;
  onChange: (v: ThinkingConfig | undefined) => void;
}) {
  const { t } = useI18n();
  const efforts = value?.efforts;
  const effortMap = value?.effortMap ?? {};

  const setLevel = (level: ThinkingLevel, entry: string | null | "omit") => {
    // entry: "omit" → enabled with the default wire value; null → level
    // disabled (excluded from efforts); string → enabled with a custom value.
    const included = new Set<string>(efforts ?? [...THINKING_LEVELS]);
    const map: Record<string, string> = { ...effortMap };
    if (entry === null) {
      included.delete(level);
      delete map[level];
    } else {
      included.add(level);
      if (entry === "omit") delete map[level];
      else map[level] = entry;
    }
    const ordered = THINKING_LEVELS.filter((l) => included.has(l));
    if (ordered.length === 0 || (ordered.length === THINKING_LEVELS.length && Object.keys(map).length === 0)) {
      onChange(undefined);
      return;
    }
    onChange({
      ...(value ?? {}),
      mode: value?.mode ?? "effort",
      efforts: ordered,
      effortMap: Object.keys(map).length ? map : undefined,
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {THINKING_LEVELS.map((level) => {
        const disabled = efforts !== undefined && !efforts.includes(level);
        const raw = disabled ? null : effortMap[level];
        const state: "omit" | "null" | "string" =
          disabled ? "null" : typeof raw === "string" ? "string" : "omit";
        const strVal = typeof raw === "string" ? raw : "";
        const color = LEVEL_COLORS[level];

        const btnBase: React.CSSProperties = {
          padding: "4px 10px",
          fontSize: 10,
          border: "none",
          cursor: "pointer",
          fontWeight: 400,
          transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
          whiteSpace: "nowrap",
          background: "var(--bg-panel)",
          color: "var(--text-dim)",
        };
        const btnActive: React.CSSProperties = {
          background: "var(--accent-strong)",
          color: "var(--on-accent)",
          fontWeight: 600,
        };
        const btnActiveDisabled: React.CSSProperties = {
          background: "var(--status-error)",
          color: "var(--on-accent)",
          fontWeight: 600,
        };

        return (
          <div
            key={level}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "5px 4px",
              borderRadius: 6,
              background: "transparent",
              border: "1px solid transparent",
            }}
          >
            {/* Level badge */}
            <div style={{ display: "flex", alignItems: "center", gap: 5, width: 68, flexShrink: 0 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0, opacity: state === "null" ? 0.3 : 1 }} />
              <span style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: state === "null" ? "var(--text-dim)" : "var(--text-muted)",
                textDecoration: state === "null" ? "line-through" : "none",
              }}>
                {level}
              </span>
            </div>

            {/* Default + Disabled buttons */}
            <div style={{ display: "flex", borderRadius: 5, border: "1px solid var(--border)", overflow: "hidden", flexShrink: 0 }}>
              <button
                onClick={() => setLevel(level, "omit")}
                style={{ ...btnBase, ...(state === "omit" ? btnActive : {}) }}
              >
                {t("modelsConfig.default")}
              </button>
              <button
                onClick={() => setLevel(level, null)}
                style={{ ...btnBase, borderLeft: "1px solid var(--border)", ...(state === "null" ? btnActiveDisabled : {}) }}
              >
                {t("modelsConfig.disabled")}
              </button>
            </div>

            {/* Custom button + input fused */}
            <div style={{ display: "flex", borderRadius: 5, border: `1px solid ${state === "string" ? "var(--accent)" : "var(--border)"}`, overflow: "hidden", transition: "border-color var(--dur-fast) var(--ease-out-warm)" }}>
              <button
                onClick={() => setLevel(level, strVal || level)}
                style={{ ...btnBase, ...(state === "string" ? btnActive : {}), borderRight: "1px solid var(--border)", flexShrink: 0 }}
              >
                {t("modelsConfig.custom")}
              </button>
              <input
                value={strVal}
                onChange={(e) => setLevel(level, e.target.value)}
                onFocus={() => { if (state !== "string") setLevel(level, strVal || level); }}
                placeholder={level}
                maxLength={10}
                style={{
                  width: "12ch",
                  background: state === "string" ? "var(--bg)" : "var(--bg-panel)",
                  border: "none",
                  outline: "none",
                  color: state === "string" ? "var(--text)" : "var(--text-dim)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  padding: "4px 7px",
                  transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Model detail ──────────────────────────────────────────────────────────────


function ModelDetail({
  providerName,
  provider,
  model,
  onChange,
  onDelete,
}: {
  providerName: string;
  provider: ProviderEntry;
  model: ModelEntry;
  onChange: (m: ModelEntry) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const [testState, setTestState] = useState<ModelTestState>({ phase: "idle" });
  const [removeOpen, setRemoveOpen] = useState(false);
  const set = <K extends keyof ModelEntry>(k: K, v: ModelEntry[K]) => onChange({ ...model, [k]: v });
  const costVal = (k: keyof NonNullable<ModelEntry["cost"]>) => model.cost?.[k] !== undefined ? String(model.cost[k]) : "";
  const setCost = (k: keyof NonNullable<ModelEntry["cost"]>, v: string) => {
    const n = parseFloat(v);
    onChange({ ...model, cost: { ...(model.cost ?? {}), [k]: isNaN(n) ? undefined : n } });
  };
  const idValidate = () => (!model.id.trim() ? t("modelsConfig.errorIdRequired") : null);
  const idV = useFieldValidation(idValidate);
  const testSummary = (() => {
    if (testState.phase === "idle") return null;
    if (testState.phase === "testing") return t("modelsConfig.validatingConfig");
    const meta = [
      testState.latencyMs !== undefined ? `${testState.latencyMs}ms` : null,
      testState.status !== undefined ? `HTTP ${testState.status}` : null,
    ].filter(Boolean);
    if (testState.phase === "success") {
      return [t("modelsConfig.ok"), ...meta, testState.responseText || null].filter(Boolean).join(" · ");
    }
    return [t("modelsConfig.failed"), ...meta, testState.message].filter(Boolean).join(" · ");
  })();

  useEffect(() => {
    setTestState({ phase: "idle" });
  }, [providerName, provider.baseUrl, provider.api, provider.apiKey, model.id, model.api]);

  const handleTest = useCallback(async () => {
    if (!model.id.trim() || testState.phase === "testing") return;
    setTestState({ phase: "testing" });
    try {
      const res = await fetch("/api/models-config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerName, provider, model }),
      });
      const d = await res.json() as {
        ok?: boolean;
        error?: string;
        code?: string;
        latencyMs?: number;
        status?: number;
        responseText?: string;
      };
      if (!res.ok || !d.ok) {
        setTestState({
          phase: "error",
          message: d.error || d.code ? formatApiError(d) : `HTTP ${res.status}`,
          latencyMs: d.latencyMs,
          status: d.status,
        });
        return;
      }
      setTestState({
        phase: "success",
        latencyMs: d.latencyMs,
        status: d.status,
        responseText: d.responseText,
      });
    } catch (e) {
      setTestState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [model, provider, providerName, testState.phase]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <FieldGroup
        label={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <Cpu size={11} aria-hidden="true" /> {t("modelsConfig.model")}
          </span>
        }
      >
        <div className="model-detail-grid-2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <FormField label={t("modelsConfig.idRequired")} required error={idV.error}>
            <TextInput
              value={model.id}
              onChange={(v) => { set("id", v); idV.onChange(); }}
              placeholder="model-id"
              mono
              invalid={Boolean(idV.error)}
              error={idV.error}
              onBlurValidate={idV.onBlur}
            />
          </FormField>
          <FormField label={t("modelsConfig.name")}>
            <TextInput
              value={model.name ?? ""}
              onChange={(v) => set("name", v || undefined)}
              placeholder={t("modelsConfig.displayNamePlaceholder")}
            />
          </FormField>
        </div>

        <FormField label={t("modelsConfig.apiOverride")}>
          <FormSelect
            value={model.api ?? ""}
            onChange={(v) => set("api", v || undefined)}
            options={API_OPTIONS}
            placeholder={t("modelsConfig.inheritNone")}
          />
        </FormField>

        <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
          <FormCheck
            label={t("modelsConfig.reasoningThinking")}
            checked={model.reasoning ?? false}
            onChange={(v) => set("reasoning", v || undefined)}
          />
          <FormCheck
            label={t("modelsConfig.imageInput")}
            checked={model.input?.includes("image") ?? false}
            onChange={(v) => set("input", v ? ["text", "image"] : undefined)}
          />
        </div>
      </FieldGroup>

      {model.reasoning && (
        <FieldGroup
          label={
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <Sparkles size={11} aria-hidden="true" /> {t("modelsConfig.thinkingLevels")}
            </span>
          }
        >
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            {model.thinking && (
              <button
                type="button"
                onClick={() => set("thinking", undefined)}
                style={{
                  fontSize: 10,
                  padding: "3px 9px",
                  background: "none",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-control)",
                  color: "var(--text-dim)",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <RefreshCw size={10} aria-hidden="true" /> {t("modelsConfig.resetToAuto")}
              </button>
            )}
          </div>
          <ThinkingEditor
            value={model.thinking}
            onChange={(v) => set("thinking", v)}
          />
        </FieldGroup>
      )}

      <FieldGroup label={t("modelsConfig.tokenLimits")}>
        <div className="model-detail-grid-2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <FormField label={t("modelsConfig.contextWindowTokens")}>
            <NumInput
              value={model.contextWindow !== undefined ? String(model.contextWindow) : ""}
              onChange={(v) => set("contextWindow", v ? parseInt(v) : undefined)}
              placeholder="128000"
            />
          </FormField>
          <FormField label={t("modelsConfig.maxOutputTokens")}>
            <NumInput
              value={model.maxTokens !== undefined ? String(model.maxTokens) : ""}
              onChange={(v) => set("maxTokens", v ? parseInt(v) : undefined)}
              placeholder="16384"
            />
          </FormField>
        </div>
      </FieldGroup>

      <FieldGroup label={t("modelsConfig.costPerMillion")}>
        <div className="model-detail-grid-4" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
          {(["input", "output", "cacheRead", "cacheWrite"] as const).map((k) => (
            <FormField key={k} label={t(COST_LABEL_KEYS[k])}>
              <NumInput value={costVal(k)} onChange={(v) => setCost(k, v)} placeholder="0" />
            </FormField>
          ))}
        </div>
      </FieldGroup>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        {testSummary && (
          <span
            title={testSummary}
            style={{
              maxWidth: 360,
              padding: "4px 10px",
              border: `1px solid ${
                testState.phase === "error"
                  ? "color-mix(in srgb, var(--accent) 30%, transparent)"
                  : testState.phase === "success"
                    ? "color-mix(in srgb, var(--accent) 25%, transparent)"
                    : "var(--border)"
              }`,
              borderRadius: "var(--radius-control)",
              background:
                testState.phase === "error"
                  ? "color-mix(in srgb, var(--accent) 10%, var(--bg-panel))"
                  : testState.phase === "success"
                    ? "color-mix(in srgb, var(--accent) 8%, var(--bg-panel))"
                    : "var(--bg-panel)",
              color:
                testState.phase === "error" || testState.phase === "success"
                  ? "var(--text)"
                  : "var(--text-muted)",
              fontSize: 11,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {testState.phase === "success" ? <CheckIcon size={11} aria-hidden="true" /> : null}
            {testState.phase === "error" ? <AlertCircle size={11} aria-hidden="true" /> : null}
            {testSummary}
          </span>
        )}
        <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
          <button
            type="button"
            onClick={handleTest}
            disabled={!model.id.trim() || testState.phase === "testing"}
            title={t("modelsConfig.testTitle")}
            style={{
              padding: "5px 12px",
              background: testState.phase === "success" ? "color-mix(in srgb, var(--accent) 18%, var(--bg-panel))" : "none",
              border: `1px solid ${
                testState.phase === "success"
                  ? "color-mix(in srgb, var(--accent) 30%, transparent)"
                  : "var(--border)"
              }`,
              borderRadius: "var(--radius-control)",
              color:
                testState.phase === "success"
                  ? "var(--accent)"
                  : !model.id.trim() || testState.phase === "testing"
                    ? "var(--text-dim)"
                    : "var(--text-muted)",
              cursor: !model.id.trim() || testState.phase === "testing" ? "not-allowed" : "pointer",
              fontSize: 11,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 5,
            }}
          >
            {testState.phase === "success" && <CheckIcon size={11} aria-hidden="true" />}
            {testState.phase === "testing"
              ? t("modelsConfig.testing")
              : testState.phase === "success"
                ? t("modelsConfig.ok")
                : t("modelsConfig.test")}
          </button>
          <button
            type="button"
            onClick={() => setRemoveOpen(true)}
            style={{
              padding: "5px 12px",
              background: "none",
              border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
              borderRadius: "var(--radius-control)",
              color: "var(--accent)",
              cursor: "pointer",
              fontSize: 11,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <Trash2 size={11} aria-hidden="true" /> {t("modelsConfig.remove")}
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={t("modelsConfig.removeModelTitle", { id: model.id })}
        description={t("modelsConfig.removeModelBody", { id: model.id })}
        confirmLabel={t("modelsConfig.remove")}
        cancelLabel={t("modelsConfig.cancel")}
        danger
        onConfirm={() => {
          setRemoveOpen(false);
          onDelete();
        }}
      />
    </div>
  );
}

// ── OAuth detail ──────────────────────────────────────────────────────────────

function OAuthDetail({ provider, onRefresh }: { provider: OAuthProvider; onRefresh: () => void }) {
  const { t, tn } = useI18n();
  const [loginState, setLoginState] = useState<OAuthLoginState>({ phase: "idle" });
  const [inputValue, setInputValue] = useState("");
  const eventSourceRef = useRef<EventSource | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (loginState.phase === "auth" || loginState.phase === "prompt") {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [loginState.phase]);

  // Reset state when provider changes
  useEffect(() => {
    setLoginState({ phase: "idle" });
    setInputValue("");
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, [provider.id]);

  useEffect(() => {
    return () => { eventSourceRef.current?.close(); };
  }, []);

  const handleLogin = useCallback(() => {
    eventSourceRef.current?.close();
    setLoginState({ phase: "connecting" });
    setInputValue("");

    const es = new EventSource(`/api/auth/login/${encodeURIComponent(provider.id)}`);
    eventSourceRef.current = es;

    es.onmessage = (e) => {
      let data: {
        type: string; url?: string; instructions?: string | null;
        token?: string; message?: string; placeholder?: string | null;
        userCode?: string; verificationUri?: string; intervalSeconds?: number | null; expiresInSeconds?: number | null;
        options?: { id: string; label: string }[];
      };
      try {
        data = JSON.parse(e.data) as typeof data;
      } catch {
        // Malformed frame: ignore rather than killing the handler.
        return;
      }
      if (data.type === "auth") {
        setLoginState({ phase: "auth", url: data.url!, instructions: data.instructions ?? null, token: data.token! });
        if (isSafeExternalUrl(data.url)) window.open(data.url, "_blank", "noopener,noreferrer");
      } else if (data.type === "device_code") {
        setLoginState({
          phase: "device_code",
          userCode: data.userCode!,
          verificationUri: data.verificationUri!,
          intervalSeconds: data.intervalSeconds ?? null,
          expiresInSeconds: data.expiresInSeconds ?? null,
        });
        if (isSafeExternalUrl(data.verificationUri)) window.open(data.verificationUri, "_blank", "noopener,noreferrer");
      } else if (data.type === "prompt_request") {
        setLoginState({ phase: "prompt", message: data.message!, placeholder: data.placeholder ?? null, token: data.token! });
      } else if (data.type === "select_request") {
        setLoginState({ phase: "select", message: data.message!, options: data.options ?? [], token: data.token! });
      } else if (data.type === "progress") {
        setLoginState({ phase: "progress", message: data.message! });
      } else if (data.type === "success") {
        es.close();
        setLoginState({ phase: "success" });
        onRefresh();
      } else if (data.type === "error") {
        es.close();
        setLoginState({ phase: "error", message: data.message! });
      } else if (data.type === "cancelled") {
        es.close();
        setLoginState({ phase: "idle" });
      }
    };
    es.onerror = () => {
      es.close();
      setLoginState((prev) => prev.phase === "success" ? prev : { phase: "error", message: t("modelsConfig.connectionLost") });
    };
  }, [provider.id, onRefresh, t]);

  const handleLogout = useCallback(async () => {
    try {
      const res = await fetch(`/api/auth/logout/${encodeURIComponent(provider.id)}`, { method: "POST" });
      const d = await res.json().catch(() => ({})) as { error?: string; code?: string };
      if (!res.ok || d.error) {
        // omp has no logout RPC/CLI surface; the route returns 501 with guidance.
        setLoginState({ phase: "error", message: d.error || d.code ? formatApiError(d) : `HTTP ${res.status}` });
        return;
      }
      setLoginState({ phase: "idle" });
      onRefresh();
    } catch (e) {
      setLoginState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [provider.id, onRefresh]);

  const submitCode = useCallback(async (token: string, code: string) => {
    if (!code.trim()) return;
    setLoginState({ phase: "progress", message: t("modelsConfig.verifying") });
    try {
      const res = await fetch(`/api/auth/login/${encodeURIComponent(provider.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, code: code.trim() }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string; code?: string };
        setLoginState({ phase: "error", message: d.error || d.code ? formatApiError(d) : t("modelsConfig.serverError", { status: res.status }) });
        return;
      }
      setInputValue("");
      // Success path: SSE stream will emit "success" and update state
    } catch (e) {
      setLoginState({ phase: "error", message: e instanceof Error ? e.message : t("modelsConfig.networkError") });
    }
  }, [provider.id, t]);

  const submitSelection = useCallback(async (token: string, value: string) => {
    setLoginState({ phase: "progress", message: t("modelsConfig.continuing") });
    try {
      const res = await fetch(`/api/auth/login/${encodeURIComponent(provider.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, code: value }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string; code?: string };
        setLoginState({ phase: "error", message: d.error || d.code ? formatApiError(d) : t("modelsConfig.serverError", { status: res.status }) });
      }
    } catch (e) {
      setLoginState({ phase: "error", message: e instanceof Error ? e.message : t("modelsConfig.networkError") });
    }
  }, [provider.id, t]);

  const isWorking = loginState.phase === "connecting" || loginState.phase === "progress" ||
    loginState.phase === "auth" || loginState.phase === "device_code" ||
    loginState.phase === "prompt" || loginState.phase === "select";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>{t("modelsConfig.subscription")}</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: provider.loggedIn ? "var(--status-success)" : "var(--border)", display: "inline-block" }} />
          <span style={{ fontSize: 11, color: provider.loggedIn ? "var(--status-success)" : "var(--text-dim)" }}>
            {provider.loggedIn ? t("modelsConfig.connected") : t("modelsConfig.notConnected")}
          </span>
        </div>
      </div>

      {/* Status */}
      <div style={{ minHeight: 48 }}>
        {loginState.phase === "idle" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
            {provider.loggedIn ? t("modelsConfig.alreadyConnected") : t("modelsConfig.connectAccount", { name: provider.name })}
          </p>
        )}
        {loginState.phase === "connecting" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{t("modelsConfig.openingBrowser")}</p>
        )}
        {loginState.phase === "select" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {loginState.message}
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {loginState.options.map((option) => (
                <button
                  key={option.id}
                  onClick={() => submitSelection(loginState.token, option.id)}
                  style={{ padding: "6px 9px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", cursor: "pointer", fontSize: 12, textAlign: "left" }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {(loginState.phase === "auth" || loginState.phase === "prompt") && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {loginState.phase === "auth"
                ? t("modelsConfig.completeSignIn")
                : loginState.message}
            </p>
            {loginState.phase === "auth" && (
              <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
                <a href={loginState.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", wordBreak: "break-all" }}>
                  {t("modelsConfig.browserNotOpened")}
                </a>
              </p>
            )}
            <div style={{ display: "flex", gap: 6 }}>
              <input
                ref={inputRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submitCode(loginState.token, inputValue); }}
                placeholder={loginState.phase === "auth" ? "http://localhost:1455/auth/callback?code=…" : (loginState.placeholder ?? t("modelsConfig.enterValue"))}
                style={{ flex: 1, padding: "6px 9px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", fontSize: 12, outline: "none", fontFamily: "var(--font-mono)", boxSizing: "border-box" }}
              />
              <button
                onClick={() => submitCode(loginState.token, inputValue)}
                disabled={!inputValue.trim()}
                style={{ padding: "6px 12px", background: inputValue.trim() ? "var(--accent-strong)" : "var(--bg-panel)", border: "none", borderRadius: 5, color: inputValue.trim() ? "var(--on-accent)" : "var(--text-dim)", cursor: inputValue.trim() ? "pointer" : "not-allowed", fontSize: 12, fontWeight: 600, flexShrink: 0 }}
              >
                {t("modelsConfig.submit")}
              </button>
            </div>
          </div>
        )}
        {loginState.phase === "device_code" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {t("modelsConfig.deviceCodeInstructions")}
            </p>
            <div style={{ padding: "8px 10px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", fontSize: 16, fontWeight: 700, fontFamily: "var(--font-mono)", letterSpacing: 0 }}>
              {loginState.userCode}
            </div>
            <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
              <a href={loginState.verificationUri} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", wordBreak: "break-all" }}>
                {loginState.verificationUri}
              </a>
              {loginState.expiresInSeconds ? " " + tn("modelsConfig.expiresInMinutes", Math.ceil(loginState.expiresInSeconds / 60)) : ""}
            </p>
          </div>
        )}
        {loginState.phase === "progress" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{loginState.message}</p>
        )}
        {loginState.phase === "success" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--status-success)" }}>{t("modelsConfig.connectedSuccessfully")}</p>
        )}
        {loginState.phase === "error" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--status-error)" }}>{loginState.message}</p>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8 }}>
        {isWorking ? (
          <button
            onClick={() => { eventSourceRef.current?.close(); setLoginState({ phase: "idle" }); }}
            style={{ padding: "5px 12px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}
          >
            {t("modelsConfig.cancel")}
          </button>
        ) : (
          <>
            <button
              onClick={handleLogin}
              style={{ padding: "5px 14px", background: "var(--accent-strong)", border: "none", borderRadius: 5, color: "var(--on-accent)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
            >
              {provider.loggedIn ? t("modelsConfig.relogin") : t("modelsConfig.login")}
            </button>
            {provider.loggedIn && (
              <button
                onClick={handleLogout}
                style={{ padding: "5px 12px", background: "none", border: "1px solid color-mix(in srgb, var(--status-error) 30%, transparent)", borderRadius: 5, color: "var(--status-error)", cursor: "pointer", fontSize: 12 }}
              >
                {t("modelsConfig.disconnect")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}





// ── Main component ────────────────────────────────────────────────────────────

export function ModelsConfig({ onClose, onSelectTab, onSaved, embedded = false }: { onClose: () => void; onSelectTab?: (tab: SettingsTab) => void; onSaved?: () => void; embedded?: boolean }) {
  const { t, tn } = useI18n();
  const isMobile = useIsMobile();
  const [config, setConfig] = useState<ModelsFileData>({ providers: {} });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const [subTab, setSubTab] = useState<"connected" | "custom" | "system">("connected");
  const [systemTab, setSystemTab] = useState<"registry" | "picker" | "roles" | "fallbacks">("registry");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [oauthProviders, setOauthProviders] = useState<OAuthProvider[]>([]);
  const [apiKeyProviders, setApiKeyProviders] = useState<ApiKeyProvider[]>([]);
  const [runtimeModels, setRuntimeModels] = useState<RuntimeModelEntry[]>([]);
  const [connectedProviders, setConnectedProviders] = useState<ConnectedProvider[]>([]);
  const [runtimeModelsLoading, setRuntimeModelsLoading] = useState(true);
  const [connectSearch, setConnectSearch] = useState("");
  const [visibleModelKeys, setVisibleModelKeys] = useState<Set<string> | null>(null);
  const [composerPickerSearch, setComposerPickerSearch] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  // Provider name whose catalog picker is open (null = closed).
  const [catalogPicker, setCatalogPicker] = useState<string | null>(null);
  // Set when models.yml is on disk but unparseable: the editor shows the error
  // instead of an empty form, and saving stays blocked so the hand-written file
  // is never overwritten with nothing.
  const [parseError, setParseError] = useState<{ message: string; path?: string } | null>(null);

  const loadOAuthProviders = useCallback(() => {
    fetch("/api/auth/providers")
      .then((r) => r.json())
      .then((d: { providers?: OAuthProvider[] }) => {
        if (Array.isArray(d.providers)) setOauthProviders(d.providers);
      })
      .catch(() => {});
  }, []);

  const loadApiKeyProviders = useCallback(() => {
    fetch("/api/auth/all-providers")
      .then((r) => r.json())
      .then((d: { providers?: ApiKeyProvider[] }) => {
        if (Array.isArray(d.providers)) setApiKeyProviders(d.providers);
      })
      .catch(() => {});
  }, []);

  const loadRuntimeModels = useCallback(async () => {
    setRuntimeModelsLoading(true);
    try {
      const response = await fetch("/api/models", { cache: "no-store" });
      const data = response.ok ? await response.json() as { modelList?: RuntimeModelEntry[]; connectedProviders?: ConnectedProvider[] } : null;
      setRuntimeModels(data?.modelList ?? []);
      setConnectedProviders(data?.connectedProviders ?? []);
    } catch {
      setRuntimeModels([]);
      setConnectedProviders([]);
    } finally {
      setRuntimeModelsLoading(false);
    }
  }, []);

  const loadConfig = useCallback(() => {
    setLoading(true);
    fetch("/api/models-config")
      .then((r) => r.json())
      .then((d: ModelsFileData & { parseError?: string; code?: string; path?: string }) => {
        if (d.parseError) {
          setParseError({ message: d.parseError, path: d.path });
          setConfig({ providers: {} });
          setSelection(null);
          return;
        }
        setParseError(null);
        const normalized = d.providers ? d : { ...d, providers: {} };
        setConfig(normalized);
        const keys = Object.keys(normalized.providers ?? {});
        if (!embedded && keys.length > 0) setSelection({ type: "provider", name: keys[0] });
      })
      .catch(() => setConfig({ providers: {} }))
      .finally(() => setLoading(false));
  }, [embedded]);

  useEffect(() => {
    loadConfig();
    loadOAuthProviders();
    loadApiKeyProviders();
    loadRuntimeModels();
  }, [loadConfig, loadOAuthProviders, loadApiKeyProviders, loadRuntimeModels]);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(COMPOSER_MODELS_STORAGE_KEY) ?? "null");
      if (Array.isArray(stored)) setVisibleModelKeys(new Set(stored.filter((item): item is string => typeof item === "string")));
    } catch {
      // Invalid UI-only preferences fall back to showing all native runtime models.
    }
  }, []);

  useEffect(() => {
    if (visibleModelKeys === null) return;
    try {
      localStorage.setItem(COMPOSER_MODELS_STORAGE_KEY, JSON.stringify([...visibleModelKeys]));
      window.dispatchEvent(new Event("omp-composer-models-change"));
    } catch {
      // Storage is optional UI state; a disabled or full store must not break settings.
    }
  }, [visibleModelKeys]);

  const setComposerModelVisible = useCallback((model: RuntimeModelEntry, visible: boolean) => {
    setVisibleModelKeys((current) => {
      const next = new Set(current ?? runtimeModels.map((entry) => `${entry.provider}:${entry.id}`));
      const key = `${model.provider}:${model.id}`;
      if (visible) next.add(key); else next.delete(key);
      return next;
    });
  }, [runtimeModels]);

  const setComposerProviderVisible = useCallback((provider: string, visible: boolean) => {
    setVisibleModelKeys((current) => {
      const next = new Set(current ?? runtimeModels.map((entry) => `${entry.provider}:${entry.id}`));
      for (const model of runtimeModels) {
        if (model.provider !== provider) continue;
        const key = `${model.provider}:${model.id}`;
        if (visible) next.add(key); else next.delete(key);
      }
      return next;
    });
  }, [runtimeModels]);


  const enableConnectedProvider = useCallback(async (provider: string) => {
    const response = await fetch("/api/providers/enable", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider }) });
    const data = await response.json() as { error?: string };
    if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
    await loadRuntimeModels();
  }, [loadRuntimeModels]);

  const addCustomProvider = useCallback(() => {
    let finalName = "new-provider";
    let n = 1;
    while (config.providers?.[finalName]) finalName = `new-provider-${n++}`;
    setConfig((prev) => ({ ...prev, providers: { ...(prev.providers ?? {}), [finalName]: { api: "openai-completions" } } }));
    setSelection({ type: "provider", name: finalName });
  }, [config.providers]);

  const updateProvider = useCallback((name: string, p: ProviderEntry) => {
    setConfig((prev) => ({ ...prev, providers: { ...(prev.providers ?? {}), [name]: p } }));
  }, []);

  const renameProvider = useCallback((oldName: string, newName: string) => {
    setConfig((prev) => {
      const entries = Object.entries(prev.providers ?? {});
      const idx = entries.findIndex(([k]) => k === oldName);
      if (idx === -1) return prev;
      entries[idx] = [newName, entries[idx][1]];
      return { ...prev, providers: Object.fromEntries(entries) };
    });
    setSelection((prev) => {
      if (!prev) return prev;
      if (prev.type === "provider" && prev.name === oldName) return { type: "provider", name: newName };
      if (prev.type === "model" && prev.providerName === oldName) return { ...prev, providerName: newName };
      return prev;
    });
  }, []);

  const deleteProvider = useCallback((name: string) => {
    setConfig((prev) => {
      const providers = { ...(prev.providers ?? {}) };
      delete providers[name];
      return { ...prev, providers };
    });
    setConfig((prev) => {
      const remaining = Object.keys(prev.providers ?? {});
      setSelection(remaining.length > 0 ? { type: "provider", name: remaining[0] } : null);
      return prev;
    });
  }, []);

  const addModel = useCallback((providerName: string) => {
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? []), { id: "" }];
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models } } };
    });
    setConfig((prev) => {
      const idx = (prev.providers?.[providerName]?.models?.length ?? 1) - 1;
      setSelection({ type: "model", providerName, index: idx });
      return prev;
    });
  }, []);

  const addModelFromCatalog = useCallback((providerName: string, model: ModelEntry, baseUrl?: string) => {
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? []), model];
      const next: ProviderEntry = { ...provider, models };
      if (baseUrl && !provider.baseUrl) next.baseUrl = baseUrl;
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: next } };
    });
    setConfig((prev) => {
      const idx = (prev.providers?.[providerName]?.models?.length ?? 1) - 1;
      setSelection({ type: "model", providerName, index: idx });
      return prev;
    });
    setCatalogPicker(null);
  }, []);

  const updateModel = useCallback((providerName: string, index: number, m: ModelEntry) => {
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? [])];
      models[index] = m;
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models } } };
    });
  }, []);

  const removeModel = useCallback((providerName: string, index: number) => {
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? [])];
      models.splice(index, 1);
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models: models.length ? models : undefined } } };
    });
    setSelection({ type: "provider", name: providerName });
  }, []);

  const handleSave = useCallback(async () => {
    if (parseError) return;
    setSaving(true);
    setSaveError(null);
    setSavedOk(false);
    try {
      const saveableConfig = omitUntouchedModelDrafts(config);
      const res = await fetch("/api/models-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(saveableConfig),
      });
      const d = await res.json() as { success?: boolean; error?: string; code?: string };
      if (!res.ok || d.error) {
        const msg = d.error || d.code ? formatApiError(d) : `HTTP ${res.status}`;
        setSaveError(msg);
        toast.error(t("modelsConfig.saveErrorTitle"), msg);
        // The file became unparseable after it was loaded — the server refused
        // the write, so switch the editor into the same blocked state.
        if (d.code === "models_config_unparseable") setParseError({ message: d.error ?? formatApiError(d) });
      } else {
        // Drop a transient empty model row after its provider edit is persisted.
        loadConfig();
        await loadRuntimeModels();
        loadApiKeyProviders();
        onSaved?.();
        setSavedOk(true);
        setTimeout(() => setSavedOk(false), 2000);
        toast.success(t("modelsConfig.saveSuccessTitle"));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSaveError(msg);
      toast.error(t("modelsConfig.saveErrorTitle"), msg);
    } finally {
      setSaving(false);
    }
  }, [config, loadApiKeyProviders, loadConfig, loadRuntimeModels, onSaved, parseError, t]);

  const providers = Object.entries(config.providers ?? {});
  const activeOAuth = oauthProviders.filter((p) => p.loggedIn);
  const activeApiKey = apiKeyProviders.filter((p) => p.configured);
  const runtimeModelsByProvider = runtimeModels.reduce<Record<string, RuntimeModelEntry[]>>((groups, model) => {
    (groups[model.provider] ??= []).push(model);
    return groups;
  }, {});

  // Resolve current detail
  const detailContent = (() => {
    if (!selection) return null;
    if (selection.type === "oauth") {
      const p = oauthProviders.find((p) => p.id === selection.providerId);
      if (!p) return null;
      return <OAuthDetail key={p.id} provider={p} onRefresh={() => { loadOAuthProviders(); loadApiKeyProviders(); void loadRuntimeModels(); }} />;
    }
    if (selection.type === "apikey") {
      const p = apiKeyProviders.find((p) => p.id === selection.providerId);
      if (!p) return null;
      return <ApiKeyDetail key={p.id} provider={p} />;
    }
    if (selection.type === "roles") return <ModelRolesDetail models={runtimeModels} />;
    if (selection.type === "registry") return <NativeRegistryDetail models={runtimeModels} connectedProviders={connectedProviders} onChanged={loadRuntimeModels} />;
    if (selection.type === "fallbacks") return <RetryFallbackDetail models={runtimeModels} />;
    if (selection.type === "picker") {
      const pickerQuery = composerPickerSearch.trim().toLowerCase();
      const matchesPicker = (model: RuntimeModelEntry) =>
        !pickerQuery ||
        model.id.toLowerCase().includes(pickerQuery) ||
        (model.name ?? "").toLowerCase().includes(pickerQuery) ||
        model.provider.toLowerCase().includes(pickerQuery);
      const filteredProviders = Object.entries(runtimeModelsByProvider)
        .map(([provider, models]) => [provider, models.filter(matchesPicker)] as const)
        .filter(([, models]) => models.length > 0);
      const totalVisible = runtimeModels.filter((m) => visibleModelKeys === null || visibleModelKeys.has(`${m.provider}:${m.id}`)).length;
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "14px 16px", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", boxShadow: "var(--shadow-card)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
              <div>
                <SectionTitle>{t("modelsConfig.composerPickerTitle")}</SectionTitle>
                <p style={{ margin: "6px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>{t("modelsConfig.composerPickerDesc")}</p>
              </div>
              {/* Refresh OMP runtime models */}
              <button type="button" onClick={() => void loadRuntimeModels()} disabled={runtimeModelsLoading} title={t("modelsConfig.refreshRuntimeModels")} style={{ padding: 7, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text-muted)", cursor: runtimeModelsLoading ? "wait" : "pointer", flexShrink: 0 }}><RefreshCw size={14} aria-hidden="true" /></button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 10, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text-muted)", fontWeight: 600 }}>{t("modelsConfig.modelsVisible", { visible: totalVisible, total: runtimeModels.length })}</span>
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>·</span>
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{tn("modelsConfig.providerCount", Object.keys(runtimeModelsByProvider).length)}</span>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", cursor: "text" }}>
              <Search size={14} aria-hidden="true" style={{ color: "var(--text-dim)", flexShrink: 0 }} />
              <input
                value={composerPickerSearch}
                onChange={(e) => setComposerPickerSearch(e.target.value)}
                placeholder={t("modelsConfig.filterModelsPlaceholder")}
                style={{ flex: 1, minWidth: 0, background: "none", border: "none", outline: "none", color: "var(--text)", fontSize: 12 }}
              />
              {composerPickerSearch && (
                <button type="button" onClick={() => setComposerPickerSearch("")} style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 2px" }} aria-label={t("modelsConfig.clearFilter")}>×</button>
              )}
            </label>
          </div>
          {runtimeModelsLoading ? <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{t("modelsConfig.loadingRuntimeModels")}</div> : filteredProviders.length === 0 ? (
            <div style={{ padding: "24px 16px", border: "1px dashed var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>
              {pickerQuery ? t("modelsConfig.noModelsMatch", { query: composerPickerSearch }) : t("modelsConfig.noReportedModels")}
            </div>
          ) : filteredProviders.map(([provider, models]) => {
            const providerVisible = models.every((model) => visibleModelKeys === null || visibleModelKeys.has(`${model.provider}:${model.id}`));
            const providerSomeVisible = models.some((model) => visibleModelKeys === null || visibleModelKeys.has(`${model.provider}:${model.id}`));
            return <section key={provider} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", overflow: "hidden", background: "var(--bg-panel)", boxShadow: "var(--shadow-card)" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 12px", background: "var(--bg)", borderBottom: "1px solid var(--border)", color: "var(--text)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                <input type="checkbox" checked={providerVisible} ref={(input) => { if (input) input.indeterminate = providerSomeVisible && !providerVisible; }} onChange={(event) => setComposerProviderVisible(provider, event.target.checked)} aria-label={`Show all ${provider} models in composer`} />
                <ProviderIcon id={provider} size={15} />
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{provider}</span>
                <span style={{ color: "var(--text-dim)", fontSize: 11, fontWeight: 500, padding: "2px 7px", borderRadius: 10, background: "var(--bg-subtle)", border: "1px solid var(--border)" }}>{models.length}</span>
              </label>
              <div style={{ display: "flex", flexDirection: "column" }}>
                {models.map((model) => (
                  <label key={`${model.provider}:${model.id}`} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", color: "var(--text)", cursor: "pointer", borderTop: "1px solid var(--border)", background: visibleModelKeys !== null && !visibleModelKeys.has(`${model.provider}:${model.id}`) ? "var(--bg)" : "var(--bg-panel)" }}>
                    <input type="checkbox" checked={visibleModelKeys === null || visibleModelKeys.has(`${model.provider}:${model.id}`)} onChange={(event) => setComposerModelVisible(model, event.target.checked)} aria-label={`Show ${model.provider}/${model.id} in composer`} />
                    <span style={{ minWidth: 0, flex: 1, fontSize: 12, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{model.name || model.id}</span>
                    <code style={{ color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 220 }}>{model.provider}/{model.id}</code>
                  </label>
                ))}
              </div>
            </section>;
          })}
          {!runtimeModelsLoading && connectedProviders.filter((provider) => !runtimeModelsByProvider[provider.id]).map((provider) => (
            <section key={provider.id} style={{ border: "1px dashed var(--border)", borderRadius: "var(--radius-card)", padding: 14, background: "var(--bg-panel)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text)", fontSize: 12, fontWeight: 600 }}><ProviderIcon id={provider.id} size={15} />{provider.name}</div>
              <p style={{ margin: "8px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>{provider.disabled ? t("modelsConfig.connectedDisabledDesc") : t("modelsConfig.connectedNoModelsDesc")}</p>
              {provider.disabled && <button type="button" onClick={() => void enableConnectedProvider(provider.id).catch((error) => toast.error(t("modelsConfig.couldNotEnableProvider"), error instanceof Error ? error.message : String(error)))} style={{ marginTop: 10, padding: "6px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", cursor: "pointer", fontSize: 12 }}>{t("modelsConfig.enableInOmp")}</button>}
            </section>
          ))}
        </div>
      );
    }
    if (selection.type === "provider") {
      const provider = config.providers?.[selection.name];
      if (!provider) return null;
      return (
        <ProviderDetail
          key={selection.name}
          name={selection.name}
          provider={provider}
          onChange={(p) => updateProvider(selection.name, p)}
          onRename={(n) => renameProvider(selection.name, n)}
          onDelete={() => deleteProvider(selection.name)}
        />
      );
    }
    const provider = config.providers?.[selection.providerName];
    const model = provider?.models?.[selection.index];
    if (!model) return null;
    return (
      <ModelDetail
        key={`${selection.providerName}-${selection.index}`}
        providerName={selection.providerName}
        provider={provider}
        model={model}
        onChange={(m) => updateModel(selection.providerName, selection.index, m)}
        onDelete={() => removeModel(selection.providerName, selection.index)}
      />
    );
  })();

  return (
    <>
      <ModelsConfigSurface embedded={embedded} isMobile={isMobile} onClose={onClose}>

        {/* Header */}
        {!embedded && (<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <DialogTitle style={{ fontSize: 16, margin: 0 }}>{t("modelsConfig.title")}</DialogTitle>
            <code style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>~/.omp/agent/models.yml</code>
          </div>
          <button onClick={onClose} aria-label={t("modelsConfig.close")} title={t("modelsConfig.close")} className="ui-focus-ring" style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 20, lineHeight: 1, padding: "4px 8px", minWidth: 28, minHeight: 28, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "var(--radius-control)" }}>×</button>
        </div>)}
        {!embedded && onSelectTab && <SettingsTabs active="models" onSelect={onSelectTab} />}

        {/* Body */}
        {parseError ? (
          <div style={{ flex: 1, overflowY: "auto", padding: 24, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--status-error)" }}>{t("modelsConfig.parseErrorTitle")}</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>{t("modelsConfig.parseErrorBody")}</div>
            {parseError.path && (
              <code style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{parseError.path}</code>
            )}
            <pre style={{
              margin: 0, padding: "10px 12px", background: "var(--bg-panel)", border: "1px solid var(--border)",
              borderRadius: 6, color: "var(--text-muted)", fontSize: 11, fontFamily: "var(--font-mono)",
              whiteSpace: "pre-wrap", wordBreak: "break-word", overflowX: "auto",
            }}>{parseError.message}</pre>
            <button onClick={loadConfig} disabled={loading}
              style={{ alignSelf: "flex-start", padding: "5px 12px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: loading ? "default" : "pointer", fontSize: 12 }}>
              {loading ? t("modelsConfig.loading") : t("modelsConfig.reload")}
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", minHeight: 0, width: "100%" }}>
            {/* Top Sub-navigation Segmented Control + Add Provider Action */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
              <div className="providers-segmented" style={{ marginBottom: 0 }}>
                <button
                  type="button"
                  className={`providers-segmented-btn${subTab === "connected" ? " active" : ""}`}
                  onClick={() => { setSubTab("connected"); setSelection(null); }}
                >
                  <KeyRound size={14} aria-hidden="true" />
                  <span>{t("modelsConfig.connectedAccounts")}</span>
                  {(activeOAuth.length + activeApiKey.length) > 0 && (
                    <span className="providers-count-badge">{activeOAuth.length + activeApiKey.length}</span>
                  )}
                </button>
                <button
                  type="button"
                  className={`providers-segmented-btn${subTab === "custom" ? " active" : ""}`}
                  onClick={() => { setSubTab("custom"); setSelection(null); }}
                >
                  <Cpu size={14} aria-hidden="true" />
                  <span>{t("modelsConfig.customProviders")}</span>
                  {providers.length > 0 && (
                    <span className="providers-count-badge">{providers.length}</span>
                  )}
                </button>
                <button
                  type="button"
                  className={`providers-segmented-btn${subTab === "system" ? " active" : ""}`}
                  onClick={() => { setSubTab("system"); setSelection({ type: systemTab }); }}
                >
                  <Layers size={14} aria-hidden="true" />
                  <span>{t("modelsConfig.ompSystemSection")}</span>
                </button>
              </div>

              {subTab === "connected" && !selection && (
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  className="settings-back"
                  style={{ background: "var(--accent-strong)", color: "var(--on-accent)", border: "1px solid var(--accent-strong)", fontWeight: 600, padding: "7px 16px", flexShrink: 0 }}
                >
                  <Plus size={14} aria-hidden="true" /> {t("modelsConfig.addProvider")}
                </button>
              )}
            </div>

            {/* Sub-tab content */}
            {subTab === "connected" && (
              selection && (selection.type === "oauth" || selection.type === "apikey") ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <button
                    type="button"
                    className="settings-back"
                    onClick={() => setSelection(null)}
                    style={{ alignSelf: "flex-start", marginBottom: 4 }}
                  >
                    <ArrowLeft size={14} aria-hidden="true" />
                    <span>Back to connected accounts</span>
                  </button>
                  {detailContent}
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                  {/* Active OAuth Accounts */}
                  {activeOAuth.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      <div className="settings-group-label" style={{ padding: "8px 2px 2px" }}>Active OAuth Accounts ({activeOAuth.length})</div>
                      <div className="provider-grid">
                        {activeOAuth.map((p) => {
                          const models = runtimeModelsByProvider[p.id] ?? [];
                          return (
                            <div key={p.id} className="provider-grid-card">
                              <div>
                                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                    <ProviderIcon id={p.id} size={28} />
                                    <div>
                                      <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text)" }}>{p.name}</div>
                                      <div style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{p.id}</div>
                                    </div>
                                  </div>
                                  <span className="settings-badge ok" style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", fontSize: 11 }}>
                                    <CheckIcon size={11} aria-hidden="true" /> Connected
                                  </span>
                                </div>

                                {models.length > 0 ? (
                                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 12 }}>
                                    {models.slice(0, 3).map((m) => (
                                      <span key={m.id} style={{ fontSize: 10.5, padding: "2px 6px", borderRadius: 4, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                                        {m.name || m.id}
                                      </span>
                                    ))}
                                    {models.length > 3 && (
                                      <span style={{ fontSize: 10, color: "var(--text-dim)", padding: "2px 4px", alignSelf: "center" }}>
                                        +{models.length - 3} more
                                      </span>
                                    )}
                                  </div>
                                ) : (
                                  <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 10 }}>
                                    OAuth authenticated
                                  </div>
                                )}
                              </div>

                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
                                <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
                                  {models.length > 0 ? `${models.length} active models` : "Ready to use"}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => setSelection({ type: "oauth", providerId: p.id })}
                                  className="settings-back"
                                  style={{ padding: "4px 10px", fontSize: 11.5, border: "1px solid var(--border)", background: "var(--bg)" }}
                                >
                                  Configure
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Active API Key Providers */}
                  {activeApiKey.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      <div className="settings-group-label" style={{ padding: "8px 2px 2px" }}>Configured API Keys ({activeApiKey.length})</div>
                      <div className="provider-grid">
                        {activeApiKey.map((p) => {
                          const models = runtimeModelsByProvider[p.id] ?? [];
                          return (
                            <div key={p.id} className="provider-grid-card">
                              <div>
                                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                    <ProviderIcon id={p.id} size={28} />
                                    <div>
                                      <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text)" }}>{p.displayName}</div>
                                      <div style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{p.id}</div>
                                    </div>
                                  </div>
                                  <span className="settings-badge ok" style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", fontSize: 11 }}>
                                    <CheckIcon size={11} aria-hidden="true" /> Key configured
                                  </span>
                                </div>

                                {models.length > 0 ? (
                                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 12 }}>
                                    {models.slice(0, 3).map((m) => (
                                      <span key={m.id} style={{ fontSize: 10.5, padding: "2px 6px", borderRadius: 4, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                                        {m.name || m.id}
                                      </span>
                                    ))}
                                    {models.length > 3 && (
                                      <span style={{ fontSize: 10, color: "var(--text-dim)", padding: "2px 4px", alignSelf: "center" }}>
                                        +{models.length - 3} more
                                      </span>
                                    )}
                                  </div>
                                ) : (
                                  <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 10 }}>
                                    System key configured
                                  </div>
                                )}
                              </div>

                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
                                <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
                                  {p.modelCount > 0 ? `${p.modelCount} models` : "Key ready"}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => setSelection({ type: "apikey", providerId: p.id })}
                                  className="settings-back"
                                  style={{ padding: "4px 10px", fontSize: 11.5, border: "1px solid var(--border)", background: "var(--bg)" }}
                                >
                                  Manage
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {activeOAuth.length === 0 && activeApiKey.length === 0 && (
                    <div className="settings-empty" style={{ textAlign: "center", padding: "32px 20px" }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>{t("modelsConfig.noConnectedAccounts")}</div>
                      <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginBottom: 16 }}>{t("modelsConfig.addOneBelow")}</div>
                      <button
                        type="button"
                        onClick={() => setPickerOpen(true)}
                        className="settings-back"
                        style={{ background: "var(--accent-strong)", color: "var(--on-accent)", border: "1px solid var(--accent-strong)", fontWeight: 600, padding: "6px 14px", margin: "0 auto" }}
                      >
                        <Plus size={14} aria-hidden="true" /> {t("modelsConfig.addProvider")}
                      </button>
                    </div>
                  )}

                  {/* Connect other providers */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                      <div className="settings-group-label" style={{ padding: 0 }}>Add Provider Integration</div>
                      <div style={{ position: "relative", width: "100%", maxWidth: 320 }}>
                        <Search size={13} aria-hidden="true" style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)", pointerEvents: "none" }} />
                        <input
                          type="text"
                          value={connectSearch}
                          onChange={(e) => setConnectSearch(e.target.value)}
                          placeholder="Search providers to connect..."
                          style={{ width: "100%", height: 28, padding: "0 24px 0 28px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", fontSize: 12, outline: "none" }}
                        />
                        {connectSearch && (
                          <button
                            type="button"
                            onClick={() => setConnectSearch("")}
                            style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}
                          >
                            ×
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Filtered list or curated list */}
                    {(() => {
                      const q = connectSearch.trim().toLowerCase();
                      const unlinkedOAuth = oauthProviders.filter(p => !p.loggedIn);
                      const unconfiguredApiKey = apiKeyProviders.filter(p => !p.configured);
                      const matchingOAuth = unlinkedOAuth.filter(p => !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
                      const matchingApiKey = unconfiguredApiKey.filter(p => !q || p.displayName.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));

                      const displayedOAuth = q ? matchingOAuth : matchingOAuth.slice(0, 6);
                      const displayedApiKey = q ? matchingApiKey : matchingApiKey.slice(0, 6);

                      return (
                        <div className="provider-grid">
                          {displayedOAuth.map((p) => (
                            <div key={p.id} className="provider-grid-card" style={{ minHeight: 90 }}>
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                                  <ProviderIcon id={p.id} size={24} />
                                  <div>
                                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{p.name}</div>
                                    <div style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{p.id}</div>
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => setSelection({ type: "oauth", providerId: p.id })}
                                  className="settings-back"
                                  style={{ padding: "4px 12px", fontSize: 12, border: "1px solid var(--border)", background: "var(--bg)" }}
                                >
                                  Sign in
                                </button>
                              </div>
                            </div>
                          ))}
                          {displayedApiKey.map((p) => (
                            <div key={p.id} className="provider-grid-card" style={{ minHeight: 90 }}>
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                                  <ProviderIcon id={p.id} size={24} />
                                  <div>
                                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{p.displayName}</div>
                                    <div style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>API Key</div>
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => setSelection({ type: "apikey", providerId: p.id })}
                                  className="settings-back"
                                  style={{ padding: "4px 12px", fontSize: 12, border: "1px solid var(--border)", background: "var(--bg)" }}
                                >
                                  Set Key
                                </button>
                              </div>
                            </div>
                          ))}
                          {!q && (unlinkedOAuth.length + unconfiguredApiKey.length > 12) && (
                            <button
                              type="button"
                              onClick={() => setPickerOpen(true)}
                              className="provider-grid-card"
                              style={{ minHeight: 90, alignItems: "center", justifyContent: "center", gap: 6, cursor: "pointer", borderStyle: "dashed", background: "transparent" }}
                            >
                              <Plus size={14} style={{ color: "var(--accent)" }} />
                              <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--text-muted)" }}>
                                Browse all {unlinkedOAuth.length + unconfiguredApiKey.length} providers…
                              </span>
                            </button>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              )
            )}

            {subTab === "custom" && (
              selection && (selection.type === "provider" || selection.type === "model") ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <button
                    type="button"
                    className="settings-back"
                    onClick={() => setSelection(null)}
                    style={{ alignSelf: "flex-start", marginBottom: 4 }}
                  >
                    <ArrowLeft size={14} aria-hidden="true" />
                    <span>Back to custom providers</span>
                  </button>
                  {detailContent}
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{t("modelsConfig.customProviders")}</div>
                      <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 3 }}>
                        Custom endpoints, local Ollama / vLLM models, or reverse proxies defined in <code style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>~/.omp/agent/models.yml</code>.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={addCustomProvider}
                      className="settings-back"
                      style={{ background: "var(--accent-strong)", color: "var(--on-accent)", border: "1px solid var(--accent-strong)", fontWeight: 600, padding: "6px 14px", flexShrink: 0 }}
                    >
                      <Plus size={14} aria-hidden="true" /> Add Provider
                    </button>
                  </div>

                  {providers.length === 0 ? (
                    <div className="settings-empty" style={{ textAlign: "center", padding: "32px 20px" }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>{t("modelsConfig.noCustomProviders")}</div>
                      <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginBottom: 16 }}>{t("modelsConfig.addOpenAiEndpoint")}</div>
                      <div style={{ display: "flex", justifyContent: "center", gap: 8, flexWrap: "wrap" }}>
                        <button
                          type="button"
                          onClick={() => {
                            setConfig((prev) => ({
                              ...prev,
                              providers: {
                                ...(prev.providers ?? {}),
                                ollama: { baseUrl: "http://localhost:11434/v1", api: "openai-completions", auth: "none" },
                              },
                            }));
                            setSelection({ type: "provider", name: "ollama" });
                          }}
                          className="settings-back"
                          style={{ border: "1px solid var(--border)", background: "var(--bg-panel)", padding: "6px 12px" }}
                        >
                          Add Ollama (localhost:11434)
                        </button>
                        <button
                          type="button"
                          onClick={addCustomProvider}
                          className="settings-back"
                          style={{ background: "var(--accent-strong)", color: "var(--on-accent)", border: "1px solid var(--accent-strong)", fontWeight: 600, padding: "6px 12px" }}
                        >
                          <Plus size={14} aria-hidden="true" /> Add Custom Endpoint
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      {providers.map(([pName, pData]) => {
                        const models = pData.models ?? [];
                        return (
                          <div key={pName} className="settings-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <ProviderIcon id={pName} size={22} />
                                <div>
                                  <div style={{ fontSize: 13.5, fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--text)" }}>{pName}</div>
                                  <div style={{ fontSize: 11.5, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{pData.baseUrl || t("modelsConfig.defaultEndpoint")}</div>
                                </div>
                              </div>
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <button
                                  type="button"
                                  onClick={() => addModel(pName)}
                                  className="settings-back"
                                  style={{ padding: "4px 8px", fontSize: 11, border: "1px solid var(--border)", background: "var(--bg)" }}
                                >
                                  <Plus size={12} aria-hidden="true" /> Add Model
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setCatalogPicker(pName)}
                                  className="settings-back"
                                  style={{ padding: "4px 8px", fontSize: 11, border: "1px solid var(--border)", background: "var(--bg)" }}
                                >
                                  <BookOpen size={12} aria-hidden="true" /> Catalog
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setSelection({ type: "provider", name: pName })}
                                  className="settings-back"
                                  style={{ padding: "4px 8px", fontSize: 11, border: "1px solid var(--border)", background: "var(--bg)" }}
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => deleteProvider(pName)}
                                  className="settings-back"
                                  style={{ padding: "4px 8px", fontSize: 11, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--status-error)" }}
                                  title="Delete provider"
                                >
                                  <Trash2 size={12} aria-hidden="true" />
                                </button>
                              </div>
                            </div>

                            {/* Models chips */}
                            {models.length > 0 ? (
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, paddingTop: 6, borderTop: "1px solid var(--border)" }}>
                                {models.map((m, i) => (
                                  <button
                                    key={i}
                                    type="button"
                                    onClick={() => setSelection({ type: "model", providerName: pName, index: i })}
                                    style={{
                                      display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 8px",
                                      borderRadius: 5, background: "var(--bg)", border: "1px solid var(--border)",
                                      color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 11, cursor: "pointer",
                                    }}
                                  >
                                    <span>{m.id}</span>
                                    {m.reasoning && <span style={{ fontSize: 9, padding: "0 3px", borderRadius: 2, background: "var(--accent-strong)", color: "var(--on-accent)", fontWeight: 700 }}>T</span>}
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <div style={{ fontSize: 11.5, color: "var(--text-dim)", paddingTop: 4, borderTop: "1px solid var(--border)" }}>
                                No models defined yet. Click &quot;Add Model&quot; or &quot;Catalog&quot; above to configure models.
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )
            )}

            {subTab === "system" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div className="providers-segmented">
                  <button
                    type="button"
                    className={`providers-segmented-btn${systemTab === "registry" ? " active" : ""}`}
                    onClick={() => { setSystemTab("registry"); setSelection({ type: "registry" }); }}
                  >
                    <Layers size={13} aria-hidden="true" />
                    <span>{t("modelsConfig.navNativeRegistry")}</span>
                  </button>
                  <button
                    type="button"
                    className={`providers-segmented-btn${systemTab === "picker" ? " active" : ""}`}
                    onClick={() => { setSystemTab("picker"); setSelection({ type: "picker" }); }}
                  >
                    <BookOpen size={13} aria-hidden="true" />
                    <span>{t("modelsConfig.navComposerPicker")}</span>
                  </button>
                  <button
                    type="button"
                    className={`providers-segmented-btn${systemTab === "roles" ? " active" : ""}`}
                    onClick={() => { setSystemTab("roles"); setSelection({ type: "roles" }); }}
                  >
                    <SlidersHorizontal size={13} aria-hidden="true" />
                    <span>{t("modelsConfig.navModelRoles")}</span>
                  </button>
                  <button
                    type="button"
                    className={`providers-segmented-btn${systemTab === "fallbacks" ? " active" : ""}`}
                    onClick={() => { setSystemTab("fallbacks"); setSelection({ type: "fallbacks" }); }}
                  >
                    <RotateCcw size={13} aria-hidden="true" />
                    <span>{t("modelsConfig.navRetryFallback")}</span>
                  </button>
                </div>

                <div style={{ width: "100%" }}>
                  {detailContent}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Footer for saving models.yml */}
        {(subTab === "custom" || !embedded) && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "12px 18px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)", borderRadius: "0 0 var(--radius-card) var(--radius-card)", flexShrink: 0, marginTop: 16 }}>
            <div style={{ fontSize: 12, color: saveError ? "var(--status-error)" : "var(--text-muted)" }}>
              {saveError ? saveError : <code>~/.omp/agent/models.yml</code>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button onClick={() => loadConfig()} disabled={loading} style={{ padding: "6px 14px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", fontSize: 12.5 }}>
                {t("modelsConfig.cancel")}
              </button>
              <button onClick={handleSave} disabled={saving || savedOk || parseError !== null} style={{
                position: "relative",
                padding: "6px 18px",
                minWidth: 92,
                background: savedOk ? "var(--status-success)" : (saving || parseError) ? "var(--bg-panel)" : "var(--accent-strong)",
                border: "none", borderRadius: 6,
                color: savedOk ? "var(--on-accent)" : (saving || parseError) ? "var(--text-muted)" : "var(--on-accent)",
                cursor: (saving || savedOk || parseError) ? "default" : "pointer", fontSize: 12.5, fontWeight: 600,
                display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
                transition: "background-color var(--dur-med) var(--ease-out-warm), color var(--dur-med) var(--ease-out-warm)",
                animation: savedOk ? "saved-pop var(--dur-theme) var(--ease-out-warm)" : undefined,
              }}>
                {savedOk && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
                    style={{ strokeDasharray: 18, animation: "saved-check-draw 0.35s ease forwards", flexShrink: 0 }}>
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
                <span>{savedOk ? t("modelsConfig.saved") : saving ? t("modelsConfig.saving") : t("modelsConfig.save")}</span>
              </button>
            </div>
          </div>
        )}
      </ModelsConfigSurface>
    {pickerOpen && (
      <AddProviderPicker
        oauthProviders={oauthProviders}
        apiKeyProviders={apiKeyProviders}
        onSelectOAuth={(id) => { setSubTab("connected"); setSelection({ type: "oauth", providerId: id }); }}
        onSelectApiKey={(id) => { setSubTab("connected"); setSelection({ type: "apikey", providerId: id }); }}
        onAddCustom={() => { setSubTab("custom"); addCustomProvider(); }}
        onClose={() => setPickerOpen(false)}
      />
    )}
    {catalogPicker !== null && (
      <ModelCatalogPicker
        open
        providerName={catalogPicker}
        providerBaseUrl={config.providers?.[catalogPicker]?.baseUrl ?? ""}
        existingIds={new Set((config.providers?.[catalogPicker]?.models ?? []).map((m) => m.id))}
        onAdd={(model, baseUrl) => addModelFromCatalog(catalogPicker, model, baseUrl)}
        onClose={() => setCatalogPicker(null)}
      />
    )}
    </>
  );
}
