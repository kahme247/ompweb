"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Info, LoaderCircle, Plus, RefreshCw, RotateCw, Server, Trash2 } from "lucide-react";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { Alert } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { useI18n } from "@/lib/i18n";

type McpServer = { name: string; config: Record<string, unknown> };
// User-level servers arrive as a sanitized DTO (no raw config — env/headers
// can hold credentials and are never serialized); summary fields are computed
// server-side from the config.
type McpUserConfig = { path: string; servers: Array<{ name: string; status: string; type: string; enabled: boolean; valid: boolean }>; disabledServers: string[]; error?: string };
type McpLiveStatus = "connected" | "connecting" | "not_connected" | "inactive" | "disabled" | "configured";
type McpLiveServer = { name: string; source: string; status: McpLiveStatus; type?: string; sourcePath?: string };
type McpResponse = { servers?: McpServer[]; user?: McpUserConfig; inventory?: McpLiveServer[]; liveServers?: McpLiveServer[]; liveError?: string; path?: string; error?: string };

const inputStyle = { width: "100%", padding: "7px 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", font: "12px var(--font-mono)" } as const;

const newServer = () => JSON.stringify({ type: "stdio", command: "", args: [] }, null, 2);

function serverSummary(config: Record<string, unknown>): { type: string; target: string; enabled: boolean; valid: boolean } {
  const type = typeof config.type === "string" && config.type !== "stdio" ? config.type : "stdio";
  const command = typeof config.command === "string" ? config.command.trim() : "";
  const url = typeof config.url === "string" ? config.url.trim() : "";
  const hasCommand = command.length > 0;
  const hasUrl = url.length > 0;
  const valid = (hasCommand || hasUrl) && !(hasCommand && hasUrl) && (type === "http" || type === "sse" ? hasUrl : hasCommand);
  return {
    type,
    target: type === "http" || type === "sse" ? url : `${command}${Array.isArray(config.args) ? " " + config.args.join(" ") : ""}`.trim(),
    enabled: config.enabled !== false,
    valid,
  };
}

