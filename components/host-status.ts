import type { HostRow } from "@/lib/hosts/hub";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export const HOST_STATUS_COLOR = { online: "var(--status-success)", offline: "var(--text-dim)", "omp-missing": "var(--status-warning)", "needs-upgrade": "var(--status-warning)" } as const;

/** The name a host goes by in the UI: this machine is localized, linked hosts keep their label. */
export function hostName(t: Translate, host: Pick<HostRow, "id" | "label">): string {
  return host.id === "local" ? t("hostsConfig.thisMachine") : host.label;
}

export function hostStatusText(t: Translate, host: HostRow): string {
  switch (host.status) {
    case "online":
      return t("hostsConfig.statusOnline");
    case "omp-missing":
      return t("hostsConfig.statusOmpMissing");
    case "needs-upgrade":
      return t("hostsConfig.statusNeedsUpgrade", { host: "hostVersion" in host ? host.hostVersion ?? "?" : "?", server: "serverVersion" in host ? host.serverVersion : "?" });
    default:
      return t("hostsConfig.statusOffline");
  }
}
