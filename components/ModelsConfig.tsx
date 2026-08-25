"use client";

import { useState, useEffect, useCallback, useRef, type CSSProperties } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/lib/i18n";
import { isSafeExternalUrl } from "@/lib/safe-url";
import { omitUntouchedModelDrafts } from "@/lib/models-config-drafts";
import { formatApiError } from "@/lib/i18n/api-error";
import {
  Dialog,
  DialogContent,
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
import { Plus, Trash2, RefreshCw, AlertCircle, Cpu, Settings, Sparkles, Check as CheckIcon, ArrowDown, ArrowUp, Layers, RotateCcw, SlidersHorizontal, BookOpen, Search } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { SettingsTabs, type SettingsTab } from "./SettingsTabs";
import { ModelCatalogPicker } from "./ModelCatalogPicker";


type IconComponent = React.ComponentType<{ size?: number | string; style?: React.CSSProperties }>;

// Provider glyphs are derived from the provider id. Provider ids come from
// OMP/models.yml at runtime, so adding one never requires a UI registry entry.

// ── Types ─────────────────────────────────────────────────────────────────────

interface OAuthProvider {
  id: string;
  name: string;
  usesCallbackServer: boolean;
  loggedIn: boolean;
}

interface ApiKeyProvider {
  id: string;
  displayName: string;
  configured: boolean;
  modelCount: number;
}

type OAuthLoginState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "auth"; url: string; instructions: string | null; token: string }
  | { phase: "device_code"; userCode: string; verificationUri: string; intervalSeconds: number | null; expiresInSeconds: number | null }
  | { phase: "prompt"; message: string; placeholder: string | null; token: string }
  | { phase: "select"; message: string; options: { id: string; label: string }[]; token: string }
  | { phase: "progress"; message: string }
  | { phase: "success" }
  | { phase: "error"; message: string };

// Mirrors the ModelThinkingSchema subset of omp's models.yml
// (oh-my-pi/packages/coding-agent/src/config/models-config-schema.ts).
interface ThinkingConfig {
  mode?: string;
  efforts?: string[];
  defaultLevel?: string;
  effortMap?: Record<string, string>;
}

interface ModelEntry {
  id: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  thinking?: ThinkingConfig;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  compat?: Record<string, unknown>;
}

interface ProviderEntry {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  auth?: "apiKey" | "none" | "oauth";
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models?: ModelEntry[];
  modelOverrides?: Record<string, unknown>;
}

interface ModelsFileData {
  providers?: Record<string, ProviderEntry>;
}

type ModelTestState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "success"; latencyMs?: number; status?: number; responseText?: string }
  | { phase: "error"; message: string; latencyMs?: number; status?: number };

type Selection =
  | { type: "provider"; name: string }
  | { type: "model"; providerName: string; index: number }
  | { type: "oauth"; providerId: string }
  | { type: "apikey"; providerId: string }
  | { type: "roles" }
  | { type: "picker" }
  | { type: "registry" }
  | { type: "fallbacks" };

