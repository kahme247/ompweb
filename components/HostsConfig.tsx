"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/field";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/primitives";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import { CLUSTER_PROJECTS_DIR, clusterJoinBlock, clusterOf, isClusterMember } from "@/lib/hosts/cluster";
import type { HostRow } from "@/lib/hosts/hub";
import type { HostPool } from "@/lib/hosts/pools";
import { useI18n } from "@/lib/i18n";
import { useHostRows } from "@/hooks/useHostRows";
import { HOST_STATUS_COLOR, hostName, hostStatusText, isLocalRow, localInstallCommand } from "./host-status";
import { HostUpdates } from "./HostUpdates";

type Dialogs = { kind: "add" } | { kind: "rename"; host: HostRow } | null;

const inputStyle = { width: "100%", padding: "7px 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", font: "13px var(--font-mono)" } as const;
const buttonStyle = { padding: "6px 14px", background: "none", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", color: "var(--text-muted)", cursor: "pointer", fontSize: 13 } as const;
const primaryStyle = { ...buttonStyle, background: "var(--accent-strong)", border: "none", color: "var(--on-accent)", fontWeight: 600 } as const;

async function call(method: string, url: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `HTTP ${response.status}`);
  return data;
}

const failure = (error: unknown) => toast.error(error instanceof Error ? error.message : String(error));

export function CopyField({ label, value }: { label: string; value: string }) {
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 11, fontWeight: 500, color: "var(--text-muted)" }}>{label}</span>
      <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
        <code style={{ ...inputStyle, flex: 1, minWidth: 0, overflowWrap: "anywhere", userSelect: "all" }}>{value}</code>
        <button
          type="button"
          className="ui-focus-ring"
          style={{ ...buttonStyle, display: "inline-flex", alignItems: "center", gap: 5 }}
          onClick={() => void copyText(value).then(() => toast.success(t("hostsConfig.copied")), () => toast.error(t("hostsConfig.copyFailed")))}
        >
          <Copy size={13} aria-hidden="true" />{t("hostsConfig.copy")}
        </button>
      </div>
    </div>
  );
}

