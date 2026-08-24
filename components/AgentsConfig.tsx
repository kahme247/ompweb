"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Bot, Check, Copy, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { useI18n } from "@/lib/i18n";

type AgentInfo = {
  name: string;
  description: string;
  model?: string[];
  tools?: string[];
  spawns?: string[] | "*";
  thinkingLevel?: string;
  source: "bundled" | "user" | "project";
  scope: string;
  filePath: string;
  valid: boolean;
  enabled: boolean;
  body?: string;
  rawFrontmatter?: Record<string, unknown>;
};

type AgentsResponse = {
  agents?: AgentInfo[];
  diagnostics?: Array<{ type?: string; message?: string }>;
  error?: string;
};

const inputStyle = { width: "100%", padding: "7px 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", font: "12px var(--font-mono)" } as const;
const textareaStyle = { width: "100%", padding: "7px 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", font: "12px var(--font-mono)", lineHeight: "1.45" } as const;
const nativeSelectStyle = { minHeight: 32, padding: "4px 28px 4px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 12 } as const;
const THINKING_LEVELS = ["", "auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function shorten(p: string) {
  const h = p.replace(/^[^:]*:/, "");
  if (h.length > 48) return "…" + h.slice(-47);
  return h;
}
function splitCsv(v: string): string[] { return v.split(",").map((s) => s.trim()).filter(Boolean); }
function toCsv(arr?: string[] | string): string { if (!arr) return ""; if (typeof arr === "string") return arr; return arr.join(", "); }
function fileStem(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
  return fileName.toLowerCase().endsWith(".md") ? fileName.slice(0, -3) : fileName;
}

export function AgentsConfig({ cwd }: { cwd: string | null }) {
  const { t, tn } = useI18n();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<Array<{ type?: string; message?: string }>>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createScope, setCreateScope] = useState<"user" | "project">("user");
  const [workspaceUnavailable, setWorkspaceUnavailable] = useState(false);
  const [workspaceCheckPending, setWorkspaceCheckPending] = useState(Boolean(cwd));
  const selectedRef = useRef<string | null>(null);
  const loadGenerationRef = useRef(0);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [modelCsv, setModelCsv] = useState("");
  const [toolsCsv, setToolsCsv] = useState("");
  const [spawnsCsv, setSpawnsCsv] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("");
  const [body, setBody] = useState("");

  const load = useCallback(async (forceSelect = false) => {
    const generation = ++loadGenerationRef.current;
    const requestCwd = cwd;
    const isCurrent = () => loadGenerationRef.current === generation && cwdRef.current === requestCwd;
    setLoading(true);
    setMessage(null);
    setWorkspaceCheckPending(Boolean(requestCwd));
    try {
      const params = new URLSearchParams();
      if (cwd) params.set("cwd", cwd);
      let res = await fetch(`/api/agents?${params.toString()}`);
      let data = (await res.json()) as AgentsResponse;
      if (!isCurrent()) return;
      if (!res.ok || data.error) {
        if (!requestCwd || res.status !== 403) throw new Error(data.error || `HTTP ${res.status}`);
        // A project can remain in the sidebar after its directory is moved or
        // deleted. Keep global agents usable while the API continues to reject
        // writes against that missing workspace.
        res = await fetch("/api/agents");
        data = (await res.json()) as AgentsResponse;
        if (!isCurrent()) return;
        if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
        setWorkspaceUnavailable(true);
        setWorkspaceCheckPending(false);
        setMessage(t("agentsConfig.workspaceUnavailableWarning"));
      } else {
        setWorkspaceUnavailable(false);
        setWorkspaceCheckPending(false);
      }
      const list = Array.isArray(data.agents) ? data.agents : [];
      if (!isCurrent()) return;
      setAgents(list);
      const nextDiagnostics = Array.isArray(data.diagnostics) ? data.diagnostics : [];
      setDiagnostics(nextDiagnostics);
      const diagnosticErrors = nextDiagnostics
        .filter((diagnostic) => diagnostic.type === "error" && typeof diagnostic.message === "string")
        .map((diagnostic) => diagnostic.message as string);
      if (diagnosticErrors.length > 0 && list.length === 0) setMessage(diagnosticErrors.join("; "));
      if (forceSelect || !creating) {
        const currentName = selectedRef.current;
        const chosen = (currentName ? list.find((a) => a.name === currentName) : undefined) ?? list[0] ?? null;
        selectedRef.current = chosen?.name ?? null;
        setSelected(chosen?.name ?? null);
        if (chosen) fillForm(chosen);
        else clearForm();
      }
    } catch (e) {
      if (!isCurrent()) return;
      const msg = e instanceof Error ? e.message : String(e);
      setWorkspaceCheckPending(false);
      setMessage(msg);
      toast.error(t("agentsConfig.loadError"), msg);
    } finally { if (isCurrent()) { setLoading(false); setWorkspaceCheckPending(false); } }
  }, [cwd, creating, t]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    setWorkspaceUnavailable(false);
    setWorkspaceCheckPending(Boolean(cwd));
    setSaving(false);
  }, [cwd]);
  const canEditProject = Boolean(cwd && !workspaceUnavailable && !workspaceCheckPending);
  useEffect(() => { setCreateScope(canEditProject ? "project" : "user"); }, [canEditProject]);
  const counts = useMemo(() => {
    let bundled = 0, user = 0, project = 0;
    for (const a of agents) {
      if (a.scope === "bundled") bundled += 1;
      else if (a.scope === "user") user += 1;
      else if (a.scope === "project") project += 1;
    }
    return { total: agents.length, bundled, user, project };
  }, [agents]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter((a) => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q));
  }, [agents, search]);
  const active = useMemo(() => (creating || !selected ? null : agents.find((a) => a.name === selected) ?? null), [agents, selected, creating]);
  const isBundledActive = active?.scope === "bundled";
  const activeProjectUnavailable = active?.scope === "project" && !canEditProject;
  function fillForm(a: AgentInfo) {
    setName(a.name);
    setDescription(a.description);
    setModelCsv(toCsv(a.model));
    setToolsCsv(toCsv(a.tools));
    setSpawnsCsv(toCsv(a.spawns as string[] | string | undefined));
    setThinkingLevel(a.thinkingLevel ?? "");
    setBody(a.body ?? "");
  }
  function clearForm() {
    setName(""); setDescription(""); setModelCsv(""); setToolsCsv("");
    setSpawnsCsv(""); setThinkingLevel(""); setBody("");
  }
  const pick = (a: AgentInfo) => { selectedRef.current = a.name; setCreating(false); setSelected(a.name); fillForm(a); setMessage(null); };
  const startCreate = () => { selectedRef.current = null; setCreating(true); setSelected(null); clearForm(); setMessage(null); setCreateScope(canEditProject ? "project" : "user"); };
  const cancelCreate = () => {
    setCreating(false); setMessage(null);
    if (agents[0]) { selectedRef.current = agents[0].name; setSelected(agents[0].name); fillForm(agents[0]); }
    else { selectedRef.current = null; clearForm(); setSelected(null); }
  };
  const unpack = async () => {
    const requestGeneration = loadGenerationRef.current;
    const requestCwd = cwd;
    const isCurrent = () => loadGenerationRef.current === requestGeneration && cwdRef.current === requestCwd;
    setSaving(true); setMessage(null);
    try {
      const scope: "user" | "project" = canEditProject ? "project" : "user";
      const res = await fetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "unpack", scope, cwd: scope === "project" ? cwd : undefined }) });
      const data = (await res.json()) as { error?: string; total?: number; written?: number };
      if (!res.ok || data.error) {
        if (isCurrent() && res.status === 403 && scope === "project") setWorkspaceUnavailable(true);
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      if (!isCurrent()) return;
      const count = data.written ?? data.total ?? 0;
      toast.success(t("agentsConfig.unpackedToast", { count }));
      setMessage(t("agentsConfig.unpackedMsg", { count, scope: scope === "project" ? t("agentsConfig.scopeProject") : t("agentsConfig.scopeUser") }));
      await load();
    } catch (e) { if (!isCurrent()) return; const msg = e instanceof Error ? e.message : String(e); setMessage(msg); toast.error(t("agentsConfig.unpackFailed"), msg); }
    finally { if (cwdRef.current === requestCwd) setSaving(false); }
  };
  const save = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) { setMessage(t("agentsConfig.nameRequired")); return; }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trimmedName)) { setMessage(t("agentsConfig.namePatternError")); return; }
    if (!description.trim()) { setMessage(t("agentsConfig.descriptionRequired")); return; }
    const requestGeneration = loadGenerationRef.current;
    const requestCwd = cwd;
    const isCurrent = () => loadGenerationRef.current === requestGeneration && cwdRef.current === requestCwd;
    setSaving(true); setMessage(null);
    try {
      const payload: Record<string, unknown> = { description: description.trim(), body: body || undefined };
      // Preserve OMP frontmatter that this compact editor does not expose;
      // the service overlays the fields edited below and always rewrites name.
      if (!creating && active?.rawFrontmatter) payload.existingFrontmatter = active.rawFrontmatter;
      if (modelCsv.trim()) payload.model = splitCsv(modelCsv);
      if (toolsCsv.trim()) payload.tools = splitCsv(toolsCsv);
      if (spawnsCsv.trim()) payload.spawns = spawnsCsv.trim() === "*" ? "*" : splitCsv(spawnsCsv);
      if (thinkingLevel) payload.thinkingLevel = thinkingLevel;
      const scope: "user" | "project" = creating ? createScope : active && active.scope !== "bundled" ? (active.scope as "user" | "project") : canEditProject ? "project" : "user";
      if (scope === "project" && !canEditProject) {
        setMessage(t("agentsConfig.selectWorkspaceRequired"));
        return;
      }
      const previousName = creating || isBundledActive || !active ? undefined : fileStem(active.filePath);
      const res = await fetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: scope === "project" ? cwd : undefined, scope, name: trimmedName, previousName, agent: payload }) });
      const data = (await res.json()) as { error?: string };
      if (!res.ok || data.error) {
        if (isCurrent() && res.status === 403 && scope === "project") setWorkspaceUnavailable(true);
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      if (!isCurrent()) return;
      toast.success(creating ? t("agentsConfig.agentCreatedToast", { name: trimmedName }) : t("agentsConfig.agentSavedToast", { name: trimmedName }));
      setMessage(creating ? t("agentsConfig.agentCreatedMsg") : t("agentsConfig.agentSavedMsg"));
      selectedRef.current = trimmedName; setCreating(false); setSelected(trimmedName); await load(true);
    } catch (e) { if (!isCurrent()) return; const msg = e instanceof Error ? e.message : String(e); setMessage(msg); toast.error(t("agentsConfig.saveError"), msg); }
    finally { if (cwdRef.current === requestCwd) setSaving(false); }
  };
  const remove = async () => {
    if (!active || active.scope === "bundled" || activeProjectUnavailable) return;
    const requestGeneration = loadGenerationRef.current;
    const requestCwd = cwd;
    const isCurrent = () => loadGenerationRef.current === requestGeneration && cwdRef.current === requestCwd;
    setSaving(true); setMessage(null);
    try {
      const res = await fetch("/api/agents", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: active.scope === "project" ? cwd : undefined, scope: active.scope, name: fileStem(active.filePath) }) });
      const data = (await res.json()) as { error?: string };
      if (!res.ok || data.error) {
        if (isCurrent() && res.status === 403 && active.scope === "project") setWorkspaceUnavailable(true);
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      if (!isCurrent()) return;
      toast.success(t("agentsConfig.agentRemovedToast", { name: active.name }));
      setMessage(t("agentsConfig.agentRemovedMsg")); selectedRef.current = null; setSelected(null); clearForm(); await load();
    } catch (e) { if (!isCurrent()) return; const msg = e instanceof Error ? e.message : String(e); setMessage(msg); toast.error(t("agentsConfig.removeError"), msg); }
    finally { if (cwdRef.current === requestCwd) setSaving(false); }
  };
  const copyPath = async (p: string) => {
    try { await navigator.clipboard.writeText(p); toast.success(t("agentsConfig.pathCopied")); }
    catch { setMessage(p); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text)" }}>
          <Bot size={14} aria-hidden="true" />
          <span>{t("agentsConfig.allAgents", { count: counts.total })}</span>
          <span style={{ color: "var(--text-muted)", font: "11px var(--font-mono)" }}>
            {t("agentsConfig.countsSummary", { bundled: counts.bundled, user: counts.user, project: counts.project })}
          </span>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          <button type="button" onClick={() => void load()} disabled={loading} title={t("agentsConfig.reload")} style={{ padding: "5px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: loading ? "wait" : "pointer", display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12 }}>
            <RefreshCw size={13} aria-hidden="true" /> {t("agentsConfig.reload")}
          </button>
          <button type="button" onClick={() => void unpack()} disabled={saving || workspaceCheckPending} title={workspaceUnavailable ? t("agentsConfig.workspaceUnavailableWarning") : workspaceCheckPending ? t("agentsConfig.loadingAgents") : t("agentsConfig.unpackBundled")} style={{ padding: "5px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: saving || workspaceCheckPending ? "wait" : "pointer", fontSize: 12 }}>
            {t("agentsConfig.unpackBundled")}
          </button>
          <button type="button" onClick={startCreate} disabled={workspaceCheckPending} title={workspaceCheckPending ? t("agentsConfig.loadingAgents") : t("agentsConfig.newAgent")} style={{ padding: "5px 10px", border: "1px solid var(--accent)", borderRadius: "var(--radius-control)", background: "var(--accent)", color: "white", cursor: workspaceCheckPending ? "wait" : "pointer", opacity: workspaceCheckPending ? 0.65 : 1, display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12 }}>
            <Plus size={13} aria-hidden="true" /> {t("agentsConfig.newAgent")}
          </button>
        </div>
      </div>
      {workspaceUnavailable ? (
        <div role="status" style={{ display: "flex", alignItems: "flex-start", gap: 7, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>
          <AlertCircle size={13} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1, color: "var(--accent-strong)" }} />
          <span>{t("agentsConfig.workspaceUnavailableWarning")}</span>
        </div>
      ) : null}
      {diagnostics.length > 0 ? (
        <div role="status" style={{ padding: "7px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text-muted)", fontSize: 11, lineHeight: 1.4 }}>
          {diagnostics.map((diagnostic, index) => (
            <div key={`${diagnostic.type ?? "diagnostic"}-${index}`}>{diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : ""}{diagnostic.message ?? "Agent discovery reported an issue."}</div>
          ))}
        </div>
      ) : null}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)" }}>
        <Search size={13} aria-hidden="true" style={{ color: "var(--text-muted)", flexShrink: 0 }} />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("agentsConfig.searchPlaceholder")} aria-label={t("agentsConfig.filterAgentsAria")} style={{ flex: 1, border: "none", outline: "none", background: "transparent", color: "var(--text)", font: "12px var(--font-mono)" }} />
        {search ? (
          <button type="button" onClick={() => setSearch("")} style={{ border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>
            {t("agentsConfig.clear")}
          </button>
        ) : null}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "0.38fr 1fr", gap: 12, minHeight: 380, alignItems: "start" }}>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", overflow: "hidden", display: "flex", flexDirection: "column", maxHeight: 520 }}>
          <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)", fontSize: 11, color: "var(--text-muted)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>{tn("agentsConfig.agentsCount", filtered.length)}</span>
            {loading ? <span style={{ color: "var(--text-dim)" }}>{t("agentsConfig.loadingAgents")}</span> : null}
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {filtered.length === 0 ? (
              <div style={{ padding: 16, fontSize: 12, color: "var(--text-muted)", textAlign: "center" }}>
                {loading ? t("agentsConfig.loadingAgents") : search ? t("agentsConfig.noMatch") : t("agentsConfig.noAgentsFound")}
              </div>
            ) : (
              filtered.map((a) => {
                const isSelected = !creating && selected === a.name;
                const dot = !a.valid ? "var(--status-error, #e5484d)" : a.enabled ? "var(--accent)" : "var(--border)";
                const badgeBg = a.scope === "bundled" ? "var(--bg-subtle)" : "color-mix(in srgb, var(--accent) 12%, transparent)";
                return (
                  <button key={a.name} type="button" onClick={() => pick(a)} style={{ width: "100%", textAlign: "left", display: "flex", gap: 8, padding: "9px 10px", border: "none", borderLeft: isSelected ? "2px solid var(--accent)" : "2px solid transparent", background: isSelected ? "var(--bg-selected)" : "transparent", cursor: "pointer", alignItems: "flex-start" }}>
                    <span aria-hidden="true" style={{ marginTop: 5, width: 7, height: 7, borderRadius: "50%", background: dot, flexShrink: 0 }} />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
                        <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 999, background: badgeBg, color: "var(--text-muted)", border: "1px solid var(--border)", flexShrink: 0 }}>{a.scope}</span>
                        {!a.valid ? <AlertCircle size={11} aria-hidden="true" style={{ color: "var(--status-error, #e5484d)" }} /> : null}
                      </span>
                      <span style={{ display: "block", marginTop: 2, fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.description || "—"}</span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", overflow: "hidden", display: "flex", flexDirection: "column", minHeight: 380 }}>
          {creating || active ? (
            <>
              {isBundledActive ? (
                <div style={{ padding: "8px 10px", background: "color-mix(in srgb, var(--accent) 10%, var(--bg-panel))", borderBottom: "1px solid var(--border)", fontSize: 11, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
                  <AlertCircle size={12} aria-hidden="true" /> {t("agentsConfig.bundledReadOnlyWarning", { scope: canEditProject ? t("agentsConfig.scopeProject") : t("agentsConfig.scopeUser") })}
                </div>
              ) : null}
              <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12, overflowY: "auto" }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", display: "flex", alignItems: "center", gap: 6 }}>
                      <Bot size={14} aria-hidden="true" />{creating ? t("agentsConfig.newAgent") : active?.name}
                    </div>
                    {!creating && active ? (
                      <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 6, font: "11px var(--font-mono)", color: "var(--text-muted)" }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shorten(active.filePath)}</span>
                        <button type="button" onClick={() => void copyPath(active.filePath)} title={t("agentsConfig.copyFilePath")} style={{ padding: "2px 6px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11 }}>
                          <Copy size={11} aria-hidden="true" /> {t("agentsConfig.copy")}
                        </button>
                      </div>
                    ) : (
                      <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-muted)" }}>{t("agentsConfig.createAgentDesc")}</div>
                    )}
                  </div>
                  {creating ? (
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-muted)" }}>
                      {t("agentsConfig.scope")}
                      <select value={createScope} onChange={(e) => setCreateScope(e.target.value as "user" | "project")} style={{ ...nativeSelectStyle, fontSize: 11, minHeight: 28 }}>
                        <option value="user">{t("agentsConfig.scopeUser")}</option>
                        <option value="project" disabled={!canEditProject}>{t("agentsConfig.scopeProject")}</option>
                      </select>
                    </label>
                  ) : null}
                </div>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("agentsConfig.name")}</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="designer" style={inputStyle} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("agentsConfig.description")}</span>
                  <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("agentsConfig.descPlaceholder")} rows={2} style={textareaStyle} />
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("agentsConfig.modelRoles")}</span>
                    <input value={modelCsv} onChange={(e) => setModelCsv(e.target.value)} placeholder="@designer, @smol" style={inputStyle} />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("agentsConfig.thinkingLevel")}</span>
                    <select value={thinkingLevel} onChange={(e) => setThinkingLevel(e.target.value)} style={nativeSelectStyle}>
                      {THINKING_LEVELS.map((lv) => <option key={lv} value={lv}>{lv || t("agentsConfig.defaultThinking")}</option>)}
                    </select>
                  </label>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("agentsConfig.spawns")}</span>
                    <input value={spawnsCsv} onChange={(e) => setSpawnsCsv(e.target.value)} placeholder="task, reviewer  or  *" style={inputStyle} />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("agentsConfig.tools")}</span>
                    <input value={toolsCsv} onChange={(e) => setToolsCsv(e.target.value)} placeholder="read, edit, bash, task" style={inputStyle} />
                  </label>
                </div>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("agentsConfig.systemPrompt")}</span>
                  <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder={t("agentsConfig.systemPromptPlaceholder")} rows={6} style={{ ...textareaStyle, minHeight: 140 }} />
                </label>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <button type="button" onClick={() => void save()} disabled={saving || workspaceCheckPending || activeProjectUnavailable} title={workspaceCheckPending ? t("agentsConfig.loadingAgents") : activeProjectUnavailable ? t("agentsConfig.workspaceUnavailableWarning") : creating ? t("agentsConfig.create") : t("agentsConfig.save")} style={{ padding: "7px 14px", border: "1px solid var(--accent)", borderRadius: "var(--radius-control)", background: "var(--accent)", color: "white", cursor: saving || workspaceCheckPending || activeProjectUnavailable ? "not-allowed" : "pointer", opacity: workspaceCheckPending || activeProjectUnavailable ? 0.65 : 1, display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600 }}>
                    <Check size={13} aria-hidden="true" /> {creating ? t("agentsConfig.create") : t("agentsConfig.save")}
                  </button>
                  {creating ? (
                    <button type="button" onClick={cancelCreate} disabled={saving} style={{ padding: "7px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", cursor: "pointer", fontSize: 12 }}>{t("agentsConfig.cancel")}</button>
                  ) : (
                    <button type="button" onClick={() => void remove()} disabled={saving || isBundledActive || activeProjectUnavailable} title={isBundledActive ? t("agentsConfig.templatesNotice") : activeProjectUnavailable ? t("agentsConfig.workspaceUnavailableWarning") : t("agentsConfig.remove")} style={{ padding: "7px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: isBundledActive || activeProjectUnavailable ? "var(--text-dim)" : "var(--status-error, #e5484d)", cursor: isBundledActive || saving || activeProjectUnavailable ? "not-allowed" : "pointer", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                      <Trash2 size={13} aria-hidden="true" /> {t("agentsConfig.remove")}
                    </button>
                  )}
                  {message ? <span style={{ fontSize: 11, color: message.toLowerCase().includes("fail") || message.toLowerCase().includes("error") ? "var(--status-error, #e5484d)" : "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{message}</span> : null}
                </div>
                <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>{t("agentsConfig.atomicNotice")}</p>
              </div>
            </>
          ) : (
            <div style={{ padding: 24, display: "flex", flexDirection: "column", alignItems: "center", gap: 8, textAlign: "center", color: "var(--text-muted)" }}>
              <Bot size={22} aria-hidden="true" style={{ color: "var(--text-dim)" }} />
              <div style={{ fontSize: 12 }}>{loading ? t("agentsConfig.loadingAgents") : filtered.length ? t("agentsConfig.selectAgentToEdit") : t("agentsConfig.noAgentsYet")}</div>
              <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("agentsConfig.templatesNotice")}</div>
              <button type="button" onClick={startCreate} disabled={workspaceCheckPending} title={workspaceCheckPending ? t("agentsConfig.loadingAgents") : t("agentsConfig.newAgent")} style={{ marginTop: 6, padding: "6px 12px", border: "1px solid var(--accent)", borderRadius: "var(--radius-control)", background: "var(--accent)", color: "white", cursor: workspaceCheckPending ? "not-allowed" : "pointer", opacity: workspaceCheckPending ? 0.65 : 1, fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5 }}>
                <Plus size={13} aria-hidden="true" /> {t("agentsConfig.newAgent")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
