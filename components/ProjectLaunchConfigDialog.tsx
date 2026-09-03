"use client";

import { useState } from "react";
import type { ProjectLaunchConfig } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { Dialog, DialogContent, DialogTitle } from "./ui/primitives";

interface Props {
  projectPath: string;
  initialConfig?: ProjectLaunchConfig;
  onClose: () => void;
  onSave: (config: ProjectLaunchConfig | null) => Promise<void>;
}

/** 编辑工作区专属的 OMP 启动配置，并以参数数组保存额外参数。 */
export function ProjectLaunchConfigDialog({ projectPath, initialConfig, onClose, onSave }: Props) {
  const { t } = useI18n();
  const [profile, setProfile] = useState(initialConfig?.profile ?? "");
  const [extraArgs, setExtraArgs] = useState(initialConfig?.extraArgs?.join("\n") ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 将表单内容整理为 API 使用的结构化配置。 */
  const buildConfig = (): ProjectLaunchConfig | null => {
    const args = extraArgs.split("\n").map((arg) => arg.trim()).filter(Boolean);
    const config: ProjectLaunchConfig = {
      profile: profile.trim() || undefined,
      extraArgs: args.length > 0 ? args : undefined,
    };
    return config.profile || config.extraArgs ? config : null;
  };

  /** 保存配置并在失败时保留弹窗内容，方便用户修正参数。 */
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
      <DialogContent ariaLabel={t("projects.launchConfigDialogLabel")} style={{ width: "min(620px, calc(100vw - 16px))", padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "16px 18px 10px", borderBottom: "1px solid var(--border)" }}>
          <DialogTitle style={{ margin: 0, fontSize: 18 }}>{t("projects.launchConfigTitle")}</DialogTitle>
          <div style={{ marginTop: 6, color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, overflowWrap: "anywhere" }}>{projectPath}</div>
        </div>
        <div style={{ display: "grid", gap: 12, padding: 18 }}>
          <label style={{ display: "grid", gap: 5, color: "var(--text-muted)", fontSize: 12 }}>
            <span>{t("projects.launchConfigProfile")}</span>
            <input value={profile} onChange={(event) => setProfile(event.target.value)} placeholder={t("projects.launchConfigProfilePlaceholder")} disabled={saving} style={{ height: 34, padding: "0 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12, outline: "none" }} />
          </label>
          <label style={{ display: "grid", gap: 5, color: "var(--text-muted)", fontSize: 12 }}>
            <span>{t("projects.launchConfigExtraArgs")}</span>
            <textarea value={extraArgs} onChange={(event) => setExtraArgs(event.target.value)} placeholder={t("projects.launchConfigExtraArgsPlaceholder")} rows={6} disabled={saving} style={{ padding: "8px 9px", resize: "vertical", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12, outline: "none" }} />
          </label>
          <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.5 }}>
            {t("projects.launchConfigReservedArgs", { mode: "--mode", cwd: "--cwd", resume: "--resume" })}
          </div>
          {error && <div role="alert" style={{ color: "var(--status-error)", fontSize: 12, lineHeight: 1.4 }}>{error}</div>}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 18px", borderTop: "1px solid var(--border)" }}>
          <button type="button" onClick={onClose} disabled={saving} style={{ padding: "7px 13px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-hover)", color: "var(--text-muted)", cursor: saving ? "default" : "pointer" }}>{t("sessionSidebar.cancel")}</button>
          <button type="button" onClick={() => void handleSave()} disabled={saving} style={{ padding: "7px 15px", border: 0, borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "var(--on-accent)", cursor: saving ? "default" : "pointer", opacity: saving ? 0.65 : 1 }}>{saving ? t("projects.launchConfigSaving") : t("projects.launchConfigSave")}</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
