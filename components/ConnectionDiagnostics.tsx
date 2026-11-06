"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { requestConnectionDiagnostics } from "@/lib/event-stream";
import type { ConnectionDiagnostics } from "@/lib/event-stream-protocol";
import type { DiagnosticMetric } from "@/lib/transport-stats";
import { useI18n } from "@/lib/i18n";

const POLL_MS = 1000;

/** Translation keys for each metric's row label and its longer tooltip. */
const METRIC_KEYS: Record<DiagnosticMetric, { label: string; title: string }> = {
  upMs: { label: "connectionDiagnostics.metricUp", title: "connectionDiagnostics.metricUpTitle" },
  transportMs: { label: "connectionDiagnostics.metricTransport", title: "connectionDiagnostics.metricTransportTitle" },
  ompMs: { label: "connectionDiagnostics.metricOmp", title: "connectionDiagnostics.metricOmpTitle" },
  serverMs: { label: "connectionDiagnostics.metricServer", title: "connectionDiagnostics.metricServerTitle" },
  totalMs: { label: "connectionDiagnostics.metricTotal", title: "connectionDiagnostics.metricTotalTitle" },
  eventMs: { label: "connectionDiagnostics.metricEvent", title: "connectionDiagnostics.metricEventTitle" },
};

const STATUS_COLOR: Record<ConnectionDiagnostics["status"], string> = {
  connected: "var(--status-success)",
  connecting: "var(--status-warning)",
  down: "var(--status-error)",
  idle: "var(--text-dim)",
};

const STATUS_KEY: Record<ConnectionDiagnostics["status"], string> = {
  connected: "connectionDiagnostics.statusConnected",
  connecting: "connectionDiagnostics.statusConnecting",
  down: "connectionDiagnostics.statusDown",
  idle: "connectionDiagnostics.statusIdle",
};

const numberCell: CSSProperties = {
  textAlign: "right",
  whiteSpace: "nowrap",
  padding: "3px 6px",
  color: "var(--text)",
  fontVariantNumeric: "tabular-nums",
};

