"use client";

import { useId, useState, type FormEvent } from "react";
import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/field";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/primitives";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import type { HostRow } from "@/lib/hosts/hub";
import { useI18n } from "@/lib/i18n";
import { useHostRows } from "@/hooks/useHostRows";
import { HOST_STATUS_COLOR, hostName, hostStatusText, localInstallCommand } from "./host-status";

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

function CopyField({ label, value }: { label: string; value: string }) {
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

function HostCard({ host, onRename, onRevoke }: { host: HostRow; onRename: () => void; onRevoke: () => void }) {
  const { t } = useI18n();
  const name = hostName(t, host);
  const linked = "allowAgentStart" in host ? host : null;
  const details = [
    host.ompVersion,
    host.platform,
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
        {"serverPlatform" in host && host.status === "offline" && (
          <div style={{ marginTop: 4, fontSize: 12, color: "var(--text-muted)", overflowWrap: "anywhere" }}>{t("hostsConfig.localOfflineHint", { command: localInstallCommand(host.serverPlatform) })}</div>
        )}
      </div>
      <div className="settings-card-control" style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {linked && (
          <>
            <span style={{ fontSize: 11, color: "var(--text-muted)", maxWidth: 200 }}>{t("hostsConfig.allowAgentStart")}</span>
            <ToggleSwitch
              checked={linked.allowAgentStart}
              aria-label={t("hostsConfig.allowAgentStartAria", { name })}
              onChange={(allowAgentStart) => void call("PATCH", "/api/hosts", { id: host.id, allowAgentStart }).catch(failure)}
            />
          </>
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
    </li>
  );
}

export function HostsConfig() {
  const { t } = useI18n();
  const { hosts, failed: loadFailed } = useHostRows();
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [revoking, setRevoking] = useState<HostRow | null>(null);
  const [busy, setBusy] = useState(false);

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
        <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)", lineHeight: 1.45 }}>{t("hostsConfig.subtitle")}</p>
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
            <HostCard key={host.id} host={host} onRename={() => setDialog({ kind: "rename", host })} onRevoke={() => setRevoking(host)} />
          ))}
          {hosts.length === 1 && <li style={{ listStyle: "none", fontSize: 12, color: "var(--text-dim)" }}>{t("hostsConfig.empty")}</li>}
        </ul>
      )}
      {dialog && <HostDialog dialog={dialog} onClose={() => setDialog(null)} />}
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
    </div>
  );
}