function ModelsConfigSurface({ embedded, isMobile, onClose, children }: { embedded: boolean; isMobile: boolean; onClose: () => void; children: React.ReactNode }) {
  if (embedded) return <>{children}</>;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        ariaLabel="Models"
        style={{
          width: isMobile ? "calc(100vw - 16px)" : 860,
          maxWidth: "calc(100vw - 16px)",
          height: isMobile ? "calc(100dvh - 16px)" : "78vh",
          maxHeight: "calc(100dvh - 16px)",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}

interface RuntimeModelEntry {
  id: string;
  name: string;
  provider: string;
  thinkingLevels?: string[];
}

interface ConnectedProvider {
  id: string;
  name: string;
  disabled: boolean;
}

type NativeRegistrySettings = {
  enabledModels?: string[];
  disabledProviders?: string[];
  modelProviderOrder?: string[];
  registryHasScopedEntries?: boolean;
};

type RetrySettings = {
  retry?: { enabled?: boolean; maxRetries?: number; modelFallback?: boolean; fallbackRevertPolicy?: "cooldown-expiry" | "never"; fallbackChains?: Record<string, string[]> };
};

function RetryFallbackDetail({ models }: { models: RuntimeModelEntry[] }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<RetrySettings | null>(null);
  const [role, setRole] = useState("default");
  const [candidate, setCandidate] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/omp-settings")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((data: { settings?: RetrySettings }) => setSettings(data.settings ?? {}))
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  // Serialize full-snapshot saves: each call writes the whole settings object,
  // so overlapping PUTs can land out of order and clobber newer changes. Keep
  // the latest snapshot and drain a single serialized save always writing the
  // most recent state (fixes rapid fallback-chain edits scheduling stale writes).
  const latestRef = useRef<RetrySettings | null>(null);
  const drainingRef = useRef(false);
  const save = (next: RetrySettings) => {
    setSettings(next);
    setError(null);
    latestRef.current = next;
    if (drainingRef.current) return;
    drainingRef.current = true;
    void (async () => {
      try {
        while (latestRef.current !== null) {
          const snapshot = latestRef.current;
          latestRef.current = null;
          try {
            const response = await fetch("/api/omp-settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: snapshot }) });
            const data = await response.json() as { settings?: RetrySettings; error?: string };
            if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
            if (latestRef.current === null) setSettings(data.settings ?? snapshot);
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
            break;
          }
        }
      } finally {
        drainingRef.current = false;
      }
    })();
  };

  if (!settings) return <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{t("modelsConfig.retryLoading")}</div>;
  const retry = settings.retry ?? {};
  const chain = retry.fallbackChains?.[role] ?? [];
  const modelOptions = models.map((model) => `${model.provider}/${model.id}`);
  const updateChain = (next: string[]) => void save({ ...settings, retry: { ...retry, fallbackChains: { ...(retry.fallbackChains ?? {}), [role]: next } } });

  return <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
    <div><SectionTitle>{t("modelsConfig.retryFallbackTitle")}</SectionTitle><p style={{ margin: "4px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>{t("modelsConfig.retryFallbackDesc")}</p></div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 9 }}>
      <label style={{ padding: "10px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", fontSize: 12, color: "var(--text)" }}><input type="checkbox" checked={retry.enabled ?? true} onChange={(event) => void save({ ...settings, retry: { ...retry, enabled: event.target.checked } })} /> {t("modelsConfig.retryTransientErrors")}</label>
      <label style={{ padding: "10px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", fontSize: 12, color: "var(--text)" }}><input type="checkbox" checked={retry.modelFallback ?? true} onChange={(event) => void save({ ...settings, retry: { ...retry, modelFallback: event.target.checked } })} /> {t("modelsConfig.allowModelFallback")}</label>
      <label style={{ padding: "10px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", color: "var(--text)", fontSize: 12 }}>{t("modelsConfig.retryAttempts")} <select value={retry.maxRetries ?? 10} onChange={(event) => void save({ ...settings, retry: { ...retry, maxRetries: Number(event.target.value) } })} style={{ marginLeft: 8, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)" }}>{[0, 1, 2, 3, 5, 10, 15, 20].map((count) => <option key={count} value={count}>{count}</option>)}</select></label>
      <label style={{ padding: "10px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", color: "var(--text)", fontSize: 12 }}>{t("modelsConfig.returnToPrimary")} <select value={retry.fallbackRevertPolicy ?? "cooldown-expiry"} onChange={(event) => void save({ ...settings, retry: { ...retry, fallbackRevertPolicy: event.target.value as "cooldown-expiry" | "never" } })} style={{ marginLeft: 8, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)" }}><option value="cooldown-expiry">{t("modelsConfig.afterCooldown")}</option><option value="never">{t("modelsConfig.never")}</option></select></label>
    </div>
    <section style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", overflow: "hidden" }}>
      <div style={{ padding: "10px 12px", background: "var(--bg-panel)", display: "flex", alignItems: "center", gap: 8 }}><span style={{ color: "var(--text)", fontSize: 12, fontWeight: 600 }}>{t("modelsConfig.fallbackChainFor")}</span><select aria-label={t("modelsConfig.fallbackChainFor")} value={role} onChange={(event) => setRole(event.target.value)} style={{ padding: "4px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)" }}>{NATIVE_MODEL_ROLES.map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
      <div style={{ padding: 12, display: "flex", gap: 8 }}><select aria-label={t("modelsConfig.selectFallbackModel")} value={candidate} onChange={(event) => setCandidate(event.target.value)} style={{ flex: 1, minWidth: 0, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)" }}><option value="">{t("modelsConfig.selectFallbackModel")}</option>{modelOptions.filter((value) => !chain.includes(value)).map((value) => <option key={value} value={value}>{value}</option>)}</select><button type="button" disabled={!candidate} onClick={() => { updateChain([...chain, candidate]); setCandidate(""); }} style={{ padding: "6px 10px", border: "none", borderRadius: "var(--radius-control)", background: "var(--accent)", color: "white", cursor: "pointer", fontSize: 12 }}>{t("modelsConfig.add")}</button></div>
      {chain.length === 0 ? (
        <div style={{ padding: "0 12px 12px", color: "var(--text-dim)", fontSize: 12 }}>{t("modelsConfig.noExplicitChain")}</div>
      ) : (
        <div style={{ borderTop: "1px solid var(--border)" }}>
          {chain.map((selector, index) => (
            <div key={selector} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", color: "var(--text-muted)", fontSize: 12 }}>
              <span style={{ width: 18, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{index + 1}</span>
              <code style={{ flex: 1 }}>{selector}</code>
              <button type="button" aria-label={`Move ${selector} up`} title={`Move ${selector} up`} disabled={index === 0} onClick={() => { const next = [...chain]; const previous = next[index - 1]; next[index - 1] = next[index]; next[index] = previous; updateChain(next); }} className="ui-focus-ring" style={{ width: 24, height: 24, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: index === 0 ? "default" : "pointer" }}><ArrowUp size={14} /></button>
              <button type="button" aria-label={`Move ${selector} down`} title={`Move ${selector} down`} disabled={index === chain.length - 1} onClick={() => { const next = [...chain]; const following = next[index + 1]; next[index + 1] = next[index]; next[index] = following; updateChain(next); }} className="ui-focus-ring" style={{ width: 24, height: 24, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: index === chain.length - 1 ? "default" : "pointer" }}><ArrowDown size={14} /></button>
              <button type="button" aria-label={`Remove ${selector} from chain`} title={`Remove ${selector}`} onClick={() => updateChain(chain.filter((value) => value !== selector))} className="ui-focus-ring" style={{ width: 24, height: 24, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}
    </section>
    {error && <div role="alert" style={{ color: "var(--status-error)", fontSize: 12 }}>{error}</div>}
  </div>;
}

function NativeRegistryDetail({ models, connectedProviders, onChanged }: { models: RuntimeModelEntry[]; connectedProviders: ConnectedProvider[]; onChanged: () => Promise<void> }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<NativeRegistrySettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/omp-settings")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((data: { settings?: NativeRegistrySettings }) => setSettings(data.settings ?? {}))
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  // Serialize full-snapshot saves: each call PUTs the whole settings object and
  // a rapid sequence of provider/model toggles must not let an older snapshot
  // land after a newer one. Keep the latest snapshot and drain a single
  // serialized save loop so the most recent state wins on the server.
  const latestRef = useRef<NativeRegistrySettings | null>(null);
  const drainingRef = useRef(false);
  const save = (next: NativeRegistrySettings) => {
    setSettings(next);
    setSaving(true);
    setError(null);
    latestRef.current = next;
    if (drainingRef.current) return;
    drainingRef.current = true;
    void (async () => {
      try {
        while (latestRef.current !== null) {
          const snapshot = latestRef.current;
          latestRef.current = null;
          try {
            const response = await fetch("/api/omp-settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: snapshot }) });
            const data = await response.json() as { settings?: NativeRegistrySettings; error?: string };
            if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
            if (latestRef.current === null) setSettings(data.settings ?? snapshot);
            await onChanged();
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
            break;
          }
        }
      } finally {
        drainingRef.current = false;
        setSaving(false);
      }
    })();
  };

  if (!settings) return <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{t("modelsConfig.registryLoading")}</div>;
  const isReadOnly = settings.registryHasScopedEntries === true;
  const allModelKeys = models.map((model) => `${model.provider}/${model.id}`);
  const allowListEnabled = (settings.enabledModels?.length ?? 0) > 0;
  const enabledModels = new Set(settings.enabledModels ?? allModelKeys);
  const providers = [...new Set([...models.map((model) => model.provider), ...connectedProviders.map((provider) => provider.id), ...(settings.disabledProviders ?? [])])].sort();
  const disabledProviders = new Set(settings.disabledProviders ?? []);
  const providerOrder = settings.modelProviderOrder ?? [];
  const orderedProviders = [...providerOrder, ...providers.filter((provider) => !providerOrder.includes(provider))];

  return <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
    <div>
      <SectionTitle>{t("modelsConfig.nativeRegistryTitle")}</SectionTitle>
      <p style={{ margin: "4px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>{t("modelsConfig.nativeRegistryDesc")}</p>
    </div>
    <section style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", overflow: "hidden" }}>
      <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", background: "var(--bg-panel)", color: "var(--text)", fontSize: 12, fontWeight: 600 }}><input type="checkbox" checked={allowListEnabled} disabled={saving || isReadOnly} onChange={(event) => void save({ ...settings, enabledModels: event.target.checked ? allModelKeys : [] })} /> {t("modelsConfig.restrictSelectedModels")}</label>
      <p style={{ margin: 0, padding: "8px 12px", color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>{allowListEnabled ? t("modelsConfig.uncheckedUnavailable") : t("modelsConfig.allModelsAllowed")}</p>
      {allowListEnabled && <div style={{ maxHeight: 260, overflowY: "auto", borderTop: "1px solid var(--border)" }}>{models.map((model) => {
        const key = `${model.provider}/${model.id}`;
        return <label key={key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", color: "var(--text-muted)", fontSize: 12 }}><input type="checkbox" checked={enabledModels.has(key)} disabled={saving || isReadOnly} onChange={(event) => { const next = new Set(enabledModels); if (event.target.checked) next.add(key); else next.delete(key); void save({ ...settings, enabledModels: [...next] }); }} /><code>{key}</code></label>;
      })}</div>}
    </section>
    <section style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", overflow: "hidden" }}>
      <div style={{ padding: "10px 12px", background: "var(--bg-panel)", color: "var(--text)", fontSize: 12, fontWeight: 600 }}>{t("modelsConfig.disabledProviders")}</div>
      <p style={{ margin: 0, padding: "8px 12px", color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>{t("modelsConfig.disabledProvidersDesc")}</p>
      <div style={{ borderTop: "1px solid var(--border)" }}>{providers.map((provider) => <label key={provider} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", color: "var(--text-muted)", fontSize: 12 }}><input type="checkbox" checked={disabledProviders.has(provider)} disabled={saving || isReadOnly} onChange={(event) => { const next = new Set(disabledProviders); if (event.target.checked) next.add(provider); else next.delete(provider); void save({ ...settings, disabledProviders: [...next] }); }} /><ProviderIcon id={provider} size={14} /><code>{provider}</code></label>)}</div>
    </section>
    <section style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", overflow: "hidden" }}>
      <div style={{ padding: "10px 12px", background: "var(--bg-panel)", color: "var(--text)", fontSize: 12, fontWeight: 600 }}>{t("modelsConfig.providerPreference")}</div>
      <p style={{ margin: 0, padding: "8px 12px", color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>{t("modelsConfig.providerPreferenceDesc")}</p>
      <div style={{ borderTop: "1px solid var(--border)" }}>{orderedProviders.map((provider, index) => <div key={provider} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", color: "var(--text-muted)", fontSize: 12 }}><ProviderIcon id={provider} size={14} /><code style={{ flex: 1 }}>{provider}</code><button type="button" disabled={saving || isReadOnly || index === 0} onClick={() => { const next = [...orderedProviders]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; void save({ ...settings, modelProviderOrder: next }); }} title={t("modelsConfig.moveProviderUp")} aria-label={t("modelsConfig.moveProviderUp")} className="ui-focus-ring" style={{ width: 24, height: 24, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}><ArrowUp size={14} /></button><button type="button" disabled={saving || isReadOnly || index === orderedProviders.length - 1} onClick={() => { const next = [...orderedProviders]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; void save({ ...settings, modelProviderOrder: next }); }} title={t("modelsConfig.moveProviderDown")} aria-label={t("modelsConfig.moveProviderDown")} className="ui-focus-ring" style={{ width: 24, height: 24, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}><ArrowDown size={14} /></button></div>)}</div>
    </section>
    {isReadOnly && <div role="status" style={{ padding: "9px 11px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.45 }}>{t("modelsConfig.pathScopedNotice")}</div>}
    {error && <div role="alert" style={{ color: "var(--status-error)", fontSize: 12 }}>{error}</div>}
  </div>;
}

const COMPOSER_MODELS_STORAGE_KEY = "omp-composer-models";
const NATIVE_MODEL_ROLES = ["default", "smol", "slow", "vision", "plan", "designer", "commit", "tiny", "task", "advisor"];

function ModelRolesDetail({ models }: { models: RuntimeModelEntry[] }) {
  const { t } = useI18n();
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/model-roles")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((data: { roles?: Record<string, string> }) => setRoles(data.roles ?? {}))
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/model-roles", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roles }) });
      const data = await response.json() as { error?: string };
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      toast.success(t("modelsConfig.rolesSaved"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const updateRoleModel = (role: string, modelValue: string) => {
    const current = roles[role] ?? "";
    const effort = current.match(/:([^,:]+)$/)?.[1] ?? "";
    setRoles((values) => ({ ...values, [role]: modelValue ? `${modelValue}${effort ? `:${effort}` : ""}` : "" }));
  };

  const updateRoleThinking = (role: string, effort: string) => {
    const current = roles[role] ?? "";
    const modelValue = current.replace(/:([^,:]+)$/, "");
    setRoles((values) => ({ ...values, [role]: modelValue ? `${modelValue}${effort ? `:${effort}` : ""}` : "" }));
  };

  return <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
    <div>
      <SectionTitle>{t("modelsConfig.modelRolesTitle")}</SectionTitle>
      <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{t("modelsConfig.modelRolesDesc")}</p>
    </div>
    {loading ? <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{t("modelsConfig.loadingRoles")}</div> : NATIVE_MODEL_ROLES.map((role) => (
      <div key={role} className="model-role-row" style={{ display: "grid", gridTemplateColumns: "82px minmax(0, 1fr) minmax(110px, 0.35fr)", alignItems: "center", gap: 10, fontSize: 12 }}>
        <code style={{ color: "var(--text-muted)" }}>{role}</code>
        {(() => {
          const raw = roles[role] ?? "";
          const selectedModel = raw.replace(/:([^,:]+)$/, "");
          const selectedThinking = raw.match(/:([^,:]+)$/)?.[1] ?? "";
          const model = models.find((item) => `${item.provider}/${item.id}` === selectedModel);
          const modelKnown = !selectedModel || Boolean(model);
          return <>
            <select aria-label={`Model override for ${role}`} value={selectedModel} onChange={(event) => updateRoleModel(role, event.target.value)} style={{ minWidth: 0, padding: "7px 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 12 }}>
              <option value="">{t("modelsConfig.noOverride")}</option>
              {!modelKnown && <option value={selectedModel}>{selectedModel} (not currently available)</option>}
              {models.map((item) => <option key={`${item.provider}:${item.id}`} value={`${item.provider}/${item.id}`}>{item.name || item.id} ({item.provider}/{item.id})</option>)}
            </select>
            <select aria-label={`Thinking level for ${role}`} value={selectedThinking} disabled={!model} onChange={(event) => updateRoleThinking(role, event.target.value)} style={{ minWidth: 0, padding: "7px 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 12, opacity: model ? 1 : 0.55 }}>
              <option value="">{t("modelsConfig.modelDefault")}</option>
              {(model?.thinkingLevels ?? []).filter((level) => level !== "off").map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
          </>;
        })()}
      </div>
    ))}
    {error && <div role="alert" style={{ color: "var(--status-error)", fontSize: 12 }}>{error}</div>}
    <button type="button" onClick={() => void save()} disabled={loading || saving} style={{ alignSelf: "flex-start", padding: "7px 12px", border: "none", borderRadius: "var(--radius-control)", background: "var(--accent)", color: "var(--on-accent)", cursor: saving ? "wait" : "pointer", fontSize: 12, fontWeight: 600 }}>{saving ? t("modelsConfig.saving") : t("modelsConfig.saveRoles")}</button>
  </div>;
}

// omp's models.yml ApiSchema (config/models-config-schema.ts)
const API_OPTIONS = [
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-gemini-cli",
  "google-vertex",
] as const;

// ── Form field helpers ────────────────────────────────────────────────────────

/** Renders a translated string, displaying `backtick` segments in mono code font. */
function CodeText({ text }: { text: string }) {
  const parts = text.split("`");
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((seg, i) =>
        i % 2 === 1 ? <code key={i} style={{ fontFamily: "var(--font-mono)" }}>{seg}</code> : seg,
      )}
    </>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>{children}</div>;
}

function TreeNavButton({ icon: Icon, label, selected, onClick }: { icon: IconComponent; label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: "100%", padding: "8px 10px", border: "none", borderRadius: "var(--radius-control)",
        background: selected ? "var(--bg-selected)" : "none",
        color: selected ? "var(--text)" : "var(--text-muted)",
        cursor: "pointer", fontSize: 12, textAlign: "left", display: "flex", alignItems: "center", gap: 8,
        fontWeight: selected ? 600 : 400,
      }}
    >
      <Icon size={14} style={{ color: selected ? "var(--accent)" : "currentColor", flexShrink: 0 }} />
      {label}
    </button>
  );
}

const hoverRow = (selected: boolean) => ({
  onMouseEnter: (e: React.MouseEvent<HTMLElement>) => { if (!selected) e.currentTarget.style.background = "var(--bg-hover)"; },
  onMouseLeave: (e: React.MouseEvent<HTMLElement>) => { if (!selected) e.currentTarget.style.background = "none"; },
});

const hoverAccent = {
  onMouseEnter: (e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.color = "var(--accent)"; e.currentTarget.style.borderColor = "var(--accent)"; },
  onMouseLeave: (e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.borderColor = "var(--border)"; },
};

// ── Provider detail ───────────────────────────────────────────────────────────

type EndpointPreset = {
  label: string;
  baseUrl: string;
  /** "none" forces no-auth; "apiKey" forces key-based auth; "keep" preserves the current auth mode. */
  auth: "none" | "apiKey" | "keep";
};

const ENDPOINT_PRESETS: EndpointPreset[] = [
  { label: "🦙 Ollama", baseUrl: "http://localhost:11434/v1", auth: "none" },
  { label: "⚡ LM Studio / vLLM", baseUrl: "http://localhost:1234/v1", auth: "none" },
  { label: "🌐 OpenRouter", baseUrl: "https://openrouter.ai/api/v1", auth: "apiKey" },
  { label: "🤖 Local Proxy (:2455)", baseUrl: "http://127.0.0.1:2455/v1", auth: "keep" },
];

const presetButtonStyle = {
  padding: "4px 8px",
  fontSize: 11,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg)",
  color: "var(--text)",
  cursor: "pointer",
} as const;

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
              background: "var(--accent)",
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

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = typeof THINKING_LEVELS[number];

const LEVEL_COLORS: Record<ThinkingLevel, string> = {
  minimal: "var(--text-dim)",
  low:     "color-mix(in srgb, var(--accent) 45%, var(--text-muted))",
  medium:  "var(--accent)",
  high:    "var(--accent-hover)",
  xhigh:   "var(--status-warning)",
  max:     "var(--status-error)",
};

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
          background: "var(--accent)",
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

const COST_LABEL_KEYS = {
  input: "modelsConfig.costInput",
  output: "modelsConfig.costOutput",
  cacheRead: "modelsConfig.costCacheRead",
  cacheWrite: "modelsConfig.costCacheWrite",
} as const;

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
                style={{ padding: "6px 12px", background: inputValue.trim() ? "var(--accent)" : "var(--bg-panel)", border: "none", borderRadius: 5, color: inputValue.trim() ? "var(--on-accent)" : "var(--text-dim)", cursor: inputValue.trim() ? "pointer" : "not-allowed", fontSize: 12, fontWeight: 600, flexShrink: 0 }}
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
              style={{ padding: "5px 14px", background: "var(--accent)", border: "none", borderRadius: 5, color: "var(--on-accent)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
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

// ── API Key detail ────────────────────────────────────────────────────────────
// omp keeps API keys in its own encrypted credential store (agent.db), which
// omp-web never reads or writes — this panel is status-only.

function ApiKeyDetail({ provider }: { provider: ApiKeyProvider }) {
  const { t, tn } = useI18n();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>{t("modelsConfig.apiKey")}</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: provider.configured ? "var(--status-success)" : "var(--border)", display: "inline-block" }} />
          <span style={{ fontSize: 11, color: provider.configured ? "var(--status-success)" : "var(--text-dim)" }}>
            {provider.configured ? t("modelsConfig.configured") : t("modelsConfig.notConfigured")}
          </span>
        </div>
      </div>

      <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
        {provider.configured
          ? tn("modelsConfig.providerConfigured", provider.modelCount, { name: provider.displayName })
          : t("modelsConfig.providerNotConfigured", { name: provider.displayName })}
      </p>

      <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
        <CodeText text={t("modelsConfig.apiKeyManageHint")} />
      </p>
    </div>
  );
}

// ── Provider icon ─────────────────────────────────────────────────────────────

export function providerInitials(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "?";
}

function ProviderIcon({ id, size }: { id: string; size: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        border: "1px solid var(--border)",
        borderRadius: 4,
        color: "var(--text-dim)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        fontSize: Math.max(8, Math.floor(size * 0.42)),
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      {providerInitials(id)}
    </span>
  );
}

// ── Add provider picker ───────────────────────────────────────────────────────

interface AddProviderPickerProps {
  oauthProviders: OAuthProvider[];
  apiKeyProviders: ApiKeyProvider[];
  onSelectOAuth: (id: string) => void;
  onSelectApiKey: (id: string) => void;
  onAddCustom: () => void;
  onClose: () => void;
}

function AddProviderPicker({
  oauthProviders, apiKeyProviders,
  onSelectOAuth, onSelectApiKey, onAddCustom, onClose,
}: AddProviderPickerProps) {
  const { t, tn } = useI18n();
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const q = search.trim().toLowerCase();

  const availableOAuth = oauthProviders.filter((p) => !p.loggedIn && (!q || p.name.toLowerCase().includes(q)));
  const availableApiKey = apiKeyProviders.filter((p) => !p.configured && (!q || p.displayName.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)));
  const showCustom = !q || "custom".includes(q);

  const totalCount = availableOAuth.length + availableApiKey.length + (showCustom ? 1 : 0);

  const cardStyle: CSSProperties = {
    display: "flex", flexDirection: "row", alignItems: "center", gap: 8,
    padding: "10px 12px",
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-control)",
    boxSizing: "border-box",
    cursor: "pointer",
    minWidth: 0,
    textAlign: "left",
    transition: "border-color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
    width: "100%",
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        ariaLabel={t("modelsConfig.addProvider")}
        style={{
          width: 820,
          maxWidth: "min(92vw, 820px)",
          maxHeight: "min(72dvh, calc(100dvh - 32px))",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <DialogTitle style={{ margin: "14px 18px 8px", fontSize: 18 }}>{t("modelsConfig.addProvider")}</DialogTitle>

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
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("modelsConfig.searchProviders")}
              style={{
                flex: 1, background: "none", border: "none", outline: "none",
                color: "var(--text)", fontSize: 13, boxSizing: "border-box", minWidth: 0,
              }}
            />
          </div>
        </div>

        {/* Card grid */}
        <div style={{ flex: 1, overflowY: "auto", padding: "4px 14px 14px" }}>
          {totalCount === 0 ? (
            <div style={{ padding: "20px 0", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>{t("modelsConfig.noProvidersMatch")}</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(240px, 100%), 1fr))", gap: 8 }}>
              {showCustom && (
                <div style={{ gridColumn: "1 / -1", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{t("modelsConfig.customSection")}</div>
              )}
              {showCustom && (
                <button
                  type="button"
                  onClick={() => { onAddCustom(); onClose(); }}
                  style={cardStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-panel)"; }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("modelsConfig.openaiAnthropicCompatible")}</div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>{t("modelsConfig.customEndpointFormat")}</div>
                  </div>
                  <span style={{ width: 26, height: 26, borderRadius: 5, background: "var(--bg-hover)", border: "1px dashed var(--border)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <Plus size={13} aria-hidden="true" />
                  </span>
                </button>
              )}

              {availableOAuth.length > 0 && (
                <div style={{ gridColumn: "1 / -1", paddingTop: showCustom ? 6 : 0, fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{t("modelsConfig.subscriptions")}</div>
              )}
              {availableOAuth.map((p) => (
                <button key={p.id} type="button" onClick={() => { onSelectOAuth(p.id); onClose(); }}
                  style={cardStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-panel)"; }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>OAuth</div>
                  </div>
                  <ProviderIcon id={p.id} size={28} />
                </button>
              ))}

              {availableApiKey.length > 0 && (
                <div style={{ gridColumn: "1 / -1", paddingTop: availableOAuth.length > 0 ? 6 : 0, fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{t("modelsConfig.apiKey")}</div>
              )}
              {availableApiKey.map((p) => (
                <button key={p.id} type="button" onClick={() => { onSelectApiKey(p.id); onClose(); }}
                  style={cardStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-panel)"; }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.displayName}</div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>{tn("modelsConfig.modelCount", p.modelCount)}</div>
                  </div>
                  <ProviderIcon id={p.id} size={28} />
                </button>
              ))}

            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
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
  const [selection, setSelection] = useState<Selection | null>(null);
  const [oauthProviders, setOauthProviders] = useState<OAuthProvider[]>([]);
  const [apiKeyProviders, setApiKeyProviders] = useState<ApiKeyProvider[]>([]);
  const [runtimeModels, setRuntimeModels] = useState<RuntimeModelEntry[]>([]);
  const [connectedProviders, setConnectedProviders] = useState<ConnectedProvider[]>([]);
  const [runtimeModelsLoading, setRuntimeModelsLoading] = useState(true);
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
        if (keys.length > 0) setSelection({ type: "provider", name: keys[0] });
      })
      .catch(() => setConfig({ providers: {} }))
      .finally(() => setLoading(false));
  }, []);

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
        <div style={{ flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row", overflow: "hidden" }}>
          {/* Left: tree — zoned navigation */}
          <div style={{
            width: isMobile ? "100%" : 258,
            maxHeight: isMobile ? "40vh" : undefined,
            borderRight: isMobile ? "none" : "1px solid var(--border)",
            borderBottom: isMobile ? "1px solid var(--border)" : "none",
            display: "flex", flexDirection: "column", flexShrink: 0, background: "var(--bg-panel)",
            overflow: "hidden",
          }}>
            <div style={{ flex: 1, overflowY: "auto", padding: "10px 8px", display: "flex", flexDirection: "column", gap: 14 }}>
              {/* — OMP System — */}
              <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 6px", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)" }}>
                  <Layers size={10} aria-hidden="true" style={{ opacity: 0.7 }} /> {t("modelsConfig.ompSystemSection")}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: 4, border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg)" }}>
                  <TreeNavButton icon={Layers} label={t("modelsConfig.navNativeRegistry")} selected={selection?.type === "registry"} onClick={() => setSelection({ type: "registry" })} />
                  <TreeNavButton icon={RotateCcw} label={t("modelsConfig.navRetryFallback")} selected={selection?.type === "fallbacks"} onClick={() => setSelection({ type: "fallbacks" })} />
                  <TreeNavButton icon={BookOpen} label={t("modelsConfig.navComposerPicker")} selected={selection?.type === "picker"} onClick={() => setSelection({ type: "picker" })} />
                  <TreeNavButton icon={SlidersHorizontal} label={t("modelsConfig.navModelRoles")} selected={selection?.type === "roles"} onClick={() => setSelection({ type: "roles" })} />
                </div>
              </section>

              {/* — Connected accounts — */}
              <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 6px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)" }}>
                    <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: activeOAuth.length + activeApiKey.length > 0 ? "var(--status-success)" : "var(--border)", flexShrink: 0 }} />
                    {t("modelsConfig.connectedAccounts")}
                  </div>
                  {(activeOAuth.length + activeApiKey.length) > 0 && (
                    <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 10, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text-dim)", fontWeight: 600 }}>
                      {activeOAuth.length + activeApiKey.length}
                    </span>
                  )}
                </div>
                {(activeOAuth.length === 0 && activeApiKey.length === 0) ? (
                  <div style={{ padding: "10px 10px", border: "1px dashed var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg)", color: "var(--text-dim)", fontSize: 11, lineHeight: 1.5, textAlign: "center" }}>
                    {t("modelsConfig.noConnectedAccounts")}
                    <br />
                    <span style={{ color: "var(--text-muted)" }}>{t("modelsConfig.addOneBelow")}</span>
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: 4, border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg)" }}>
                    {activeOAuth.map((p) => {
                      const isSelected = selection?.type === "oauth" && selection.providerId === p.id;
                      return (
                        <button
                          type="button"
                          key={p.id}
                          onClick={() => setSelection({ type: "oauth", providerId: p.id })}
                          style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", borderRadius: "var(--radius-control)", cursor: "pointer", width: "100%", border: isSelected ? "1px solid var(--accent)" : "1px solid transparent", textAlign: "left", fontFamily: "inherit", background: isSelected ? "var(--bg-selected)" : "none", fontWeight: isSelected ? 600 : 400 }}
                          {...hoverRow(isSelected)}
                        >
                          <ProviderIcon id={p.id} size={16} />
                          <span style={{ fontSize: 12, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                          <span title={t("modelsConfig.oauthProviderTitle", { id: p.id })} style={{ padding: "2px 6px", borderRadius: 4, background: isSelected ? "var(--accent)" : "var(--bg-subtle)", color: isSelected ? "var(--on-accent)" : "var(--text-muted)", fontSize: 9, fontWeight: 600, flexShrink: 0 }}>OAuth</span>
                        </button>
                      );
                    })}
                    {activeApiKey.map((p) => {
                      const isSelected = selection?.type === "apikey" && selection.providerId === p.id;
                      return (
                        <button
                          type="button"
                          key={p.id}
                          onClick={() => setSelection({ type: "apikey", providerId: p.id })}
                          style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", borderRadius: "var(--radius-control)", cursor: "pointer", width: "100%", border: isSelected ? "1px solid var(--accent)" : "1px solid transparent", textAlign: "left", fontFamily: "inherit", background: isSelected ? "var(--bg-selected)" : "none", fontWeight: isSelected ? 600 : 400 }}
                          {...hoverRow(isSelected)}
                        >
                          <ProviderIcon id={p.id} size={16} />
                          <span style={{ fontSize: 12, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.displayName}</span>
                          <span title={t("modelsConfig.apiKeyProviderTitle", { id: p.id })} style={{ padding: "2px 6px", borderRadius: 4, background: isSelected ? "var(--accent)" : "var(--bg-subtle)", color: isSelected ? "var(--on-accent)" : "var(--text-muted)", fontSize: 9, fontWeight: 600, flexShrink: 0 }}>API key</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* — Custom providers (models.yml) — */}
              <section style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minHeight: 0 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 6px" }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    {t("modelsConfig.customProviders")}
                  </div>
                  <code style={{ fontSize: 9, padding: "1px 5px", borderRadius: 4, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>models.yml</code>
                </div>
                {loading ? (
                  <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-muted)" }}>{t("modelsConfig.loading")}</div>
                ) : providers.length === 0 ? (
                  <div style={{ padding: "12px 10px", border: "1px dashed var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg)", color: "var(--text-dim)", fontSize: 11, lineHeight: 1.5, textAlign: "center" }}>
                    {t("modelsConfig.noCustomProviders")}
                    <br />
                    <span style={{ color: "var(--text-muted)" }}>{t("modelsConfig.addOpenAiEndpoint")}</span>
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {providers.map(([pName, pData]) => {
                      const isProviderSelected = selection?.type === "provider" && selection.name === pName;
                      const models = pData.models ?? [];
                      return (
                        <div key={pName} style={{ borderRadius: "var(--radius-card)", background: "var(--bg)", border: isProviderSelected ? "1px solid var(--accent)" : "1px solid var(--border)", overflow: "hidden", boxShadow: isProviderSelected ? "0 0 0 2px color-mix(in srgb, var(--accent) 18%, transparent)" : "none" }}>
                          {/* Provider row */}
                          <button
                            type="button"
                            onClick={() => setSelection({ type: "provider", name: pName })}
                            style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 10px", cursor: "pointer", width: "100%", border: "none", textAlign: "left", fontFamily: "inherit", background: isProviderSelected ? "var(--bg-selected)" : "var(--bg)", borderBottom: models.length ? "1px solid var(--border)" : "none" }}
                            {...hoverRow(isProviderSelected)}
                          >
                            <ProviderIcon id={pName} size={15} />
                            <span style={{ fontSize: 12, fontWeight: isProviderSelected ? 700 : 600, color: "var(--text)", fontFamily: "var(--font-mono)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {pName}
                            </span>
                            <span style={{ fontSize: 10, color: isProviderSelected ? "var(--accent)" : "var(--text-dim)", padding: "2px 6px", borderRadius: 10, background: isProviderSelected ? "color-mix(in srgb, var(--accent) 14%, transparent)" : "var(--bg-subtle)", border: `1px solid ${isProviderSelected ? "color-mix(in srgb, var(--accent) 22%, transparent)" : "var(--border)"}`, fontWeight: 600 }}>
                              {models.length} model{models.length === 1 ? "" : "s"}
                            </span>
                          </button>

                          {/* Model rows */}
                          {models.map((m, i) => {
                            const isModelSelected = selection?.type === "model" && selection.providerName === pName && selection.index === i;
                            return (
                              <button
                                type="button"
                                key={i}
                                onClick={() => setSelection({ type: "model", providerName: pName, index: i })}
                                style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px 6px 32px", cursor: "pointer", width: "100%", border: "none", textAlign: "left", fontFamily: "inherit", background: isModelSelected ? "var(--bg-selected)" : "transparent", borderLeft: isModelSelected ? "2px solid var(--accent)" : "2px solid transparent", borderTop: "1px solid var(--border)" }}
                                {...hoverRow(isModelSelected)}
                              >
                                <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: m.id ? (isModelSelected ? "var(--text)" : "var(--text-muted)") : "var(--text-dim)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: isModelSelected ? 600 : 400 }}>
                                  {m.id || t("modelsConfig.newModel")}
                                </span>
                                {m.reasoning && (
                                  <span style={{ fontSize: 9, padding: "1px 4px", background: isModelSelected ? "var(--accent)" : "color-mix(in srgb, var(--accent) 14%, transparent)", color: isModelSelected ? "var(--on-accent)" : "var(--accent)", borderRadius: 3, flexShrink: 0, fontWeight: 700 }}>T</span>
                                )}
                              </button>
                            );
                          })}

                          {/* Add model buttons */}
                          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 8px", background: "var(--bg-subtle)", borderTop: "1px solid var(--border)", flexWrap: "nowrap" }}>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); addModel(pName); }}
                              style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 8px", borderRadius: "var(--radius-control)", cursor: "pointer", color: "var(--text-muted)", border: "1px solid var(--border)", background: "var(--bg)", fontFamily: "inherit", fontSize: 11, whiteSpace: "nowrap", flexShrink: 0, fontWeight: 500 }}
                              {...hoverAccent}
                            >
                              <Plus size={11} aria-hidden="true" />
                              <span>{t("modelsConfig.addModel")}</span>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); setCatalogPicker(pName); }}
                              style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 8px", borderRadius: "var(--radius-control)", cursor: "pointer", color: "var(--text-muted)", border: "1px solid var(--border)", background: "var(--bg)", fontFamily: "inherit", fontSize: 11, whiteSpace: "nowrap", flexShrink: 0, fontWeight: 500 }}
                              {...hoverAccent}
                            >
                              <BookOpen size={11} aria-hidden="true" />
                              <span>{t("modelsConfig.addFromCatalog")}</span>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>

            {/* Add provider — primary action */}
            <div style={{ borderTop: "1px solid var(--border)", padding: "10px 8px", background: "var(--bg)", flexShrink: 0 }}>
              <button onClick={() => setPickerOpen(true)} style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                width: "100%", padding: "8px 0", background: "var(--accent)", border: "1px solid var(--accent)", borderRadius: "var(--radius-control)",
                color: "var(--on-accent)", cursor: "pointer", fontSize: 12, fontWeight: 600,
              }}
                onMouseEnter={(e) => { e.currentTarget.style.filter = "brightness(1.05)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.filter = "none"; }}
              >
                <Plus size={13} aria-hidden="true" /> {t("modelsConfig.addProvider")}
              </button>
            </div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 20, background: "var(--bg)" }}>
            {loading ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div className="skeleton" style={{ height: 18, width: "40%" }} />
                <div className="skeleton" style={{ height: 12, width: "70%" }} />
                <div className="skeleton" style={{ height: 12, width: "55%" }} />
                <div className="skeleton" style={{ height: 90, width: "100%" }} />
              </div>
            ) : detailContent ?? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 13 }}>
                {t("modelsConfig.selectProviderOrModel")}
              </div>
            )}
          </div>
        </div>
        )}

        {/* Footer */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, padding: "10px 18px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
          {saveError && <span style={{ fontSize: 12, color: "var(--status-error)", flex: 1 }}>{saveError}</span>}
          <button onClick={onClose} style={{ padding: "6px 14px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", fontSize: 13 }}>
            {t("modelsConfig.cancel")}
          </button>
          <button onClick={handleSave} disabled={saving || savedOk || parseError !== null} style={{
            position: "relative",
            padding: "6px 16px",
            minWidth: 92,
            background: savedOk ? "var(--status-success)" : (saving || parseError) ? "var(--bg-panel)" : "var(--accent)",
            border: "none", borderRadius: 6,
            color: savedOk ? "var(--on-accent)" : (saving || parseError) ? "var(--text-muted)" : "var(--on-accent)",
            cursor: (saving || savedOk || parseError) ? "default" : "pointer", fontSize: 13, fontWeight: 600,
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
      </ModelsConfigSurface>
    {pickerOpen && (
      <AddProviderPicker
        oauthProviders={oauthProviders}
        apiKeyProviders={apiKeyProviders}
        onSelectOAuth={(id) => setSelection({ type: "oauth", providerId: id })}
        onSelectApiKey={(id) => setSelection({ type: "apikey", providerId: id })}
        onAddCustom={addCustomProvider}
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
