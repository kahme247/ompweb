"use client";

import { Component, useEffect, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { translate } from "@/lib/i18n";

export function AppCrashScreen({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Application error:", error);
  }, [error]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        padding: "2rem",
        gap: "1rem",
        textAlign: "center",
        background: "var(--bg)",
      }}
    >
      <TriangleAlert size={44} strokeWidth={1.5} color="var(--accent)" style={{ opacity: 0.85 }} aria-hidden />
      <h2
        className="display-serif"
        style={{ margin: 0, fontSize: "1.5rem", color: "var(--text)" }}
      >
        {translate("errors.appCrash.title")}
      </h2>
      <p style={{ margin: 0, color: "var(--text-muted)", maxWidth: "28rem", fontSize: "0.875rem", lineHeight: 1.6 }}>
        {translate("errors.appCrash.description")}
      </p>
      {error.digest && (
        <code
          style={{
            fontSize: "0.75rem",
            color: "var(--text-dim)",
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            padding: "0.25rem 0.5rem",
            borderRadius: "var(--radius-control)",
          }}
        >
          {error.digest}
        </code>
      )}
      <button
        onClick={reset}
        style={{
          marginTop: "0.5rem",
          padding: "0.5rem 1.5rem",
          fontSize: "0.875rem",
          fontWeight: 500,
          border: "none",
          borderRadius: "var(--radius-control)",
          background: "var(--accent-strong)",
          color: "var(--on-accent)",
          cursor: "pointer",
          boxShadow: "var(--shadow-card)",
          transition: "background var(--dur-fast) var(--ease-out-warm)",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--accent-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "var(--accent-strong)"; }}
      >
        {translate("errors.appCrash.retry")}
      </button>
    </div>
  );
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    return error ? <AppCrashScreen error={error} reset={() => this.setState({ error: null })} /> : this.props.children;
  }
}
