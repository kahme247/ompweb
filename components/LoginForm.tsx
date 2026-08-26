"use client";

import { useRouter } from "next/navigation";
import { LockKeyhole } from "lucide-react";
import { FormEvent, useState } from "react";

export function LoginForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
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
        setError("Incorrect password. Please try again.");
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("Could not sign in. Please check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main style={{ flex: 1, display: "grid", placeItems: "center", padding: 20, background: "var(--bg)" }}>
      <section
        aria-labelledby="login-title"
        style={{ width: "min(100%, 380px)", padding: "32px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius-modal)", boxShadow: "var(--shadow-modal)" }}
      >
        <div style={{ width: 40, height: 40, display: "grid", placeItems: "center", borderRadius: "50%", background: "var(--user-bg)", color: "var(--accent)", marginBottom: 20 }}>
          <LockKeyhole size={19} aria-hidden="true" />
        </div>
        <h1 id="login-title" className="display-serif" style={{ margin: 0, fontSize: 28, lineHeight: 1.1, color: "var(--text)" }}>Welcome back</h1>
        <p style={{ margin: "10px 0 24px", color: "var(--text-muted)", fontSize: 13, lineHeight: 1.5 }}>Enter the password for this omp web workspace.</p>
        <form onSubmit={signIn} style={{ display: "grid", gap: 14 }}>
          <label htmlFor="web-password" style={{ display: "grid", gap: 6, color: "var(--text-muted)", fontSize: 12, fontWeight: 600 }}>
            Password
            <input
              id="web-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              autoFocus
              required
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "password-error" : undefined}
              style={{ width: "100%", padding: "9px 10px", border: `1px solid ${error ? "var(--status-error)" : "var(--border)"}`, borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 14, outline: "none", boxShadow: "none" }}
            />
          </label>
          {error && <p id="password-error" role="alert" style={{ margin: 0, color: "var(--status-error)", fontSize: 12 }}>{error}</p>}
          <button type="submit" disabled={submitting} style={{ minHeight: 36, border: 0, borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "var(--on-accent)", fontWeight: 600, cursor: submitting ? "wait" : "pointer", opacity: submitting ? 0.7 : 1 }}>
            {submitting ? "Unlocking…" : "Unlock workspace"}
          </button>
        </form>
      </section>
    </main>
  );
}
