"use client";

import { Fragment, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Download } from "lucide-react";
import { chartDomain, chartGeometry, chartGroupsFromHast, tableChartSvg } from "@/lib/table-chart";
import { useI18n } from "@/lib/i18n";

/** Keep the source table visible; charts are a view of it, not new message data. */
export function TableChart({ node, children, enabled }: { node: unknown; children: ReactNode; enabled: boolean }) {
  const { t, locale } = useI18n();
  const groups = useMemo(() => enabled ? chartGroupsFromHast(node) : [], [enabled, node]);
  const [open, setOpen] = useState(true);
  if (!groups.length) return children;
  const format = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: 3 });
  const download = () => {
    const url = URL.createObjectURL(new Blob([tableChartSvg(groups)], { type: "image/svg+xml;charset=utf-8" }));
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
        <button type="button" className="ui-focus-ring" onClick={download}><Download size={13} aria-hidden />{t("tableChart.saveSvg")}</button>
      </div>
      {open && <>
        <p className="table-auto-chart-note">{t("tableChart.note")}</p>
        {groups.map((group) => {
          const domain = chartDomain(group);
          return <div key={group.series[0].column} className="table-auto-chart-group">
            <ul className="table-auto-chart-legend" aria-label={t("tableChart.legend")}>
              {group.series.map((series) => <li key={series.column}><span className="table-auto-chart-swatch" data-series={series.slot} aria-hidden="true" />{series.header}</li>)}
            </ul>
            {group.skipped > 0 && <p className="table-auto-chart-note">{t("tableChart.skipped", { count: group.skipped })}</p>}
            <ul className="table-auto-chart-rows" aria-label={group.series.map((series) => series.header).join(", ")}>
              {group.rows.map((row, i) => <li key={i}>
                <span className="table-auto-chart-label">{row.label}</span>
                <div className="table-auto-chart-bars">
                  {group.series.map((series, s) => {
                    const value = row.values[s];
                    const geometry = value && chartGeometry(value, domain);
                    return <Fragment key={series.column}>
                      <div className="table-auto-chart-track" data-series={series.slot} aria-hidden="true">
                        <span className="table-auto-chart-zero" style={{ left: `${domain.zero}%` }} />
                        {value && geometry && <>
                          {geometry.bar && <span className={value.approximate ? "table-auto-chart-bar is-approximate" : "table-auto-chart-bar"} style={{ left: `${geometry.bar.left}%`, width: `${geometry.bar.width}%` }} />}
                          {geometry.interval && <span className="table-auto-chart-bar is-range" style={{ left: `${geometry.interval.left}%`, width: `${geometry.interval.width}%` }} />}
                          {geometry.limit && <span className={`table-auto-chart-limit is-${value.kind}`} style={{ left: `${geometry.limit.at}%` }}>{value.kind === "upper" ? "←" : "→"}</span>}
                        </>}
                      </div>
                      <span className="table-auto-chart-value" data-value-kind={value?.kind}>{value && <><span className="sr-only">{series.header}: </span>{value.raw}</>}</span>
                    </Fragment>;
                  })}
                </div>
              </li>)}
              <li className="table-auto-chart-axis" aria-hidden="true"><div><span>{format(domain.min)}</span><span>{format(domain.max)}{group.unit ? ` ${group.unit}` : ""}</span></div></li>
            </ul>
          </div>;
        })}
      </>}
    </section>
  </>;
}
