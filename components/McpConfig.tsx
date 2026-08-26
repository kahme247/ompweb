"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Plus, RefreshCw, Trash2, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { useI18n } from "@/lib/i18n";
import { useIsMobile } from "@/hooks/useIsMobile";

type McpServer = { name: string; config: Record<string, unknown> };
// User-level servers arrive as a sanitized DTO (no raw config — env/headers
// can hold credentials and are never serialized); summary fields are computed
// server-side from the config.
type McpUserConfig = { path: string; servers: Array<{ name: string; status: string; type: string; enabled: boolean; valid: boolean }>; disabledServers: string[]; error?: string };
type McpLiveStatus = "connected" | "connecting" | "not_connected" | "inactive" | "disabled" | "configured";
type McpLiveServer = { name: string; source: string; status: McpLiveStatus; type?: string };

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
  const isMobile = useIsMobile();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [userConfig, setUserConfig] = useState<McpUserConfig | null>(null);
  const [liveServers, setLiveServers] = useState<McpLiveServer[] | null>(null);
  const [inventory, setInventory] = useState<McpLiveServer[] | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [source, setSource] = useState(newServer);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [mobileEditing, setMobileEditing] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (cwd) params.set("cwd", cwd);
      if (sessionId) params.set("sessionId", sessionId);
      const response = await fetch(`/api/mcp?${params}`);
      const data = await response.json() as { servers?: McpServer[]; user?: McpUserConfig; inventory?: McpLiveServer[]; liveServers?: McpLiveServer[]; liveError?: string; path?: string; error?: string };
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      setServers(data.servers ?? []);
      setUserConfig(data.user ?? null);
      setLiveServers(Array.isArray(data.liveServers) ? data.liveServers : null);
      setInventory(Array.isArray(data.inventory) ? data.inventory : null);
      setLiveError(data.liveError ?? null);
      setPath(data.path ?? null);
      setSelected((current) => current && data.servers?.some((server) => server.name === current) ? current : null);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setMessage(detail);
      toast.error(t("mcpConfig.loadError"), detail);
    } finally {
      setLoading(false);
    }
  }, [cwd, sessionId, t]);

  useEffect(() => { void load(); }, [load]);

  const choose = (server: McpServer) => {
    setSelected(server.name);
    setName(server.name);
    setSource(JSON.stringify(server.config, null, 2));
    setMessage(null);
    if (isMobile) setMobileEditing(true);
  };

  const add = () => {
    setSelected(null);
    setName("");
    setSource(newServer());
    setMessage(null);
    if (isMobile) setMobileEditing(true);
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
      toast.success(t("mcpConfig.validConfig"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setMessage(detail);
      toast.error(t("mcpConfig.invalidConfig"), detail);
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
      setSelected(name);
      setMessage(t("mcpConfig.savedMsg"));
      toast.success(t("mcpConfig.serverSaved", { name }));
      if (isMobile) setMobileEditing(false);
      await load();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setMessage(detail);
      toast.error(t("mcpConfig.saveError"), detail);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/mcp?cwd=${encodeURIComponent(cwd ?? "")}&name=${encodeURIComponent(selected)}`, { method: "DELETE" });
      const data = await response.json() as { error?: string };
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      const removed = selected;
      add();
      if (isMobile) setMobileEditing(false);
      setMessage(t("mcpConfig.removedMsg"));
      toast.success(t("mcpConfig.serverRemoved", { name: removed }));
      await load();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setMessage(detail);
      toast.error(t("mcpConfig.removeError"), detail);
    } finally {
      setSaving(false);
    }
  };

  const displayedServers = liveServers ?? inventory;

  return <>
    <section style={{ marginTop: 12, border: "1px solid var(--border)", borderRadius: "var(--radius-card)", overflow: "hidden", background: "var(--bg-panel)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
        <strong style={{ fontSize: 12, color: "var(--text)" }}>{t("mcpConfig.configuredServers")}</strong>
        <button type="button" title={t("mcpConfig.refreshLiveStatus")} aria-label={t("mcpConfig.refreshLiveStatus")} onClick={() => void load()} disabled={loading} className="ui-focus-ring" style={{ marginLeft: "auto", width: 24, height: 24, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: loading ? "wait" : "pointer" }}>
          <RefreshCw size={14} />
        </button>
      </div>
      <div style={{ padding: 12, display: "grid", gap: 12 }}>
        {displayedServers !== null ? (
          <div style={{ display: "grid", gap: 10 }}>
            {Array.from(new Set(displayedServers.map((server) => server.source))).map((sourceName) => (
              <div key={sourceName} style={{ display: "grid", gap: 4 }}>
                <div style={{ color: "var(--text-muted)", fontSize: 11 }}>{sourceName}</div>
                {displayedServers.filter((server) => server.source === sourceName).map((server) => {
                  const active = server.status === "connected";
                  const muted = server.status === "not_connected" || server.status === "connecting";
                  return (
                    <div key={`${sourceName}:${server.name}`} style={{ display: "flex", alignItems: "center", gap: 6, color: muted ? "var(--text-muted)" : server.status === "disabled" ? "var(--text-dim)" : "var(--text)", fontSize: 11 }}>
                      <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: active ? "var(--accent)" : "var(--border)" }} />
                      <code style={{ color: active ? "var(--text)" : "inherit" }}>{server.name}</code>
                      <span>{server.status.replace("_", " ")}{server.type ? ` [${server.type}]` : ""}</span>
                    </div>
                  );
                })}
              </div>
            ))}
            {!loading && displayedServers.length === 0 && <div style={{ color: "var(--text-dim)", fontSize: 11 }}>{t("mcpConfig.noMcpServers")}</div>}
          </div>
        ) : (
          <>
            <div style={{ color: "var(--text-muted)", fontSize: 11 }}>{t("mcpConfig.userLevel", { path: userConfig?.path ?? "Loading..." })}</div>
            {liveError && <div role="status" style={{ color: "var(--text-muted)", fontSize: 11 }}>{t("mcpConfig.liveStatusUnavailable", { error: liveError })}</div>}
            {userConfig?.error ? (
              <div role="status" style={{ color: "var(--status-error)", fontSize: 11 }}>{userConfig.error}</div>
            ) : (
              <div style={{ display: "grid", gap: 4 }}>
                {(userConfig?.servers ?? []).map((server) => (
                  <div key={server.name} style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-muted)", fontSize: 11 }}>
                    <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: server.valid && server.enabled ? "var(--accent)" : "var(--border)" }} />
                    <code style={{ color: "var(--text)" }}>{server.name}</code>
                    <span>{server.enabled ? "enabled" : "disabled"} [{server.type}]</span>
                  </div>
                ))}
                {(userConfig?.disabledServers ?? []).map((name) => (
                  <div key={name} style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-dim)", fontSize: 11 }}>
                    <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--border)" }} />
                    <code>{name}</code>
                    <span>disabled</span>
                  </div>
                ))}
                {!loading && (userConfig?.servers.length ?? 0) === 0 && (userConfig?.disabledServers.length ?? 0) === 0 && <div style={{ color: "var(--text-dim)", fontSize: 11 }}>{t("mcpConfig.noOmpServers")}</div>}
              </div>
            )}
          </>
        )}
      </div>
    </section>
    {cwd && (
      <div style={{ marginTop: 12, border: "1px solid var(--border)", borderRadius: "var(--radius-card)", overflow: "hidden", background: "var(--bg-panel)" }}>
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
        {isMobile ? (
          mobileEditing ? (
            <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingBottom: 8, borderBottom: "1px solid var(--border)" }}>
                <button
                  type="button"
                  onClick={() => setMobileEditing(false)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 2,
                    border: "none",
                    background: "transparent",
                    color: "var(--accent)",
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  <ChevronLeft size={16} /> {t("mcpConfig.backToList") || t("common.back")}
                </button>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                  {name || t("mcpConfig.addServer")}
                </span>
              </div>
              <label style={{ display: "block", color: "var(--text-muted)", fontSize: 12 }}>
                {t("mcpConfig.serverName")}
                <input value={name} onChange={(event) => setName(event.target.value)} placeholder="filesystem" style={{ ...inputStyle, marginTop: 6, height: 36 }} />
              </label>
              <label style={{ display: "block", color: "var(--text-muted)", fontSize: 12 }}>
                {t("mcpConfig.serverConfigJson")}
                <textarea value={source} onChange={(event) => setSource(event.target.value)} spellCheck={false} rows={8} style={{ ...inputStyle, marginTop: 6, resize: "vertical", lineHeight: 1.45 }} />
              </label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
                <button type="button" onClick={() => void check()} disabled={saving} style={{ flex: 1, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4, padding: "8px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text)", cursor: saving ? "wait" : "pointer", fontSize: 12 }}>
                  <Check size={13} /> {t("mcpConfig.check")}
                </button>
                <button type="button" onClick={() => void save()} disabled={saving || !name.trim()} style={{ flex: 1, padding: "8px 12px", border: "none", borderRadius: "var(--radius-control)", background: "var(--accent)", color: "var(--on-accent)", cursor: saving || !name.trim() ? "default" : "pointer", fontSize: 12, fontWeight: 600 }}>
                  {saving ? t("mcpConfig.saving") : t("mcpConfig.saveServer")}
                </button>
                {selected && (
                  <button type="button" onClick={() => void remove()} disabled={saving} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4, padding: "8px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--status-error)", cursor: saving ? "wait" : "pointer", fontSize: 12 }}>
                    <Trash2 size={13} /> {t("mcpConfig.remove")}
                  </button>
                )}
              </div>
              {message && <div role="status" style={{ color: "var(--text-muted)", fontSize: 11, lineHeight: 1.4 }}>{message}</div>}
            </div>
          ) : (
            <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
              {servers.map((server) => {
                const summary = serverSummary(server.config);
                return (
                  <div
                    key={server.name}
                    onClick={() => choose(server)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "10px 12px",
                      borderRadius: "var(--radius-control)",
                      background: "var(--bg)",
                      border: "1px solid var(--border)",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0, paddingRight: 8 }}>
                      <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: summary.valid ? (summary.enabled ? "var(--status-success)" : "var(--border)") : "var(--status-error)" }} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-mono)" }}>
                          {server.name}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                          {summary.type}{summary.enabled ? " · enabled" : " · disabled"}{!summary.valid ? " · invalid" : ""}
                        </div>
                      </div>
                    </div>
                    <ChevronRight size={16} style={{ color: "var(--text-dim)", flexShrink: 0 }} />
                  </div>
                );
              })}
              {!loading && servers.length === 0 && <div style={{ padding: "8px 10px", color: "var(--text-dim)", fontSize: 12 }}>{t("mcpConfig.noServers")}</div>}
              <button
                type="button"
                onClick={add}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  width: "100%",
                  marginTop: 6,
                  padding: "10px 12px",
                  border: "1px dashed var(--border)",
                  borderRadius: "var(--radius-control)",
                  background: "transparent",
                  color: "var(--accent)",
                  fontWeight: 500,
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                <Plus size={14} /> {t("mcpConfig.addServer")}
              </button>
            </div>
          )
        ) : (
          <div className="mcp-editor-grid" style={{ display: "grid", gridTemplateColumns: "minmax(120px, 0.35fr) minmax(0, 1fr)", minHeight: 250 }}>
            <div style={{ borderRight: "1px solid var(--border)", padding: 6 }}>
              {servers.map((server) => {
                const summary = serverSummary(server.config);
                return (
                  <button key={server.name} type="button" onClick={() => choose(server)} title={`${server.name} — ${summary.type} · ${summary.target || "invalid"}`} style={{ display: "block", width: "100%", padding: "7px 8px", border: "none", borderRadius: 5, background: selected === server.name ? "var(--bg-selected)" : "transparent", color: "var(--text)", textAlign: "left", font: "11px var(--font-mono)", cursor: "pointer", overflow: "hidden" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 5, overflow: "hidden" }}>
                      <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: summary.valid ? (summary.enabled ? "var(--accent)" : "var(--border)") : "var(--status-error)" }} />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{server.name}</span>
                    </span>
                    <span style={{ display: "block", marginTop: 2, fontSize: 9, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {summary.type}{summary.enabled ? "" : " · off"}{!summary.valid ? " · invalid" : ""}
                      {summary.target ? ` · ${summary.target}` : ""}
                    </span>
                  </button>
                );
              })}
              {!loading && servers.length === 0 && <div style={{ padding: "7px 8px", color: "var(--text-dim)", fontSize: 11 }}>{t("mcpConfig.noServers")}</div>}
              <button type="button" onClick={add} style={{ display: "flex", alignItems: "center", gap: 4, width: "100%", marginTop: 5, padding: "6px 8px", border: "1px dashed var(--border)", borderRadius: 5, background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}><Plus size={13} /> {t("mcpConfig.addServer")}</button>
            </div>
            <div style={{ minWidth: 0, padding: 12 }}>
              <label style={{ display: "block", color: "var(--text-muted)", fontSize: 11 }}>{t("mcpConfig.serverName")}<input value={name} onChange={(event) => setName(event.target.value)} placeholder="filesystem" style={{ ...inputStyle, marginTop: 4 }} /></label>
              <label style={{ display: "block", marginTop: 9, color: "var(--text-muted)", fontSize: 11 }}>{t("mcpConfig.serverConfigJson")}<textarea value={source} onChange={(event) => setSource(event.target.value)} spellCheck={false} style={{ ...inputStyle, minHeight: 125, marginTop: 4, resize: "vertical", lineHeight: 1.45 }} /></label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 9 }}>
                <button type="button" onClick={() => void check()} disabled={saving} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "6px 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text)", cursor: saving ? "wait" : "pointer", fontSize: 11 }}>
                  <Check size={13} /> {t("mcpConfig.check")}
                </button>
                <button type="button" onClick={() => void save()} disabled={saving || !name.trim()} style={{ padding: "6px 9px", border: "none", borderRadius: "var(--radius-control)", background: "var(--accent)", color: "var(--on-accent)", cursor: saving || !name.trim() ? "default" : "pointer", fontSize: 11 }}>
                  {saving ? t("mcpConfig.saving") : t("mcpConfig.saveServer")}
                </button>
                {selected && (
                  <button type="button" onClick={() => void remove()} disabled={saving} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "6px 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text-muted)", cursor: saving ? "wait" : "pointer", fontSize: 11 }}>
                    <Trash2 size={13} /> {t("mcpConfig.remove")}
                  </button>
                )}
              </div>
              {message && <div role="status" style={{ marginTop: 9, color: "var(--text-muted)", fontSize: 11, lineHeight: 1.4 }}>{message}</div>}
            </div>
          </div>
        )}
      </div>
    )}
  </>;
}
