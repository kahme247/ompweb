"use client";

import { useState } from "react";
import { isValidOmpProfile } from "@/lib/omp-profile";
import { useI18n } from "@/lib/i18n";
import type { ProjectLaunchConfig } from "@/lib/types";
import { Dialog, DialogContent, DialogTitle } from "./ui/primitives";

interface Props {
  projectPath: string;
  initialConfig?: ProjectLaunchConfig;
  onClose: () => void;
  onSave: (config: ProjectLaunchConfig | null) => Promise<void>;
}

/** Edit the workspace-specific OMP launch configuration, storing extra args as an array. */
export function ProjectLaunchConfigDialog({ projectPath, initialConfig, onClose, onSave }: Props) {
  const { t } = useI18n();
  const [profile, setProfile] = useState(initialConfig?.profile ?? "");
  const [advisor, setAdvisor] = useState(initialConfig?.advisor === true);
  const [extraArgs, setExtraArgs] = useState(initialConfig?.extraArgs?.join("\n") ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const profileInvalid = profile.trim() !== "" && !isValidOmpProfile(profile.trim());

  /** Shape the form contents into the structured config the API uses. */
  const buildConfig = (): ProjectLaunchConfig | null => {
    const args = extraArgs.split("\n").map((arg) => arg.trim()).filter(Boolean);
    const config: ProjectLaunchConfig = {
      profile: profile.trim() || undefined,
      advisor: advisor || undefined,
      extraArgs: args.length > 0 ? args : undefined,
    };
    return config.profile || config.advisor || config.extraArgs ? config : null;
  };

  /** Save the config, keeping the dialog contents on failure for easy correction. */
  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(buildConfig());
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent ariaLabel={t("projectLaunchConfig.dialogLabel")} style={{ width: "min(620px, calc(100vw - 16px))", padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "16px 18px 10px", borderBottom: "1px solid var(--border)" }}>
          <DialogTitle style={{ margin: 0, fontSize: 18 }}>{t("projectLaunchConfig.title")}</DialogTitle>
          <div style={{ marginTop: 6, color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, overflowWrap: "anywhere" }}>{projectPath}</div>
        </div>
        <div style={{ display: "grid", gap: 12, padding: 18 }}>
          <label style={{ display: "grid", gap: 5, color: "var(--text-muted)", fontSize: 12 }}>
            <span>OMP Profile</span>
            <input value={profile} onChange={(event) => setProfile(event.target.value)} placeholder={t("projectLaunchConfig.profilePlaceholder")} disabled={saving} aria-invalid={profileInvalid || undefined} style={{ height: 34, padding: "0 9px", border: `1px solid ${profileInvalid ? "var(--status-error)" : "var(--border)"}`, borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12, outline: "none" }} />
            {profileInvalid
              ? <span role="alert" style={{ color: "var(--status-error)", fontSize: 11, lineHeight: 1.4 }}>{t("projectLaunchConfig.profileInvalid")}</span>
              : <span style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.4 }}>{t("projectLaunchConfig.profileRule")}</span>}
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-muted)", fontSize: 12 }}>
            <input type="checkbox" checked={advisor} onChange={(event) => setAdvisor(event.target.checked)} disabled={saving} />
            {t("projectLaunchConfig.advisorLabel")}
          </label>
          <label style={{ display: "grid", gap: 5, color: "var(--text-muted)", fontSize: 12 }}>
            <span>{t("projectLaunchConfig.extraArgsLabel")}</span>
            <textarea value={extraArgs} onChange={(event) => setExtraArgs(event.target.value)} placeholder={t("projectLaunchConfig.extraArgsPlaceholder")} rows={6} disabled={saving} style={{ padding: "8px 9px", resize: "vertical", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12, outline: "none" }} />
          </label>
          <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.5 }}>
            <code>--mode</code> <code>--cwd</code> <code>--resume</code> {t("projectLaunchConfig.reservedNote")}
          </div>
          {error && <div role="alert" style={{ color: "var(--status-error)", fontSize: 12, lineHeight: 1.4 }}>{error}</div>}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 18px", borderTop: "1px solid var(--border)" }}>
          <button type="button" onClick={onClose} disabled={saving} style={{ padding: "7px 13px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-hover)", color: "var(--text-muted)", cursor: saving ? "default" : "pointer" }}>{t("projectLaunchConfig.cancel")}</button>
          <button type="button" onClick={() => void handleSave()} disabled={saving || profileInvalid} title={profileInvalid ? t("projectLaunchConfig.profileInvalid") : undefined} style={{ padding: "7px 15px", border: 0, borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "var(--on-accent)", cursor: saving || profileInvalid ? "default" : "pointer", opacity: saving || profileInvalid ? 0.65 : 1 }}>{saving ? t("projectLaunchConfig.saving") : t("projectLaunchConfig.save")}</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