export function McpConfig({ cwd, sessionId }: { cwd: string | null; sessionId?: string | null }) {
  const { t } = useI18n();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [userConfig, setUserConfig] = useState<McpUserConfig | null>(null);
  const [liveServers, setLiveServers] = useState<McpLiveServer[] | null>(null);
  const [inventory, setInventory] = useState<McpLiveServer[] | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // Mirror of `selected` for load(): the editor must be blanked when the
  // selected server disappears (workspace switch or external delete), but a
  // fresh "add server" draft (selected === null) survives a plain refresh.
  const selectedRef = useRef<string | null>(null);
  const loadedCwdRef = useRef<string | null | undefined>(undefined);
  const [name, setName] = useState("");
  const [source, setSource] = useState(newServer);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const [changing, setChanging] = useState<string | null>(null);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setMessage(null);
    setLiveError(null);
    try {
      const params = new URLSearchParams();
      if (cwd) params.set("cwd", cwd);
      if (sessionId) {
        params.set("sessionId", sessionId);
        // Fresh-spawn opinion for the MCP route (same localStorage key the
        // chat-switch effect reads): without it a spawn here plants a
        // non-advisor child that a concurrent prompt then reuses.
        try {
          if (localStorage.getItem(`omp-advisor-enabled:${sessionId}`) === "true") params.set("advisor", "1");
        } catch {
          // Private mode: omit the opinion, spawn defaults apply.
        }
      }

      const read = async (includeLive: boolean): Promise<McpResponse> => {
        const requestParams = new URLSearchParams(params);
        requestParams.set("live", includeLive ? "1" : "0");
        const response = await fetch(`/api/mcp?${requestParams}`);
        const data = await response.json() as McpResponse;
        if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
        return data;
      };

      const data = await read(false);
      if (generation !== loadGeneration.current) return;
      setServers(data.servers ?? []);
      setUserConfig(data.user ?? null);
      setLiveServers(Array.isArray(data.liveServers) ? data.liveServers : null);
      setInventory(Array.isArray(data.inventory) ? data.inventory : null);
      setLiveError(data.liveError ?? null);
      setPath(data.path ?? null);
      // A workspace switch always blanks the editor: a name/source typed for
      // the old project must never be saved into the new one. Otherwise,
      // only a dropped selection blanks it — a server deleted elsewhere
      // while it was selected leaves the same stale editor behind.
      const workspaceChanged = loadedCwdRef.current !== undefined && loadedCwdRef.current !== cwd;
      loadedCwdRef.current = cwd;
      const kept = workspaceChanged ? null : (selectedRef.current && data.servers?.some((server) => server.name === selectedRef.current) ? selectedRef.current : null);
      const dropped = selectedRef.current !== null && kept === null;
      selectedRef.current = kept;
      setSelected(kept);
      if (workspaceChanged || dropped) {
        setName("");
        setSource(newServer());
      }

      // Live status can start or reuse an OMP child and wait for /mcp list.
      // Keep it off the initial paint path; the static inventory is already
      // useful and the live result can replace it when the command responds.
      if (sessionId) {
        await read(true).then((liveData) => {
          if (generation !== loadGeneration.current) return;
          setLiveServers(Array.isArray(liveData.liveServers) ? liveData.liveServers : null);
          setLiveError(liveData.liveError ?? null);
        }).catch((error) => {
          if (generation !== loadGeneration.current) return;
          setLiveError(error instanceof Error ? error.message : String(error));
        });
      }
    } catch (error) {
      if (generation === loadGeneration.current) setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [cwd, sessionId]);

  const invalidateLoad = useCallback(() => { loadGeneration.current++; }, []);
  useEffect(() => { void load(); return invalidateLoad; }, [load, invalidateLoad]);

  const change = async (action: "enable" | "disable" | "reload", name?: string) => {
    if (!sessionId || changing) return;
    setChanging(name ?? "reload");
    setMessage(null);
    try {
      const response = await fetch("/api/mcp", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, action, name }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      toast.success(t("mcpConfig.applied"));
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setChanging(null); }
  };

  const choose = (server: McpServer) => {
    selectedRef.current = server.name;
    setSelected(server.name);
    setName(server.name);
    setSource(JSON.stringify(server.config, null, 2));
    setMessage(null);
  };

  const add = () => {
    selectedRef.current = null;
    setSelected(null);
    setName("");
    setSource(newServer());
    setMessage(null);
  };

  const parse = (): Record<string, unknown> | null => {
    try {
      const value = JSON.parse(source) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(t("mcpConfig.mustBeJsonObject"));
      return value as Record<string, unknown>;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("mcpConfig.invalidJson"));
      return null;
    }
  };

  const check = async () => {
    const server = parse();
    if (!server) return;
    setSaving(true);
    try {
      const response = await fetch("/api/mcp", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, server }) });
      const data = await response.json() as { message?: string; error?: string };
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      setMessage(data.message ?? t("mcpConfig.validConfig"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setMessage(detail);
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    const server = parse();
    if (!server) return;
    setSaving(true);
    try {
      const response = await fetch("/api/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, name, previousName: selected ?? undefined, server }) });
      const data = await response.json() as { error?: string };
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      selectedRef.current = name;
      setSelected(name);
      toast.success(t("mcpConfig.serverSaved", { name }));
      await load();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setMessage(detail);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const response = await fetch("/api/mcp", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, name: selected }) });
      const data = await response.json() as { error?: string };
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      add();
      toast.success(t("mcpConfig.serverRemoved", { name: selected }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setMessage(detail);
    } finally {
      setSaving(false);
    }
  };

  const displayedServers = liveServers ?? inventory ?? [];
  const groups = Array.from(new Set(displayedServers.map((server) => server.source))).map((source) => ({
    source,
    title: source === "User level" ? t("mcpConfig.sourceUser") : source === "Project level" ? t("mcpConfig.sourceProject") : source === "Disabled" ? t("mcpConfig.sourceDisabled") : source,
    servers: displayedServers.filter((server) => server.source === source),
    managed: ["User level", "Project level", "Disabled"].includes(source),
  }));
  const managedCount = groups.filter((group) => group.managed).reduce((sum, group) => sum + group.servers.length, 0);
  const otherGroups = groups.filter((group) => !group.managed);
  const groupView = (group: { source: string; title: string; servers: McpLiveServer[]; managed: boolean }) => {
    const paths = Array.from(new Set(group.servers.flatMap((server) => server.sourcePath ? [server.sourcePath] : [])));
    return <section className="settings-card mcp-source-card" key={group.source} aria-label={group.title}>
      <header className="mcp-source-header">
        <div className="mcp-source-title"><Server size={15} aria-hidden="true" /><h4>{group.title}</h4><span className="mcp-chip">{group.servers.length}</span></div>
        {paths.map((sourcePath) => <code key={sourcePath} className="mcp-source-path" title={sourcePath}>{sourcePath}</code>)}
      </header>
      <ul className="mcp-server-list">
        {group.servers.map((server) => {
          const shadowed = group.source === "User level" && displayedServers.some((other) => other.source === "Project level" && other.name === server.name);
          const manageable = group.managed && !shadowed;
          const statusKey = server.status === "configured" ? "enabled" : server.status === "connected" ? "statusConnected" : server.status === "connecting" ? "statusConnecting" : server.status === "disabled" ? "statusDisabled" : server.status === "inactive" ? "statusInactive" : "statusNotConnected";
          return <li className="mcp-server-row" key={server.name} aria-busy={changing === server.name}>
            <div className="mcp-server-info">
              <div className="mcp-server-title"><span className="mcp-server-name">{server.name}</span>{server.type && <span className="mcp-chip mcp-transport">{server.type}</span>}</div>
              <span className="mcp-server-status" data-status={server.status}><span aria-hidden="true" />{changing === server.name ? t("mcpConfig.applying") : t(`mcpConfig.${statusKey}`)}</span>
            </div>
            {manageable ? <div className="mcp-server-control">
              {changing === server.name && <LoaderCircle size={14} className="mcp-spin" aria-hidden="true" />}
              <ToggleSwitch checked={server.status !== "disabled"} disabled={!sessionId || loading || !!changing || saving} aria-label={t("mcpConfig.serverToggle", { name: server.name })} onChange={(enabled) => void change(enabled ? "enable" : "disable", server.name)} />
            </div> : <span className="mcp-readonly">{t(shadowed ? "mcpConfig.shadowed" : "mcpConfig.readOnly")}</span>}
          </li>;
        })}
      </ul>
    </section>;
  };

  return <>
    <section className="mcp-management" aria-label={t("mcpConfig.configuredServers")}>
      <header className="mcp-management-header">
        <div className="mcp-management-title"><h3>{t("mcpConfig.configuredServers")}</h3><span className="mcp-chip">{managedCount}</span></div>
        <div className="mcp-toolbar">
          <button className="mcp-toolbar-button ui-focus-ring" type="button" onClick={() => void change("reload")} disabled={!sessionId || loading || !!changing || saving}>
            {changing === "reload" ? <LoaderCircle size={15} className="mcp-spin" aria-hidden="true" /> : <RotateCw size={15} aria-hidden="true" />}{t(changing === "reload" ? "mcpConfig.applying" : "mcpConfig.reload")}
          </button>
          <button className="mcp-toolbar-button mcp-icon-button ui-focus-ring" type="button" title={t("mcpConfig.refreshLiveStatus")} aria-label={t("mcpConfig.refreshLiveStatus")} onClick={() => void load()} disabled={loading || !!changing || saving}><RefreshCw size={15} className={loading ? "mcp-spin" : undefined} aria-hidden="true" /></button>
        </div>
      </header>
      <p className="mcp-management-description">{t(sessionId ? "mcpConfig.applyHint" : "mcpConfig.selectSessionHint")}</p>
      <div className="mcp-management-note"><Info size={14} aria-hidden="true" /><span>{t("mcpConfig.connectionHint")}</span></div>
      {liveError && <Alert description={t("mcpConfig.liveStatusUnavailable", { error: liveError })} />}
      {userConfig?.error && <Alert variant="error" description={userConfig.error} />}
      {message && <Alert description={message} onDismiss={() => setMessage(null)} />}
      {groups.filter((group) => group.managed).map(groupView)}
      {loading && displayedServers.length === 0 && <div className="mcp-empty" role="status"><LoaderCircle size={16} className="mcp-spin" aria-hidden="true" />{t("appShell.loading")}</div>}
      {!loading && managedCount === 0 && <div className="mcp-empty">{t("mcpConfig.noOmpServers")}</div>}
      {otherGroups.length > 0 && <details className="settings-card mcp-other-configs">
        <summary className="ui-focus-ring"><ChevronRight size={15} className="mcp-details-chevron" aria-hidden="true" /><span>{t("mcpConfig.otherSources")}</span><span className="mcp-chip">{otherGroups.reduce((sum, group) => sum + group.servers.length, 0)}</span></summary>
        <div className="mcp-other-content"><p className="mcp-management-description">{t("mcpConfig.otherSourcesHint")}</p>{otherGroups.map(groupView)}</div>
      </details>}
    </section>
    {cwd && <div className="settings-card mcp-editor-card" style={{ marginTop: 20, border: "1px solid var(--border)", borderRadius: "var(--radius-card)", overflow: "visible", background: "var(--bg-panel)" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
      <strong style={{ fontSize: 12, color: "var(--text)", flexShrink: 0 }}>{t("mcpConfig.projectServers")}</strong>
      <code style={{ flex: 1, minWidth: 0, color: "var(--text-dim)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{path ?? "Loading..."}</code>
      {(() => {
        const total = servers.length;
        if (total === 0) return null;
        const enabled = servers.filter((s) => serverSummary(s.config).enabled && serverSummary(s.config).valid).length;
        const invalid = servers.filter((s) => !serverSummary(s.config).valid).length;
        return <span style={{ marginLeft: 4, fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap" }}>{t("mcpConfig.serverCounts", { enabled, total })}{invalid > 0 ? t("mcpConfig.invalidSuffix", { count: invalid }) : ""}</span>;
      })()}
    </div>
    <div className="mcp-editor-grid" style={{ display: "grid", gridTemplateColumns: "minmax(120px, 0.35fr) minmax(0, 1fr)", minHeight: 250 }}>
      <div style={{ borderRight: "1px solid var(--border)", padding: 6 }}>
        {servers.map((server) => {
          const summary = serverSummary(server.config);
          return (
            <button key={server.name} className="mcp-server-select" type="button" onClick={() => choose(server)} title={`${server.name} — ${summary.type} · ${summary.target || "invalid"}`} style={{ display: "block", width: "100%", padding: "7px 8px", border: "none", borderRadius: 5, background: selected === server.name ? "var(--bg-selected)" : "transparent", color: "var(--text)", textAlign: "left", font: "11px var(--font-mono)", cursor: "pointer", overflow: "hidden" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 5, overflow: "hidden" }}>
                <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: summary.valid ? (summary.enabled ? "var(--accent)" : "var(--border)") : "var(--status-error)" }} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{server.name}</span>
              </span>
              <span style={{ display: "block", marginTop: 2, fontSize: 9, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {summary.type}{summary.enabled ? "" : ` · ${t("mcpConfig.off")}`}{!summary.valid ? ` · ${t("mcpConfig.invalid")}` : ""}
                {summary.target ? ` · ${summary.target}` : ""}
              </span>
            </button>
          );
        })}
        {!loading && servers.length === 0 && <div style={{ padding: "7px 8px", color: "var(--text-dim)", fontSize: 11 }}>{t("mcpConfig.noServers")}</div>}
        <button className="mcp-add-server" type="button" onClick={add} style={{ display: "flex", alignItems: "center", gap: 4, width: "100%", marginTop: 5, padding: "6px 8px", border: "1px dashed var(--border)", borderRadius: 5, background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}><Plus size={13} /> {t("mcpConfig.addServer")}</button>
      </div>
      <div style={{ minWidth: 0, padding: 12 }}>
        <label style={{ display: "block", color: "var(--text-muted)", fontSize: 11 }}>{t("mcpConfig.serverName")}<input className="mcp-config-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="filesystem" style={{ ...inputStyle, marginTop: 4 }} /></label>
        <label style={{ display: "block", marginTop: 9, color: "var(--text-muted)", fontSize: 11 }}>{t("mcpConfig.serverConfigJson")}<textarea className="mcp-config-input" value={source} onChange={(event) => setSource(event.target.value)} spellCheck={false} style={{ ...inputStyle, minHeight: 125, marginTop: 4, resize: "vertical", lineHeight: 1.45 }} /></label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 9 }}>
          <button className="mcp-action" type="button" onClick={() => void check()} disabled={saving} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "6px 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text)", cursor: saving ? "wait" : "pointer", fontSize: 11 }}>
            <Check size={13} /> {t("mcpConfig.check")}
          </button>
          <button className="mcp-action" type="button" onClick={() => void save()} disabled={saving || !name.trim()} style={{ padding: "6px 9px", border: "none", borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "var(--on-accent)", cursor: saving || !name.trim() ? "default" : "pointer", fontSize: 11 }}>
            {saving ? t("mcpConfig.saving") : t("mcpConfig.saveServer")}
          </button>
          {selected && (
            <button className="mcp-action" type="button" onClick={() => void remove()} disabled={saving} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "6px 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text-muted)", cursor: saving ? "wait" : "pointer", fontSize: 11 }}> 
              <Trash2 size={13} /> {t("mcpConfig.remove")}
            </button>
          )}
        </div>
      </div>
    </div>
    </div>}
  </>;
}