/** Name form shared by "Add host" and "Rename"; adding ends in the one-time token view. */
function HostDialog({ dialog, onClose }: { dialog: NonNullable<Dialogs>; onClose: () => void }) {
  const { t } = useI18n();
  const adding = dialog.kind === "add";
  const local = dialog.kind === "rename" && dialog.host.id === "local";
  const [label, setLabel] = useState(dialog.kind === "rename" ? dialog.host.label : "");
  const [busy, setBusy] = useState(false);
  const hintId = useId();
  const [created, setCreated] = useState<{ token: string; command: string } | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      if (dialog.kind === "add") {
        const data = await call("POST", "/api/hosts", { label });
        setCreated({ token: String(data.token), command: String(data.command) });
      } else {
        await call("PATCH", "/api/hosts", { id: dialog.host.id, label });
        onClose();
      }
    } catch (error) {
      failure(error);
    } finally {
      setBusy(false);
    }
  };

  const title = created || adding ? t("hostsConfig.addTitle") : t("hostsConfig.renameTitle");
  return (
    // The token is shown once: only Done may close it, never Escape or an outside press.
    <Dialog open onOpenChange={(open) => { if (!open && !created) onClose(); }}>
      <DialogContent ariaLabel={title} style={{ width: 520, maxWidth: "min(92vw, 520px)", padding: 22 }}>
        <DialogTitle>{title}</DialogTitle>
        {created ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--text-muted)" }}>{t("hostsConfig.tokenIntro")}</p>
            <CopyField label={t("hostsConfig.command")} value={created.command} />
            <CopyField label={t("hostsConfig.token")} value={created.token} />
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" className="ui-focus-ring" style={primaryStyle} onClick={onClose}>{t("hostsConfig.done")}</button>
            </div>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, fontWeight: 500, color: "var(--text-muted)" }}>
              {t("hostsConfig.name")}
              <input autoFocus aria-describedby={local ? hintId : undefined} value={label} maxLength={100} onChange={(event) => setLabel(event.target.value)} placeholder={local ? t("hostsConfig.thisMachine") : t("hostsConfig.namePlaceholder")} style={inputStyle} />
            </label>
            {local && <span id={hintId} style={{ marginTop: -8, fontSize: 11, color: "var(--text-dim)" }}>{t("hostsConfig.localNameHint")}</span>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="ui-focus-ring" style={buttonStyle} onClick={onClose}>{t("hostsConfig.cancel")}</button>
              <button type="submit" className="ui-focus-ring" style={{ ...primaryStyle, opacity: busy || (!local && !label.trim()) ? 0.7 : 1 }} disabled={busy || (!local && !label.trim())}>
                {adding ? t(busy ? "hostsConfig.creating" : "hostsConfig.create") : t(busy ? "hostsConfig.saving" : "hostsConfig.save")}
              </button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The folder on the joining host where the cluster keeps the checkouts it creates. Without a home folder it starts empty and stays required. */
function JoinDialog({ host, onClose }: { host: HostRow; onClose: () => void }) {
  const { t } = useI18n();
  const name = hostName(t, host);
  const [folder, setFolder] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = useId();

  useEffect(() => {
    let current = true;
    void call("GET", `/api/home?hostId=${encodeURIComponent(host.id)}`)
      .then(({ home }) => {
        if (current && typeof home === "string" && home) setFolder((typed) => typed || `${home}${home.includes("\\") ? "\\" : "/"}${CLUSTER_PROJECTS_DIR}`);
      })
      .catch(() => {});
    return () => { current = false; };
  }, [host.id]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const projectsRoot = folder.trim();
    // POSIX, drive-letter or UNC; the server applies its own rules too.
    if (!/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(projectsRoot)) return setError(t("errors.path_must_be_absolute"));
    setBusy(true);
    setError(null);
    try {
      await call("PUT", `/api/hosts/${encodeURIComponent(host.id)}/cluster`, { projectsRoot });
      onClose();
    } catch (failed) {
      setError(failed instanceof Error ? failed.message : String(failed));
      setBusy(false);
    }
  };

  const title = t("hostsConfig.joinTitle", { name });
  const noteStyle = { margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--text-muted)" } as const;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent ariaLabel={title} style={{ width: 520, maxWidth: "min(92vw, 520px)", padding: 22 }}>
        <DialogTitle>{title}</DialogTitle>
        <form onSubmit={(event) => void submit(event)} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, fontWeight: 500, color: "var(--text-muted)" }}>
            {t("hostsConfig.joinFolder", { name })}
            <input autoFocus required value={folder} aria-invalid={error !== null} aria-describedby={error ? errorId : undefined} onChange={(event) => setFolder(event.target.value)} style={inputStyle} />
          </label>
          <p style={noteStyle}>{t("hostsConfig.joinProjectsNote", { name })}</p>
          <p style={noteStyle}>{t("hostsConfig.joinCredentialsNote", { name })}</p>
          {error && <div id={errorId} role="alert" style={{ fontSize: 12, color: "var(--status-error)" }}>{error}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="ui-focus-ring" style={buttonStyle} disabled={busy} onClick={onClose}>{t("hostsConfig.cancel")}</button>
            <button type="submit" className="ui-focus-ring" style={{ ...primaryStyle, opacity: busy || !folder.trim() ? 0.7 : 1 }} disabled={busy || !folder.trim()}>{t("hostsConfig.joinConfirm")}</button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type ClusterState = { pools: HostPool[]; poolsLoaded: boolean; poolsFailed: boolean };

function HostCard({ host, cluster, onRename, onRevoke, onShare, onJoin, onLeave }: { host: HostRow; cluster: ClusterState; onRename: () => void; onRevoke: () => void; onShare: () => void; onJoin: () => void; onLeave: () => void }) {
  const { t } = useI18n();
  const name = hostName(t, host);
  const linked = "allowAgentStart" in host ? host : null;
  const member = isClusterMember(cluster.pools, host.id);
  // Unknown membership (pools not loaded) disables every switch and every share toggle; the reason is only shown once the load failed.
  // Otherwise only a non-member needs a ready host: leaving always works.
  const unavailable = !cluster.poolsLoaded && cluster.poolsFailed ? t("hostsConfig.poolsUnavailable") : null;
  const block = cluster.poolsLoaded && !member && linked ? clusterJoinBlock({ status: host.status, protocol: host.hostVersion, supports: (operation) => host.workspaceOps.includes(operation) }) : null;
  const joinReason = unavailable ?? (block === null ? null
    : block === "upgrade" || block === "needs-upgrade" ? t("hostsConfig.joinUpgrade")
      : block === "omp-missing" ? hostStatusText(t, host) : t("hostsConfig.joinOffline"));
  const reasonId = useId();
  const forcedId = useId();
  const details = [
    host.platform,
    host.hostVersion !== null && host.status !== "needs-upgrade" && t("hostsConfig.protocol", { version: host.hostVersion }),
    linked && (host.lastSeenAt ? t("hostsConfig.lastSeen", { time: new Date(host.lastSeenAt).toLocaleString() }) : t("hostsConfig.neverSeen")),
  ].filter(Boolean).join(" · ");

  return (
    <li className="settings-card" style={{ flexWrap: "wrap", listStyle: "none" }}>
      <div className="settings-card-text">
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: HOST_STATUS_COLOR[host.status] }} />
          <strong style={{ fontSize: 14, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</strong>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{hostStatusText(t, host)}</span>
        </div>
        {details && <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-dim)", overflowWrap: "anywhere" }}>{details}</div>}
        {isLocalRow(host) && host.daemonManaged && host.status === "offline" && (
          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
            {t("hostsConfig.localOfflineHint")}
            <CopyField label={t("hostsConfig.command")} value={localInstallCommand(host.serverPlatform)} />
            {t("hostsConfig.localForegroundHint")}
            <CopyField label={t("hostsConfig.command")} value="ompweb host" />
          </div>
        )}
      </div>
      <div className="settings-card-control" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", flexShrink: 1, maxWidth: "100%" }}>
        {isLocalRow(host) && clusterOf(cluster.pools) && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("hostsConfig.clusterMaster")}</span>}
        {linked && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, maxWidth: "100%", flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)", maxWidth: 200 }}>{t("hostsConfig.inCluster")}</span>
            <ToggleSwitch
              checked={member}
              disabled={!cluster.poolsLoaded || joinReason !== null}
              aria-label={t("hostsConfig.inClusterAria", { name })}
              aria-describedby={joinReason ? reasonId : undefined}
              onChange={(joining) => (joining ? onJoin() : onLeave())}
            />
            {joinReason && <span id={reasonId} style={{ fontSize: 11, color: "var(--text-dim)", maxWidth: 200 }}>{joinReason}</span>}
          </div>
        )}
        {linked && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, maxWidth: "100%" }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)", maxWidth: 200 }}>{t("hostsConfig.allowAgentStart")}</span>
            <ToggleSwitch
              checked={linked.allowAgentStart}
              aria-label={t("hostsConfig.allowAgentStartAria", { name })}
              onChange={(allowAgentStart) => void call("PATCH", "/api/hosts", { id: host.id, allowAgentStart }).catch(failure)}
            />
          </div>
        )}
        {linked && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, maxWidth: "100%", flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)", maxWidth: 200 }}>{t("hostsConfig.shareCredentials")}</span>
            <ToggleSwitch
              checked={linked.shareCredentials || member}
              disabled={member || !cluster.poolsLoaded}
              aria-label={t("hostsConfig.shareCredentialsAria", { name })}
              aria-describedby={member ? forcedId : unavailable ? reasonId : undefined}
              onChange={(shareCredentials) => { if (shareCredentials) onShare(); else void call("PATCH", "/api/hosts", { id: host.id, shareCredentials }).catch(failure); }}
            />
            {member && <span id={forcedId} style={{ fontSize: 11, color: "var(--text-dim)", maxWidth: 200 }}>{t("hostsConfig.shareForced")}</span>}
          </div>
        )}
        <button type="button" className="ui-focus-ring" aria-label={t("hostsConfig.renameAria", { name })} style={{ ...buttonStyle, display: "inline-flex", alignItems: "center", gap: 5 }} onClick={onRename}>
          <Pencil size={13} aria-hidden="true" />{t("hostsConfig.rename")}
        </button>
        {linked && (
          <button type="button" className="ui-focus-ring" style={{ ...buttonStyle, display: "inline-flex", alignItems: "center", gap: 5 }} onClick={onRevoke}>
            <Trash2 size={13} aria-hidden="true" />{t("hostsConfig.revoke")}
          </button>
        )}
      </div>
      <HostUpdates host={host} />
    </li>
  );
}

