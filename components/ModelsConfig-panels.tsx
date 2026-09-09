"use client";

import { useState, useEffect, useRef, type CSSProperties } from "react";
import { useI18n } from "@/lib/i18n";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/primitives";
import { Plus, Trash2, ArrowDown, ArrowUp } from "lucide-react";
import { toast } from "@/components/ui/toast";
import {
  NATIVE_MODEL_ROLES,
  providerInitials,
  type ApiKeyProvider,
  type ConnectedProvider,
  type IconComponent,
  type NativeRegistrySettings,
  type OAuthProvider,
  type RetrySettings,
  type RuntimeModelEntry,
} from "./ModelsConfig-types";

// Presentational panels extracted from ModelsConfig.tsx
// (pure extraction, no behavior change).

export function ModelsConfigSurface({ embedded, isMobile, onClose, children }: { embedded: boolean; isMobile: boolean; onClose: () => void; children: React.ReactNode }) {
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
/** Renders a translated string, displaying `backtick` segments in mono code font. */
export function CodeText({ text }: { text: string }) {
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

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>{children}</div>;
}

export function TreeNavButton({ icon: Icon, label, selected, onClick }: { icon: IconComponent; label: string; selected: boolean; onClick: () => void }) {
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
export function RetryFallbackDetail({ models }: { models: RuntimeModelEntry[] }) {
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
      <div style={{ padding: 12, display: "flex", gap: 8 }}><select aria-label={t("modelsConfig.selectFallbackModel")} value={candidate} onChange={(event) => setCandidate(event.target.value)} style={{ flex: 1, minWidth: 0, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)" }}><option value="">{t("modelsConfig.selectFallbackModel")}</option>{modelOptions.filter((value) => !chain.includes(value)).map((value) => <option key={value} value={value}>{value}</option>)}</select><button type="button" disabled={!candidate} onClick={() => { updateChain([...chain, candidate]); setCandidate(""); }} style={{ padding: "6px 10px", border: "none", borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "white", cursor: "pointer", fontSize: 12 }}>{t("modelsConfig.add")}</button></div>
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
export function NativeRegistryDetail({ models, connectedProviders, onChanged }: { models: RuntimeModelEntry[]; connectedProviders: ConnectedProvider[]; onChanged: () => Promise<void> }) {
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
export function ModelRolesDetail({ models }: { models: RuntimeModelEntry[] }) {
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
    <button type="button" onClick={() => void save()} disabled={loading || saving} style={{ alignSelf: "flex-start", padding: "7px 12px", border: "none", borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "var(--on-accent)", cursor: saving ? "wait" : "pointer", fontSize: 12, fontWeight: 600 }}>{saving ? t("modelsConfig.saving") : t("modelsConfig.saveRoles")}</button>
  </div>;
}
// ── API Key detail ────────────────────────────────────────────────────────────
// omp keeps API keys in its own encrypted credential store (agent.db), which
// omp-web never reads or writes — this panel is status-only.

export function ApiKeyDetail({ provider }: { provider: ApiKeyProvider }) {
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
export function ProviderIcon({ id, size }: { id: string; size: number }) {
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

export interface AddProviderPickerProps {
  oauthProviders: OAuthProvider[];
  apiKeyProviders: ApiKeyProvider[];
  onSelectOAuth: (id: string) => void;
  onSelectApiKey: (id: string) => void;
  onAddCustom: () => void;
  onClose: () => void;
}

export function AddProviderPicker({
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
