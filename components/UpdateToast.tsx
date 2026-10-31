import { copyText } from "@/lib/clipboard";
import { translate } from "@/lib/i18n";
import { toast } from "@/components/ui/toast";

/**
 * The body of an "update available" toast for an update run outside the app: the versions, then where to update. That
 * is the release page as a link (`link`: the compiled binary updates by download) or the terminal command with a Copy
 * button. `action` (a button to Settings → System) follows when given.
 */
export function UpdateToastBody({ currentVersion, availableVersion, target, link, action }: {
  currentVersion: string | null | undefined;
  availableVersion: string;
  target: string;
  link: boolean;
  action?: { label: string; onClick: () => void };
}) {
  const small = { padding: "3px 7px", borderRadius: "var(--radius-control)", fontSize: 11 };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
      <div>{translate("appShell.updateVersion", { current: currentVersion ?? "?", available: availableVersion })}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {link ? (
          <a href={target} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--accent)", wordBreak: "break-all" }}>{target}</a>
        ) : (
          <>
            <code style={{ ...small, background: "var(--bg-panel)", fontFamily: "var(--font-mono)" }}>{target}</code>
            <button
              type="button"
              onClick={() => {
                void copyText(target)
                  .then(() => toast.success(translate("appShell.commandCopied")))
                  .catch(() => toast.error(translate("appShell.commandCopyFailed")));
              }}
              style={{ ...small, border: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer" }}
            >
              {translate("appShell.copyCommand")}
            </button>
          </>
        )}
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            style={{ ...small, border: "1px solid var(--accent-strong)", background: "var(--accent-strong)", color: "var(--on-accent)", cursor: "pointer", fontWeight: 600 }}
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}
