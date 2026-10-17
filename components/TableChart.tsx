"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Download } from "lucide-react";
import { chartDomain, chartGeometry, chartSeriesFromHast, tableChartSvg } from "@/lib/table-chart";
import { useI18n } from "@/lib/i18n";

/** Keep the source table visible; charts are a view of it, not new message data. */
export function TableChart({ node, children, enabled }: { node: unknown; children: ReactNode; enabled: boolean }) {
  const { t, locale } = useI18n();
  const series = useMemo(() => enabled ? chartSeriesFromHast(node) : [], [enabled, node]);
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(true);
  const selected = series[index] || series[0];
  if (!selected) return children;
  const domain = chartDomain(selected);
  const format = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: 3 });
  const download = () => {
    const url = URL.createObjectURL(new Blob([tableChartSvg(selected)], { type: "image/svg+xml;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "table-chart.svg"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <>
    {children}
    <section className="table-auto-chart" aria-label={t("tableChart.title")} data-table-chart>
      <div className="table-auto-chart-toolbar">
        <button type="button" className="ui-focus-ring" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}{t("tableChart.title")}
        </button>
        {series.length > 1 ? <select aria-label={t("tableChart.measure")} value={index} onChange={(event) => setIndex(Number(event.target.value))}>
          {series.map((item, i) => <option key={item.column} value={i}>{item.header}</option>)}
        </select> : <span className="table-auto-chart-measure">{selected.header}</span>}
        <button type="button" className="ui-focus-ring" onClick={download}><Download size={13} aria-hidden />{t("tableChart.saveSvg")}</button>
      </div>
      {open && <>
        <p className="table-auto-chart-note">{t("tableChart.note")}{selected.skipped > 0 ? ` · ${t("tableChart.skipped", { count: selected.skipped })}` : ""}</p>
        <ul className="table-auto-chart-rows" aria-label={selected.header}>
          {selected.rows.map((row, i) => {
            const geometry = chartGeometry(row, domain);
            return <li key={i} data-value-kind={row.kind}>
              <span className="table-auto-chart-label">{row.label}</span>
              <div className="table-auto-chart-track" aria-hidden="true">
                <span className="table-auto-chart-zero" style={{ left: `${domain.zero}%` }} />
                {geometry.bar && <span className={row.approximate ? "table-auto-chart-bar is-approximate" : "table-auto-chart-bar"} style={{ left: `${geometry.bar.left}%`, width: `${geometry.bar.width}%` }} />}
                {geometry.interval && <span className="table-auto-chart-bar is-range" style={{ left: `${geometry.interval.left}%`, width: `${geometry.interval.width}%` }} />}
                {geometry.limit && <span className={`table-auto-chart-limit is-${row.kind}`} style={{ left: `${geometry.limit.at}%` }}>{row.kind === "upper" ? "←" : "→"}</span>}
              </div>
              <span className="table-auto-chart-value">{row.raw}</span>
            </li>;
          })}
        </ul>
        <div className="table-auto-chart-axis" aria-hidden="true"><span>{format(domain.min)}</span><span>{format(domain.max)}{selected.unit ? ` ${selected.unit}` : ""}</span></div>
      </>}
    </section>
  </>;
}
