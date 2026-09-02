"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type {
  UsageBreakdownView,
  UsageGranularity,
  UsageMetricView,
  UsageReport,
  UsageTimeRange,
} from "@/lib/usage-types";

function formatTokens(count: number): string {
  if (count == null || isNaN(count) || count === 0) return "0";
  if (count < 1000) return count.toLocaleString();
  if (count < 1_000_000) {
    const k = count / 1000;
    return k % 1 === 0 ? `${k}K` : `${k.toFixed(1)}K`;
  }
  if (count < 1_000_000_000) {
    const m = count / 1_000_000;
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(2)}M`;
  }
  const b = count / 1_000_000_000;
  return `${b.toFixed(2)}B`;
}

function formatCurrency(amount: number): string {
  if (amount == null || isNaN(amount) || amount === 0) return "$0.00";
  if (amount < 0.01 && amount > 0) {
    return `$${amount.toFixed(3)}`;
  }
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function UsageConfig() {
  const { t } = useI18n();

  const [timeRange, setTimeRange] = useState<UsageTimeRange>("30d");
  const [granularity, setGranularity] = useState<UsageGranularity>("daily");
  const [metricView, setMetricView] = useState<UsageMetricView>("cost");
  const [breakdownView, setBreakdownView] = useState<UsageBreakdownView>("model");

  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Hover state for interactive chart tooltip
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const chartSvgRef = useRef<SVGSVGElement | null>(null);

  const fetchUsage = useCallback(
    async (isRefresh = false, signal?: AbortSignal) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({
          range: timeRange,
          granularity,
        });
        if (isRefresh) params.set("refresh", "true");

        const res = await fetch(`/api/usage?${params.toString()}`, { signal });
        if (!res.ok) {
          throw new Error(`Failed to fetch usage: ${res.statusText}`);
        }
        const data: UsageReport = await res.json();
        setReport(data);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [timeRange, granularity],
  );

  useEffect(() => {
    const controller = new AbortController();
    fetchUsage(false, controller.signal);
    return () => {
      controller.abort();
    };
  }, [fetchUsage]);

  // Date range subtitle calculation
  const dateRangeSubtitle = useMemo(() => {
    if (!report || !report.timeSeries || report.timeSeries.length === 0) {
      return "";
    }
    const first = report.timeSeries[0];
    const last = report.timeSeries[report.timeSeries.length - 1];
    if (!first || !last) return "";
    return first.label === last.label ? first.label : `${first.label} to ${last.label}`;
  }, [report]);

  // SVG Chart Geometry Calculations
  const chartData = useMemo(() => {
    if (!report || !report.timeSeries || report.timeSeries.length === 0) {
      return null;
    }
    const points = report.timeSeries;
    const isCost = metricView === "cost";
    const values = points.map((p) => (isCost ? p.totalCost : p.totalTokens));
    const maxValue = Math.max(...values, isCost ? 0.01 : 100);

    const width = 540;
    const height = 170;
    const padTop = 15;
    const padBottom = 26;
    const padLeft = 44;
    const padRight = 14;

    const plotWidth = width - padLeft - padRight;
    const plotHeight = height - padTop - padBottom;

    const stepX = points.length > 1 ? plotWidth / (points.length - 1) : plotWidth;

    const coords = points.map((p, idx) => {
      const val = isCost ? p.totalCost : p.totalTokens;
      const x = padLeft + idx * stepX;
      const y = padTop + plotHeight - (val / maxValue) * plotHeight;
      return { x, y, val, point: p, index: idx };
    });

    // Build SVG path
    let pathD = "";
    let areaD = "";

    if (coords.length === 1) {
      const y = coords[0].y;
      pathD = `M ${padLeft} ${y} L ${padLeft + plotWidth} ${y}`;
      areaD = `M ${padLeft} ${y} L ${padLeft + plotWidth} ${y} L ${padLeft + plotWidth} ${padTop + plotHeight} L ${padLeft} ${padTop + plotHeight} Z`;
    } else if (coords.length > 1) {
      pathD = `M ${coords[0].x} ${coords[0].y}`;
      for (let i = 1; i < coords.length; i++) {
        const prev = coords[i - 1];
        const cur = coords[i];
        const cx1 = prev.x + (cur.x - prev.x) / 2;
        const cy1 = prev.y;
        const cx2 = prev.x + (cur.x - prev.x) / 2;
        const cy2 = cur.y;
        pathD += ` C ${cx1} ${cy1}, ${cx2} ${cy2}, ${cur.x} ${cur.y}`;
      }
      const firstCoord = coords[0] || { x: padLeft, y: padTop + plotHeight };
      const lastCoord = coords[coords.length - 1] || { x: padLeft + plotWidth, y: padTop + plotHeight };
      areaD = `${pathD} L ${lastCoord.x} ${padTop + plotHeight} L ${firstCoord.x} ${padTop + plotHeight} Z`;
    }

    // Y ticks
    const yTicks = [
      { y: padTop + plotHeight, label: isCost ? "$0.00" : "0" },
      { y: padTop + plotHeight / 2, label: isCost ? formatCurrency(maxValue / 2) : formatTokens(maxValue / 2) },
      { y: padTop, label: isCost ? formatCurrency(maxValue) : formatTokens(maxValue) },
    ];

    // X ticks: pick up to 4 spread dates
    const xTicksIndices =
      points.length <= 4
        ? points.map((_, i) => i)
        : [
            0,
            Math.floor(points.length * 0.33),
            Math.floor(points.length * 0.66),
            points.length - 1,
          ];

    const xTicks = xTicksIndices.map((i) => ({
      x: coords[i]?.x ?? padLeft,
      label: points[i]?.label ?? "",
    }));

    return {
      width,
      height,
      padLeft,
      padTop,
      padBottom,
      plotWidth,
      plotHeight,
      coords,
      pathD,
      areaD,
      yTicks,
      xTicks,
      isCost,
      maxValue,
    };
  }, [report, metricView]);

  // Chart pointer move handler
  const handleChartPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!chartData || !chartSvgRef.current) return;
    const rect = chartSvgRef.current.getBoundingClientRect();
    const scaleX = chartData.width / rect.width;
    const mouseX = (e.clientX - rect.left) * scaleX;

    // Find closest point by X coordinate
    let closestIdx = 0;
    let minDiff = Infinity;
    for (let i = 0; i < chartData.coords.length; i++) {
      const diff = Math.abs(chartData.coords[i].x - mouseX);
      if (diff < minDiff) {
        minDiff = diff;
        closestIdx = i;
      }
    }

    setHoverIndex(closestIdx);
    setHoverPos({
      x: chartData.coords[closestIdx].x,
      y: chartData.coords[closestIdx].y,
    });
  };

  const handleChartPointerLeave = () => {
    setHoverIndex(null);
    setHoverPos(null);
  };

  if (loading && !report) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: 380,
          gap: 12,
          color: "var(--text-muted)",
        }}
      >
        <Loader2 size={24} className="animate-spin" style={{ color: "var(--accent)" }} />
        <span style={{ fontSize: 13 }}>{t("usageConfig.loading")}</span>
      </div>
    );
  }

  if (error && !report) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: 380,
          gap: 12,
          color: "var(--text-muted)",
        }}
      >
        <AlertCircle size={28} style={{ color: "var(--text-dim)" }} />
        <span style={{ fontSize: 14, fontWeight: 500, color: "var(--text)" }}>{t("usageConfig.error")}</span>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{error}</span>
        <button
          type="button"
          onClick={() => fetchUsage(true)}
          style={{
            marginTop: 8,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 14px",
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            color: "var(--text)",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          <RefreshCw size={13} />
          {t("usageConfig.refresh")}
        </button>
      </div>
    );
  }

  const summary = report?.summary;
  const providers = report?.providers || [];
  const modelBreakdown = report?.modelBreakdown || [];
  const dayBreakdown = report?.dayBreakdown || [];
  const projectBreakdown = report?.projectBreakdown || [];
  const scanInfo = report?.scanInfo;

  // Active hover point data
  const activeHoverPoint = hoverIndex != null && chartData ? chartData.coords[hoverIndex]?.point : null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        paddingBottom: 24,
        color: "var(--text)",
      }}
    >
      {/* 1. Header Bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
          paddingBottom: 4,
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div>
          <h2
            style={{
              fontSize: 20,
              fontWeight: 600,
              fontFamily: "var(--font-serif, serif)",
              margin: 0,
              color: "var(--text)",
              letterSpacing: "-0.01em",
            }}
          >
            {t("usageConfig.title")}
          </h2>
          {dateRangeSubtitle && (
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{dateRangeSubtitle}</div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {/* Granularity segmented buttons */}
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              background: "var(--bg-subtle)",
              padding: 2,
              borderRadius: "var(--radius-control)",
              border: "1px solid var(--border)",
            }}
          >
            {(["daily", "monthly", "projects"] as UsageGranularity[]).map((g) => {
              const active = granularity === g;
              return (
                <button
                  key={g}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setGranularity(g)}
                  style={{
                    padding: "4px 10px",
                    fontSize: 12,
                    fontWeight: active ? 600 : 400,
                    borderRadius: "calc(var(--radius-control) - 2px)",
                    border: "none",
                    background: active ? "var(--bg-selected)" : "transparent",
                    color: active ? "var(--text)" : "var(--text-muted)",
                    cursor: "pointer",
                    transition: "all var(--dur-fast) ease",
                  }}
                >
                  {g === "daily"
                    ? t("usageConfig.granularityDaily")
                    : g === "monthly"
                      ? t("usageConfig.granularityMonthly")
                      : t("usageConfig.granularityProjects")}
                </button>
              );
            })}
          </div>

          {/* Time Range Selector */}
          <div style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
            <select
              value={timeRange}
              aria-label={t("usageConfig.timeRange")}
              onChange={(e) => setTimeRange(e.target.value as UsageTimeRange)}
              style={{
                appearance: "none",
                padding: "5px 28px 5px 10px",
                fontSize: 12,
                borderRadius: "var(--radius-control)",
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                cursor: "pointer",
              }}
            >
              <option value="today">{t("usageConfig.rangeToday")}</option>
              <option value="7d">{t("usageConfig.range7d")}</option>
              <option value="30d">{t("usageConfig.range30d")}</option>
              <option value="90d">{t("usageConfig.range90d")}</option>
              <option value="month">{t("usageConfig.rangeMonth")}</option>
              <option value="all">{t("usageConfig.rangeAll")}</option>
            </select>
            <ChevronDown
              size={14}
              style={{
                position: "absolute",
                right: 8,
                pointerEvents: "none",
                color: "var(--text-dim)",
              }}
            />
          </div>

          {/* Refresh button */}
          <button
            type="button"
            onClick={() => fetchUsage(true)}
            disabled={refreshing}
            title={t("usageConfig.refresh")}
            aria-label={t("usageConfig.refresh")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 30,
              height: 30,
              borderRadius: "var(--radius-control)",
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: refreshing ? "default" : "pointer",
            }}
          >
            <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* 2. Top Row: Raw Token Cost & Chart */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          gap: 14,
        }}
      >
        {/* Left Card: Raw Token Cost */}
        <div
          style={{
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-card)",
            padding: "16px 18px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-dim)", textTransform: "uppercase" }}>
            {t("usageConfig.rawTokenCost")}
          </div>

          <div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
              <span style={{ fontSize: 32, fontWeight: 700, fontFamily: "var(--font-serif, serif)", color: "var(--text)", letterSpacing: "-0.02em" }}>
                {formatCurrency(summary?.totalCost ?? 0)}
              </span>
              <span style={{ fontSize: 14, color: "var(--text-muted)", fontWeight: 500 }}>*</span>
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
              {t("usageConfig.billedAtFullRate")}
            </div>
          </div>

          {/* Proportional Stacked Provider Bar */}
          <div
            style={{
              height: 8,
              width: "100%",
              borderRadius: 4,
              overflow: "hidden",
              display: "flex",
              background: "var(--bg-subtle)",
            }}
          >
            {providers.length === 0 ? (
              <div style={{ height: "100%", width: "100%", background: "var(--border)" }} />
            ) : (
              providers.map((p) => {
                const widthPct = Math.max(p.share, 2);
                return (
                  <div
                    key={p.provider}
                    title={`${p.name}: ${formatCurrency(p.cost)} (${p.share.toFixed(1)}%)`}
                    style={{
                      height: "100%",
                      width: `${widthPct}%`,
                      backgroundColor: p.color,
                      transition: "width 0.3s ease",
                    }}
                  />
                );
              })
            )}
          </div>

          {/* Provider Share Breakdown List */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
            {providers.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--text-dim)", fontStyle: "italic" }}>
                {t("usageConfig.emptyTitle")}
              </div>
            ) : (
              providers.map((p) => (
                <div
                  key={p.provider}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div
                      style={{
                        width: 9,
                        height: 9,
                        borderRadius: "50%",
                        backgroundColor: p.color,
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ fontWeight: 500, color: "var(--text)" }}>{p.name}</span>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontWeight: 600, color: "var(--text)" }}>{formatCurrency(p.cost)}</span>
                    <span style={{ fontSize: 11, color: "var(--text-dim)", minWidth: 70, textAlign: "right" }}>
                      {p.share.toFixed(1)}% {t("usageConfig.share").toLowerCase()}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)", minWidth: 60, textAlign: "right" }}>
                      {formatTokens(p.tokens)}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Right Card: Interactive Time-Series Chart */}
        <div
          style={{
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-card)",
            padding: "16px 18px",
            display: "flex",
            flexDirection: "column",
            gap: 10,
            position: "relative",
          }}
        >
          {/* Chart Card Header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                {granularity === "monthly"
                  ? metricView === "cost"
                    ? t("usageConfig.monthlyCost")
                    : t("usageConfig.monthlyTokens")
                  : metricView === "cost"
                    ? t("usageConfig.dailyCost")
                    : t("usageConfig.dailyTokens")}
              </span>

              {/* Provider color badges */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                {providers.slice(0, 3).map((p) => (
                  <span
                    key={p.provider}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      fontSize: 10,
                      color: "var(--text-muted)",
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: p.color }} />
                    {p.name}
                  </span>
                ))}
              </div>
            </div>

            {/* Metric toggle pill: COST | TOKENS */}
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                background: "var(--bg-subtle)",
                padding: 2,
                borderRadius: "var(--radius-control)",
                border: "1px solid var(--border)",
              }}
            >
              <button
                type="button"
                aria-pressed={metricView === "cost"}
                onClick={() => setMetricView("cost")}
                style={{
                  padding: "3px 8px",
                  fontSize: 11,
                  fontWeight: metricView === "cost" ? 600 : 400,
                  borderRadius: "calc(var(--radius-control) - 2px)",
                  border: "none",
                  background: metricView === "cost" ? "var(--bg-selected)" : "transparent",
                  color: metricView === "cost" ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer",
                }}
              >
                {t("usageConfig.cost").toUpperCase()}
              </button>
              <button
                type="button"
                aria-pressed={metricView === "tokens"}
                onClick={() => setMetricView("tokens")}
                style={{
                  padding: "3px 8px",
                  fontSize: 11,
                  fontWeight: metricView === "tokens" ? 600 : 400,
                  borderRadius: "calc(var(--radius-control) - 2px)",
                  border: "none",
                  background: metricView === "tokens" ? "var(--bg-selected)" : "transparent",
                  color: metricView === "tokens" ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer",
                }}
              >
                {t("usageConfig.tokens").toUpperCase()}
              </button>
            </div>
          </div>

          {/* SVG Area Chart */}
          <div style={{ width: "100%", height: 170, position: "relative" }}>
            {chartData && (
              <svg
                ref={chartSvgRef}
                viewBox={`0 0 ${chartData.width} ${chartData.height}`}
                preserveAspectRatio="none"
                style={{ width: "100%", height: "100%", overflow: "visible", cursor: "crosshair" }}
                onPointerMove={handleChartPointerMove}
                onPointerLeave={handleChartPointerLeave}
              >
                <defs>
                  <linearGradient id="usageAreaGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
                    <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
                  </linearGradient>
                </defs>

                {/* Y Axis Grid Lines & Labels */}
                {chartData.yTicks.map((tick, i) => (
                  <g key={i}>
                    <line
                      x1={chartData.padLeft}
                      y1={tick.y}
                      x2={chartData.width - 14}
                      y2={tick.y}
                      stroke="var(--border)"
                      strokeDasharray="3 3"
                      strokeWidth="1"
                    />
                    <text
                      x={chartData.padLeft - 6}
                      y={tick.y + 3}
                      textAnchor="end"
                      fill="var(--text-dim)"
                      fontSize="9"
                      fontFamily="var(--font-mono, monospace)"
                    >
                      {tick.label}
                    </text>
                  </g>
                ))}

                {/* X Axis Labels */}
                {chartData.xTicks.map((tick, i) => (
                  <text
                    key={i}
                    x={tick.x}
                    y={chartData.height - 4}
                    textAnchor="middle"
                    fill="var(--text-dim)"
                    fontSize="9"
                  >
                    {tick.label}
                  </text>
                ))}

                {/* Filled Area */}
                {chartData.areaD && (
                  <path d={chartData.areaD} fill="url(#usageAreaGradient)" />
                )}

                {/* Smooth Curve Line */}
                {chartData.pathD && (
                  <path
                    d={chartData.pathD}
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                )}

                {/* Interactive Crosshair & Point */}
                {hoverPos && (
                  <g pointerEvents="none">
                    <line
                      x1={hoverPos.x}
                      y1={chartData.padTop}
                      x2={hoverPos.x}
                      y2={chartData.padTop + chartData.plotHeight}
                      stroke="var(--text-dim)"
                      strokeWidth="1"
                      strokeDasharray="2 2"
                    />
                    <circle
                      cx={hoverPos.x}
                      cy={hoverPos.y}
                      r="4"
                      fill="var(--bg-panel)"
                      stroke="var(--accent)"
                      strokeWidth="2.5"
                    />
                  </g>
                )}
              </svg>
            )}

            {/* Hover Tooltip Overlay */}
            {activeHoverPoint && hoverPos && (
              <div
                style={{
                  position: "absolute",
                  left: `${Math.max(12, Math.min(88, (hoverPos.x / (chartData?.width || 1)) * 100))}%`,
                  top: Math.max(26, hoverPos.y - 8),
                  transform: "translate(-50%, -100%)",
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-control)",
                  boxShadow: "var(--shadow-card)",
                  padding: "6px 9px",
                  pointerEvents: "none",
                  zIndex: 10,
                  fontSize: 11,
                  display: "flex",
                  flexDirection: "column",
                  gap: 3,
                  whiteSpace: "nowrap",
                }}
              >
                <div style={{ fontWeight: 600, color: "var(--text)", borderBottom: "1px solid var(--border)", paddingBottom: 2 }}>
                  {activeHoverPoint.label}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <span style={{ color: "var(--text-muted)" }}>
                    {metricView === "cost" ? t("usageConfig.cost") : t("usageConfig.tokens")}:
                  </span>
                  <span style={{ fontWeight: 600, color: "var(--text)" }}>
                    {metricView === "cost"
                      ? formatCurrency(activeHoverPoint.totalCost)
                      : formatTokens(activeHoverPoint.totalTokens)}
                  </span>
                </div>
                {Object.entries(activeHoverPoint.byProvider).map(([p, data]) => (
                  <div key={p} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 10 }}>
                    <span style={{ color: "var(--text-dim)" }}>{p}:</span>
                    <span style={{ color: "var(--text-muted)" }}>
                      {metricView === "cost" ? formatCurrency(data.cost) : formatTokens(data.tokens)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 3. Middle Row: 5 Metric Cards Grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
          gap: 10,
        }}
      >
        {/* Metric 1: Processed tokens */}
        <div
          style={{
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            padding: "12px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "var(--font-serif, serif)", color: "var(--text)" }}>
            {formatTokens(summary?.totalTokens ?? 0)}
          </div>
          <div style={{ fontSize: 11, fontWeight: 500, color: "var(--text)" }}>
            {t("usageConfig.processedTokens")}
          </div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
            {t("usageConfig.perActiveDay", { count: formatTokens(summary?.tokensPerActiveDay ?? 0) })}
          </div>
        </div>

        {/* Metric 2: Cached input */}
        <div
          style={{
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            padding: "12px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "var(--font-serif, serif)", color: "var(--text)" }}>
            {formatTokens(summary?.cacheReadTokens ?? 0)}
          </div>
          <div style={{ fontSize: 11, fontWeight: 500, color: "var(--text)" }}>
            {t("usageConfig.cachedInput")}
          </div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
            {t("usageConfig.ofObservedInput", { percent: (summary?.cachePercentage ?? 0).toFixed(1) })}
          </div>
        </div>

        {/* Metric 3: Uncached input */}
        <div
          style={{
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            padding: "12px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "var(--font-serif, serif)", color: "var(--text)" }}>
            {formatTokens(summary?.inputTokens ?? 0)}
          </div>
          <div style={{ fontSize: 11, fontWeight: 500, color: "var(--text)" }}>
            {t("usageConfig.uncachedInput")}
          </div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
            {t("usageConfig.cacheWritesCount", { count: formatTokens(summary?.cacheWriteTokens ?? 0) })}
          </div>
        </div>

        {/* Metric 4: Output */}
        <div
          style={{
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            padding: "12px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "var(--font-serif, serif)", color: "var(--text)" }}>
            {formatTokens(summary?.outputTokens ?? 0)}
          </div>
          <div style={{ fontSize: 11, fontWeight: 500, color: "var(--text)" }}>
            {t("usageConfig.output")}
          </div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
            {t("usageConfig.includesReasoning", { count: formatTokens(summary?.reasoningTokens ?? 0) })}
          </div>
        </div>

        {/* Metric 5: Cache savings */}
        <div
          style={{
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            padding: "12px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "var(--font-serif, serif)", color: "var(--accent)" }}>
            {formatCurrency(summary?.cacheSavings ?? 0)}
          </div>
          <div style={{ fontSize: 11, fontWeight: 500, color: "var(--text)" }}>
            {t("usageConfig.cacheSavings")}
          </div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
            {t("usageConfig.cacheSavingsSub", {
              multiplier: summary && summary.totalCost > 0
                ? ((summary.cacheSavings || 0) / summary.totalCost).toFixed(1)
                : "0.0",
            })}
          </div>
        </div>
      </div>

      {/* 4. Bottom Row: Breakdown Table & Cost Quality */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: 14,
        }}
      >
        {/* Left Card: Breakdown Table */}
        <div
          style={{
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-card)",
            padding: "14px 16px",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {/* Breakdown Header & Toggle */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
              {t("usageConfig.breakdown")}
            </span>

            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                background: "var(--bg-subtle)",
                padding: 2,
                borderRadius: "var(--radius-control)",
                border: "1px solid var(--border)",
              }}
            >
              <button
                type="button"
                aria-pressed={breakdownView === "model"}
                onClick={() => setBreakdownView("model")}
                style={{
                  padding: "3px 8px",
                  fontSize: 11,
                  fontWeight: breakdownView === "model" ? 600 : 400,
                  borderRadius: "calc(var(--radius-control) - 2px)",
                  border: "none",
                  background: breakdownView === "model" ? "var(--bg-selected)" : "transparent",
                  color: breakdownView === "model" ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer",
                }}
              >
                {t("usageConfig.model").toUpperCase()}
              </button>
              <button
                type="button"
                aria-pressed={breakdownView === "day"}
                onClick={() => setBreakdownView("day")}
                style={{
                  padding: "3px 8px",
                  fontSize: 11,
                  fontWeight: breakdownView === "day" ? 600 : 400,
                  borderRadius: "calc(var(--radius-control) - 2px)",
                  border: "none",
                  background: breakdownView === "day" ? "var(--bg-selected)" : "transparent",
                  color: breakdownView === "day" ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer",
                }}
              >
                {t("usageConfig.day").toUpperCase()}
              </button>
              <button
                type="button"
                aria-pressed={breakdownView === "project"}
                onClick={() => setBreakdownView("project")}
                style={{
                  padding: "3px 8px",
                  fontSize: 11,
                  fontWeight: breakdownView === "project" ? 600 : 400,
                  borderRadius: "calc(var(--radius-control) - 2px)",
                  border: "none",
                  background: breakdownView === "project" ? "var(--bg-selected)" : "transparent",
                  color: breakdownView === "project" ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer",
                }}
              >
                {t("usageConfig.project").toUpperCase()}
              </button>
            </div>
          </div>

          {/* Table Container */}
          <div style={{ maxHeight: 220, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-dim)", textAlign: "left" }}>
                  <th style={{ padding: "6px 4px", fontWeight: 500 }}>
                    {breakdownView === "model"
                      ? t("usageConfig.model")
                      : breakdownView === "day"
                        ? t("usageConfig.day")
                        : t("usageConfig.project")}
                  </th>
                  <th style={{ padding: "6px 8px", fontWeight: 500, textAlign: "right" }}>{t("usageConfig.cost")}</th>
                  <th style={{ padding: "6px 8px", fontWeight: 500, textAlign: "right" }}>{t("usageConfig.share")}</th>
                  <th style={{ padding: "6px 4px", fontWeight: 500, textAlign: "right" }}>{t("usageConfig.tokens")}</th>
                </tr>
              </thead>
              <tbody>
                {breakdownView === "model" &&
                  (modelBreakdown.length === 0 ? (
                    <tr>
                      <td colSpan={4} style={{ padding: "16px 4px", textAlign: "center", color: "var(--text-dim)" }}>
                        {t("usageConfig.emptyTitle")}
                      </td>
                    </tr>
                  ) : (
                    modelBreakdown.map((m) => (
                      <tr key={`${m.provider}/${m.model}`} style={{ borderBottom: "1px solid var(--bg-subtle)" }}>
                        <td style={{ padding: "6px 4px", color: "var(--text)", fontWeight: 500 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: "var(--accent)" }} />
                            <span title={m.model} style={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {m.model}
                            </span>
                          </div>
                        </td>
                        <td style={{ padding: "6px 8px", textAlign: "right", color: "var(--text)", fontWeight: 600 }}>
                          {formatCurrency(m.cost)}
                        </td>
                        <td style={{ padding: "6px 8px", textAlign: "right", color: "var(--text-muted)" }}>
                          {m.share.toFixed(1)}%
                        </td>
                        <td style={{ padding: "6px 4px", textAlign: "right", color: "var(--text-muted)" }}>
                          {formatTokens(m.tokens)}
                        </td>
                      </tr>
                    ))
                  ))}

                {breakdownView === "day" &&
                  (dayBreakdown.length === 0 ? (
                    <tr>
                      <td colSpan={4} style={{ padding: "16px 4px", textAlign: "center", color: "var(--text-dim)" }}>
                        {t("usageConfig.emptyTitle")}
                      </td>
                    </tr>
                  ) : (
                    dayBreakdown.map((d) => (
                      <tr key={d.date} style={{ borderBottom: "1px solid var(--bg-subtle)" }}>
                        <td style={{ padding: "6px 4px", color: "var(--text)", fontWeight: 500 }}>
                          {d.label}
                        </td>
                        <td style={{ padding: "6px 8px", textAlign: "right", color: "var(--text)", fontWeight: 600 }}>
                          {formatCurrency(d.cost)}
                        </td>
                        <td style={{ padding: "6px 8px", textAlign: "right", color: "var(--text-muted)" }}>
                          {d.share.toFixed(1)}%
                        </td>
                        <td style={{ padding: "6px 4px", textAlign: "right", color: "var(--text-muted)" }}>
                          {formatTokens(d.tokens)}
                        </td>
                      </tr>
                    ))
                  ))}

                {breakdownView === "project" &&
                  (projectBreakdown.length === 0 ? (
                    <tr>
                      <td colSpan={4} style={{ padding: "16px 4px", textAlign: "center", color: "var(--text-dim)" }}>
                        {t("usageConfig.emptyTitle")}
                      </td>
                    </tr>
                  ) : (
                    projectBreakdown.map((p) => (
                      <tr key={p.project} style={{ borderBottom: "1px solid var(--bg-subtle)" }}>
                        <td style={{ padding: "6px 4px", color: "var(--text)", fontWeight: 500 }}>
                          <span title={p.project}>{p.projectName}</span>
                        </td>
                        <td style={{ padding: "6px 8px", textAlign: "right", color: "var(--text)", fontWeight: 600 }}>
                          {formatCurrency(p.cost)}
                        </td>
                        <td style={{ padding: "6px 8px", textAlign: "right", color: "var(--text-muted)" }}>
                          {p.share.toFixed(1)}%
                        </td>
                        <td style={{ padding: "6px 4px", textAlign: "right", color: "var(--text-muted)" }}>
                          {formatTokens(p.tokens)}
                        </td>
                      </tr>
                    ))
                  ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right Card: Cost Quality */}
        <div
          style={{
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-card)",
            padding: "14px 16px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
            {t("usageConfig.costQuality")}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {/* Row 1: Provider reported */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
              <span style={{ color: "var(--text-muted)" }}>{t("usageConfig.providerReported")}</span>
              <span style={{ fontWeight: 600, color: "var(--text)" }}>
                {(summary?.costQuality.providerReported ?? 0).toFixed(1)}%
              </span>
            </div>

            {/* Row 2: Model priced */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
              <span style={{ color: "var(--text-muted)" }}>{t("usageConfig.modelPriced")}</span>
              <span style={{ fontWeight: 600, color: "var(--text)" }}>
                {(summary?.costQuality.modelPriced ?? 0).toFixed(1)}%
              </span>
            </div>

            {/* Row 3: Unpriced */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
              <span style={{ color: "var(--text-muted)" }}>{t("usageConfig.unpriced")}</span>
              <span style={{ fontWeight: 600, color: "var(--text)" }}>
                {(summary?.costQuality.unpriced ?? 0).toFixed(1)}%
              </span>
            </div>

            {/* Divider */}
            <div style={{ height: 1, background: "var(--border)", margin: "2px 0" }} />

            {/* Row 4: Cache savings */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
              <span style={{ color: "var(--text-muted)" }}>{t("usageConfig.cacheSavings")}</span>
              <span style={{ fontWeight: 600, color: "var(--accent)" }}>
                {formatCurrency(summary?.cacheSavings ?? 0)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 5. Footer: Transcript Scan Status */}
      {scanInfo && (
        <div
          style={{
            fontSize: 11,
            color: "var(--text-dim)",
            textAlign: "center",
            marginTop: 4,
          }}
        >
          {t("usageConfig.scanStatus", {
            transcripts: scanInfo.transcriptsScanned,
            outside: scanInfo.transcriptsOutsideWindow,
            records: scanInfo.usageRecordsCount,
            duration: scanInfo.durationSeconds.toFixed(1),
          })}
        </div>
      )}
    </div>
  );
}