export function HostsConfig() {
  const { t } = useI18n();
  const { hosts, pools, poolsLoaded, poolsFailed, failed: loadFailed } = useHostRows();
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [revoking, setRevoking] = useState<HostRow | null>(null);
  const [sharing, setSharing] = useState<HostRow | null>(null);
  const [joining, setJoining] = useState<HostRow | null>(null);
  const [leaving, setLeaving] = useState<HostRow | null>(null);
  const [busy, setBusy] = useState(false);

  const share = async () => {
    if (!sharing) return;
    setBusy(true);
    try {
      await call("PATCH", "/api/hosts", { id: sharing.id, shareCredentials: true });
      setSharing(null);
    } catch (error) {
      failure(error);
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    if (!leaving) return;
    setBusy(true);
    try {
      await call("DELETE", `/api/hosts/${encodeURIComponent(leaving.id)}/cluster`);
      setLeaving(null);
    } catch (error) {
      failure(error);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    try {
      await call("DELETE", `/api/hosts?id=${encodeURIComponent(revoking.id)}`);
      toast.success(t("hostsConfig.revoked", { name: revoking.label }));
      setRevoking(null);
    } catch (error) {
      failure(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)", lineHeight: 1.45 }}>
          {t("hostsConfig.subtitle")}
          {hosts?.[0] && <span style={{ display: "block" }}>{t("hostsConfig.serverProtocol", { version: hosts[0].serverVersion })}</span>}
        </p>
        <button type="button" className="ui-focus-ring" style={{ ...primaryStyle, display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0 }} onClick={() => setDialog({ kind: "add" })}>
          <Plus size={14} aria-hidden="true" />{t("hostsConfig.add")}
        </button>
      </div>
      {loadFailed && <div role="alert" style={{ fontSize: 12, color: "var(--status-error)" }}>{t("hostsConfig.loadFailed")}</div>}
      {hosts === null ? (
        !loadFailed && <div role="status" style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("hostsConfig.loading")}</div>
      ) : (
        <ul aria-label={t("hostsConfig.title")} style={{ margin: 0, padding: 0 }}>
          {hosts.map((host) => (
            <HostCard key={host.id} host={host} cluster={{ pools, poolsLoaded, poolsFailed }} onRename={() => setDialog({ kind: "rename", host })} onRevoke={() => setRevoking(host)} onShare={() => setSharing(host)} onJoin={() => setJoining(host)} onLeave={() => setLeaving(host)} />
          ))}
          {hosts.length === 1 && <li style={{ listStyle: "none", fontSize: 12, color: "var(--text-dim)" }}>{t("hostsConfig.empty")}</li>}
        </ul>
      )}
      {dialog && <HostDialog dialog={dialog} onClose={() => setDialog(null)} />}
      {joining && <JoinDialog host={joining} onClose={() => setJoining(null)} />}
      <ConfirmDialog
        open={leaving !== null}
        onOpenChange={(open) => { if (!open) setLeaving(null); }}
        title={t("hostsConfig.leaveTitle", { name: leaving?.label ?? "" })}
        description={t("hostsConfig.leaveDescription", { name: leaving?.label ?? "" })}
        confirmLabel={t("hostsConfig.leaveConfirm")}
        cancelLabel={t("hostsConfig.cancel")}
        busy={busy}
        onConfirm={() => void leave()}
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => { if (!open) setRevoking(null); }}
        title={t("hostsConfig.revokeTitle", { name: revoking?.label ?? "" })}
        description={t("hostsConfig.revokeDescription")}
        confirmLabel={t("hostsConfig.revoke")}
        cancelLabel={t("hostsConfig.cancel")}
        danger
        busy={busy}
        onConfirm={() => void revoke()}
      />
      <ConfirmDialog
        open={sharing !== null}
        onOpenChange={(open) => { if (!open) setSharing(null); }}
        title={t("hostsConfig.shareCredentialsTitle", { name: sharing?.label ?? "" })}
        description={t("hostsConfig.shareCredentialsDescription", { name: sharing?.label ?? "" })}
        confirmLabel={t("hostsConfig.shareCredentialsConfirm")}
        cancelLabel={t("hostsConfig.cancel")}
        busy={busy}
        onConfirm={() => void share()}
      />
    </div>
  );
}