/** Polls only while `active` (the Connection tab is selected and the right panel open) and the document is visible. */
export function ConnectionDiagnosticsPanel({ active }: { active: boolean }) {
  const { t } = useI18n();
  const [diagnostics, setDiagnostics] = useState<ConnectionDiagnostics | null>(null);
  // When the current answer arrived: elapsed times are measured from here, so render stays pure.
  const [receivedAt, setReceivedAt] = useState(0);
  const visible = useDocumentVisible();

  useEffect(() => {
    if (!active || !visible) return;
    let alive = true;
    let timer: number | undefined;
    // Chained, not an interval: the next request starts 1 s after the previous answer, so slow answers never pile up.
    const poll = () => {
      requestConnectionDiagnostics()
        .catch(() => null)
        .then((next) => {
          if (!alive) return;
          setDiagnostics(next);
          setReceivedAt(Date.now());
          timer = window.setTimeout(poll, POLL_MS);
        });
    };
    poll();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [active, visible]);

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", boxSizing: "border-box", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 14, fontSize: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{t("connectionDiagnostics.title")}</div>
      {diagnostics === null ? (
        <div style={{ color: "var(--text-dim)", lineHeight: 1.6 }}>{t("connectionDiagnostics.noResult")}</div>
      ) : (
        <DiagnosticsBody diagnostics={diagnostics} now={receivedAt} />
      )}
    </div>
  );
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

function DiagnosticsBody({ diagnostics: d, now }: { diagnostics: ConnectionDiagnostics; now: number }) {
  const { t } = useI18n();
  const minutes = Math.round(d.windowMs / 60000);
  const transportName = (transport: string) => t(transport === "ws" ? "connectionDiagnostics.transportWs" : "connectionDiagnostics.transportSse");
  const agoText = (at: number) => {
    const seconds = Math.max(0, Math.round((now - at) / 1000));
    return seconds < 60
      ? t("connectionDiagnostics.agoSeconds", { count: seconds })
      : t("connectionDiagnostics.agoMinutes", { count: Math.round(seconds / 60) });
  };

  const last = d.lastReconnect;
  const lastText = last
    ? [
        agoText(last.at),
        last.trigger,
        t("connectionDiagnostics.outageMs", { ms: Math.round(last.outageMs) }),
        last.resumed === null ? null : t(last.resumed ? "connectionDiagnostics.resumed" : "connectionDiagnostics.resynced"),
      ].filter((part): part is string => part !== null).join(" · ")
    : "—";

  // The current transport first, then the other one; only transports with samples (rows come in metric order).
  const groups = [d.mode, d.mode === "ws" ? "sse" : "ws"]
    .map((transport) => ({ transport, stats: d.stats.filter((stat) => stat.transport === transport) }))
    .filter((group) => group.stats.length > 0);

  return (
    <>
      <dl style={{ margin: 0, display: "flex", flexDirection: "column" }}>
        <Row label={t("connectionDiagnostics.rowTransport")}>
          {transportName(d.mode)}
          {d.fallback && ` ${t(d.fallback === "version" ? "connectionDiagnostics.fallbackVersion" : "connectionDiagnostics.fallbackRefused")}`}
        </Row>
        <Row label={t("connectionDiagnostics.rowSetting")}>{transportName(d.setting)}</Row>
        <Row label={t("connectionDiagnostics.rowStatus")}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: STATUS_COLOR[d.status] }} />
            {t(STATUS_KEY[d.status])}
            {d.since !== null && ` · ${t("connectionDiagnostics.statusFor", { seconds: Math.max(0, Math.round((now - d.since) / 1000)) })}`}
          </span>
        </Row>
        <Row label={t("connectionDiagnostics.rowLastReconnect")}>{lastText}</Row>
        <Row label={t("connectionDiagnostics.rowReconnects", { minutes })}>
          {d.reconnects}
          {d.mode === "ws" && ` (${t("connectionDiagnostics.reconnectsDetail", { resumes: d.resumes, resyncs: d.resyncs })})`}
        </Row>
        <Row label={t("connectionDiagnostics.rowClockRtt")}>{d.clockRttMs === null ? "—" : t("connectionDiagnostics.msValue", { ms: Math.round(d.clockRttMs) })}</Row>
        <Row label={t("connectionDiagnostics.rowNetwork")}>{d.effectiveType ?? "—"}</Row>
      </dl>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {groups.length === 0 && <div style={{ color: "var(--text-dim)" }}>{t("connectionDiagnostics.noSamples")}</div>}
        {groups.map((group) => (
          <div key={group.transport} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontWeight: 600, color: "var(--text)" }}>{transportName(group.transport)}</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ color: "var(--text-dim)" }}>
                    <th scope="col" style={{ textAlign: "left", fontWeight: 400, padding: "3px 6px" }}>{t("connectionDiagnostics.statsUnit")}</th>
                    <th scope="col" style={{ ...numberCell, color: "var(--text-dim)", fontWeight: 400 }}>{t("connectionDiagnostics.colCount")}</th>
                    <th scope="col" style={{ ...numberCell, color: "var(--text-dim)", fontWeight: 400 }}>{t("connectionDiagnostics.colMean")}</th>
                    <th scope="col" style={{ ...numberCell, color: "var(--text-dim)", fontWeight: 400 }}>p50</th>
                    <th scope="col" style={{ ...numberCell, color: "var(--text-dim)", fontWeight: 400 }}>p95</th>
                    <th scope="col" style={{ ...numberCell, color: "var(--text-dim)", fontWeight: 400 }}>p99.9</th>
                    <th scope="col" style={{ ...numberCell, color: "var(--text-dim)", fontWeight: 400 }}>{t("connectionDiagnostics.colMax")}</th>
                  </tr>
                </thead>
                <tbody>
                  {group.stats.map((stat) => (
                    <tr key={stat.metric} style={{ borderTop: "1px solid var(--border)" }}>
                      <th
                        scope="row"
                        title={t(METRIC_KEYS[stat.metric].title)}
                        style={{ textAlign: "left", fontWeight: 400, color: "var(--text-muted)", padding: "3px 6px", maxWidth: 120, overflowWrap: "anywhere" }}
                      >
                        {t(METRIC_KEYS[stat.metric].label)}
                      </th>
                      <td style={numberCell}>{stat.count}</td>
                      <td style={numberCell}>{formatMs(stat.mean)}</td>
                      <td style={numberCell}>{formatMs(stat.p50)}</td>
                      <td style={numberCell}>{formatMs(stat.p95)}</td>
                      <td style={numberCell}>{formatMs(stat.p999)}</td>
                      <td style={numberCell}>{formatMs(stat.max)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
        <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.5, display: "flex", flexDirection: "column", gap: 6 }}>
          <div>{t("connectionDiagnostics.statsNote", { minutes })}</div>
          <div>{t("connectionDiagnostics.timingNote")}</div>
          <div>{t("connectionDiagnostics.commandNote")}</div>
        </div>
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: "2px 12px", padding: "5px 0", borderBottom: "1px solid var(--border)" }}>
      <dt style={{ margin: 0, color: "var(--text-muted)", flexShrink: 0 }}>{label}</dt>
      <dd style={{ margin: 0, color: "var(--text)", textAlign: "right", minWidth: 0, overflowWrap: "anywhere" }}>{children}</dd>
    </div>
  );
}

/** Table cells hold bare integers; the header's unit says ms. */
function formatMs(value: number | null): string {
  return value === null ? "—" : String(Math.round(value));
}
