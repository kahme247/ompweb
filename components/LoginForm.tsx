"use client";

import { LockKeyhole } from "lucide-react";
import { FormEvent, useState } from "react";
import { useI18n } from "@/lib/i18n";

/** `initialPassword`: what was typed into app/index.html's static copy of this form before the bundle ran. */
export function LoginForm({ initialPassword = "" }: { initialPassword?: string }) {
  const { t } = useI18n();
  const [password, setPassword] = useState(initialPassword);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/web-auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        setError(t("login.incorrectPassword"));
        return;
      }
      // Full reload so the new auth cookie is picked up by middleware
      // and server components — SPA navigation alone may keep stale state.
      // `next` (set by proxy.ts) may only point back into the app root.
      const next = new URLSearchParams(window.location.search).get("next");
      window.location.replace(next?.startsWith("/?") ? next : "/");
    } catch {
      setError(t("login.connectionFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main style={{ flex: 1, display: "grid", placeItems: "center", padding: "max(20px, env(safe-area-inset-top)) 20px max(20px, env(safe-area-inset-bottom))", background: "var(--bg)" }}>
      <section
        aria-labelledby="login-title"
        style={{ width: "min(100%, 380px)", padding: "clamp(24px, 7vw, 32px)", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius-modal)", boxShadow: "var(--shadow-modal)" }}
      >
        <div style={{ width: 40, height: 40, display: "grid", placeItems: "center", borderRadius: "50%", background: "var(--user-bg)", color: "var(--accent)", marginBottom: 20 }}>
          <LockKeyhole size={19} aria-hidden="true" />
        </div>
        <h1 id="login-title" className="display-serif" style={{ margin: 0, fontSize: 28, lineHeight: 1.1, color: "var(--text)" }}>{t("login.title")}</h1>
        <p style={{ margin: "10px 0 24px", color: "var(--text-muted)", fontSize: 13, lineHeight: 1.5 }}>{t("login.description")}</p>
        <form onSubmit={signIn} style={{ display: "grid", gap: 14 }}>
          <label htmlFor="web-password" style={{ display: "grid", gap: 6, color: "var(--text-muted)", fontSize: 12, fontWeight: 600 }}>
            {t("login.password")}
            <input
              id="web-password"
              className="ui-focus-ring"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              autoFocus
              required
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "password-error" : undefined}
              style={{ width: "100%", minHeight: 44, padding: "9px 10px", border: `1px solid ${error ? "var(--status-error)" : "var(--border)"}`, borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 14, transition: "border-color var(--dur-fast) var(--ease-out-warm), box-shadow var(--dur-fast) var(--ease-out-warm)" }}
            />
          </label>
          {error && <p id="password-error" role="alert" style={{ margin: 0, color: "var(--status-error)", fontSize: 12 }}>{error}</p>}
          <button type="submit" className="ui-focus-ring" disabled={submitting} style={{ minHeight: 44, border: 0, borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "var(--on-accent)", fontWeight: 600, cursor: submitting ? "wait" : "pointer", opacity: submitting ? 0.7 : 1 }}>
            {submitting ? t("login.unlocking") : t("login.unlock")}
          </button>
        </form>
      </section>
    </main>
  );
}
