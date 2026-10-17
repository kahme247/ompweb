/** Browser-side table charts. Read recorded table values, never infer missing data. */
export interface ChartValue { value: number; unit: string; raw: string; approximate: boolean }
export interface TableSeries { column: number; header: string; unit: string; rows: Array<ChartValue & { label: string }>; skipped: number }
interface Node { type?: string; tagName?: string; value?: string; children?: Node[] }

export function parseChartValue(raw: string): ChartValue | null {
  const text = raw.trim().replace(/\u2212/g, "-");
  // Ranges, bounds, IDs and numbers embedded in prose are not point estimates.
  const match = text.match(/^([~≈≃]|약\s*)?\s*([$₩€£¥])?\s*([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(.*?)$/u);
  if (!match) return null;
  let value = Number(match[3].replaceAll(",", ""));
  let rest = match[4].trim();
  const multiplier = rest.match(/^(k|K|M|B|T|천|만|억)(?=$|\s|tok|token)/u);
  if (multiplier && (multiplier[1] !== "B" || Boolean(match[2]) || /tok/.test(rest))) {
    value *= ({ k: 1e3, K: 1e3, M: 1e6, B: 1e9, T: 1e12, 천: 1e3, 만: 1e4, 억: 1e8 } as Record<string, number>)[multiplier[1]];
    rest = rest.slice(multiplier[0].length).trim();
  }
  const units: Record<string, string> = { "": "", tok: "tokens", token: "tokens", tokens: "tokens", 토큰: "tokens", "%": "%", "tok/s": "tokens/s", "tokens/s": "tokens/s", "t/s": "tokens/s", "토큰/초": "tokens/s", ms: "ms", s: "s", sec: "s", 초: "s", 개: "count", 회: "count", 원: "KRW", USD: "USD", KRW: "KRW", GiB: "GiB", MiB: "MiB", KiB: "KiB", GB: "GB", MB: "MB", KB: "KB", B: "bytes" };
  if (!(rest in units) || !Number.isFinite(value)) return null;
  const currency = ({ "$": "USD", "₩": "KRW", "€": "EUR", "£": "GBP", "¥": "JPY" } as Record<string, string>)[match[2]];
  if (currency && rest && currency !== units[rest]) return null;
  return { value, unit: currency || units[rest], raw, approximate: Boolean(match[1]) };
}

function textOf(node: Node): string {
  if (node.type === "text") return node.value || "";
  if (node.tagName === "br") return " ";
  return (node.children || []).map(textOf).join("");
}

export function chartSeriesFromRows(headers: string[], rows: string[][]): TableSeries[] {
  if (headers.length < 2 || headers.length > 12 || rows.length < 2 || rows.length > 40) return [];
  const result: TableSeries[] = [];
  for (let column = 1; column < headers.length; column++) {
    if (/^(?:id|index|编号|번호|버전|version)$/i.test(headers[column].trim())) continue;
    const points = rows.flatMap((row) => {
      if (!row[0]?.trim()) return [];
      const value = parseChartValue(row[column] || "");
      return value ? [{ ...value, label: row[0] }] : [];
    });
    // Never put different units on the same axis or silently rescale them.
    if (points.length < 2 || new Set(points.map((point) => point.unit)).size !== 1) continue;
    result.push({ column, header: headers[column] || String(column + 1), unit: points[0].unit, rows: points, skipped: rows.length - points.length });
  }
  return result;
}

export function chartSeriesFromHast(input: unknown): TableSeries[] {
  const node = input as Node | null;
  if (node?.tagName !== "table") return [];
  const rows: string[][] = [];
  for (const section of node.children || []) {
    const candidates = section.tagName === "tr" ? [section] : ["thead", "tbody"].includes(section.tagName || "") ? section.children || [] : [];
    for (const row of candidates) {
      if (row.tagName !== "tr") continue;
      rows.push((row.children || []).filter((cell) => cell.tagName === "td" || cell.tagName === "th").map((cell) => textOf(cell).trim()));
    }
  }
  return rows.length ? chartSeriesFromRows(rows[0], rows.slice(1)) : [];
}

export function chartDomain(series: TableSeries): { min: number; max: number; zero: number } {
  const min = Math.min(0, ...series.rows.map((row) => row.value));
  const maxValue = Math.max(0, ...series.rows.map((row) => row.value));
  const max = min === maxValue ? maxValue + 1 : maxValue;
  return { min, max, zero: (0 - min) / (max - min) * 100 };
}

const escapeXml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

/** Standalone vector export with escaped labels and no executable markup. */
export function tableChartSvg(series: TableSeries): string {
  const domain = chartDomain(series);
  const x = (value: number) => 370 + (value - domain.min) / (domain.max - domain.min) * 440;
  const wrap = (text: string) => {
    const lines: string[] = []; let line = "", width = 0;
    for (const c of text) { const step = /[\u0020-\u007e]/.test(c) ? 0.6 : 1; if (width + step > 24) { lines.push(line); line = ""; width = 0; } line += c; width += step; }
    if (line) lines.push(line); return lines;
  };
  let y = 58;
  const elements = series.rows.map((row) => {
    const lines = wrap(row.label); const height = Math.max(44, lines.length * 18 + 12); const middle = y + height / 2;
    const label = lines.map((line, i) => `<text x="16" y="${y + 20 + i * 18}">${escapeXml(line)}</text>`).join("");
    const bar = `<rect x="${Math.min(x(0), x(row.value))}" y="${middle - 10}" width="${Math.abs(x(row.value) - x(0))}" height="20" rx="3" fill="#137bba"${row.approximate ? ' stroke="#075b8b" stroke-dasharray="5 3"' : ""}/><text x="830" y="${middle + 5}">${escapeXml(row.raw)}</text>`;
    y += height; return label + bar;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1040" height="${y + 30}" viewBox="0 0 1040 ${y + 30}" role="img"><title>${escapeXml(series.header)}</title><rect width="100%" height="100%" fill="#fff"/><g fill="#17232c" font-size="14" font-family="Malgun Gothic,Apple SD Gothic Neo,Noto Sans KR,Arial,sans-serif"><text x="16" y="28" font-size="18" font-weight="600">${escapeXml(series.header)}</text>${elements}<line x1="${x(0)}" x2="${x(0)}" y1="46" y2="${y}" stroke="#94a3b8"/></g></svg>`;
}
