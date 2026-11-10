/** Browser-side table charts. Read recorded table values, never infer missing data. */
export interface ChartValue { value: number; unit: string; raw: string; approximate: boolean; kind: "point" | "range" | "upper" | "lower"; end?: number; inclusive?: boolean }
export interface ChartSeries { column: number; header: string; slot: number }
/** One table row; `values` lines up with the group's series and is null where the cell did not parse. */
export interface ChartRow { label: string; values: Array<ChartValue | null> }
/** Series sharing one unit, plotted against one axis. `skipped` counts rows with no value in any series. */
export interface ChartGroup { unit: string; series: ChartSeries[]; rows: ChartRow[]; skipped: number }
/** Light-theme --accent, --status-renamed, --status-success, --status-warning, --text-muted for the standalone SVG (white background, no live theme). Slot n pairs with `[data-series="n"]` in globals.css. */
export const SERIES_COLORS = ["#B03E22", "#2563EB", "#18794E", "#8A5A00", "#69635A"];
interface Node { type?: string; tagName?: string; value?: string; children?: Node[] }

const APPROX = /^(?:[~≈≃]|약|(?:about|approx\.|approximately|around|roughly)(?=\s))\s*/iu;

function parseScalar(raw: string): ChartValue | null {
  const text = raw.trim().replace(/\u2212/g, "-");
  // Only a complete scalar is accepted here; intervals are parsed separately.
  const lead = text.match(APPROX)?.[0] ?? "";
  const match = text.slice(lead.length).match(/^\s*([$₩€£¥])?\s*([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(.*?)$/u);
  if (!match) return null;
  let value = Number(match[2].replaceAll(",", ""));
  let rest = match[3].trim();
  const multiplier = rest.match(/^(k|K|M|B|T|천|만|억)(?=$|\s|tok|token)/u);
  if (multiplier && (multiplier[1] !== "B" || Boolean(match[1]) || /tok/.test(rest))) {
    value *= ({ k: 1e3, K: 1e3, M: 1e6, B: 1e9, T: 1e12, 천: 1e3, 만: 1e4, 억: 1e8 } as Record<string, number>)[multiplier[1]];
    rest = rest.slice(multiplier[0].length).trim();
  }
  const units: Record<string, string> = { "": "", tok: "tokens", token: "tokens", tokens: "tokens", 토큰: "tokens", "%": "%", "tok/s": "tokens/s", "tokens/s": "tokens/s", "t/s": "tokens/s", "토큰/초": "tokens/s", ms: "ms", s: "s", sec: "s", 초: "s", 개: "count", 회: "count", 원: "KRW", USD: "USD", KRW: "KRW", GiB: "GiB", MiB: "MiB", KiB: "KiB", GB: "GB", MB: "MB", KB: "KB", B: "bytes" };
  if (!(rest in units) || !Number.isFinite(value)) return null;
  const currency = ({ "$": "USD", "₩": "KRW", "€": "EUR", "£": "GBP", "¥": "JPY" } as Record<string, string>)[match[1]];
  if (currency && rest && currency !== units[rest]) return null;
  return { value, unit: currency || units[rest], raw, approximate: Boolean(lead), kind: "point" };
}

/** Preserve ranges and one-sided limits as such, never as invented midpoints. */
export function parseChartValue(raw: string): ChartValue | null {
  const text = raw.trim().replace(/\u2212/g, "-");
  const lead = text.match(APPROX)?.[0];
  const body = text.slice(lead?.length ?? 0).trim();
  const limit = body.match(/^(<=|>=|<|>|≤|≥)\s*(.+)$/u);
  if (limit) {
    const point = parseScalar(limit[2]);
    return point ? { ...point, raw, kind: /^(?:<|≤)/.test(limit[1]) ? "upper" : "lower", inclusive: /[=≤≥]/.test(limit[1]), approximate: Boolean(lead) || point.approximate } : null;
  }
  const number = "[+-]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?";
  const interval = body.match(new RegExp(`^([$₩€£¥]?)(${number})(.*?)\\s*(?:[–—~-]|to)\\s*([$₩€£¥]?)(${number})(.*?)$`, "u"));
  if (interval) {
    const [, lc, ln, lu, rc, rn, ru] = interval;
    const left = parseScalar(`${lc || rc}${ln}${lu.trim() || ru}`);
    const right = parseScalar(`${rc || lc}${rn}${ru.trim() || lu}`);
    if (!left || !right || left.unit !== right.unit || left.value > right.value) return null;
    return { ...left, raw, kind: "range", end: right.value, approximate: Boolean(lead) };
  }
  return parseScalar(raw);
}

/** Geometry shared by HTML and SVG; bounds get an arrow, not a value bar. */
export function chartGeometry(row: ChartValue, domain: { min: number; max: number; zero: number }) {
  const at = (value: number) => (value - domain.min) / (domain.max - domain.min) * 100;
  const span = (a: number, b: number) => ({ left: Math.min(at(a), at(b)), width: Math.abs(at(b) - at(a)) });
  if (row.kind === "upper" || row.kind === "lower") return { bar: null, interval: null, limit: { at: at(row.value), direction: row.kind } };
  if (row.kind === "range") {
    const end = row.end!;
    const nearZero = row.value > 0 ? row.value : end < 0 ? end : 0;
    return { bar: span(0, nearZero), interval: span(row.value, end), limit: null };
  }
  return { bar: span(0, row.value), interval: null, limit: null };
}

function textOf(node: Node): string {
  if (node.type === "text") return node.value || "";
  if (node.tagName === "br") return " ";
  return (node.children || []).map(textOf).join("");
}

// Index columns carry an ordinal, not a name; identifier headers never hold a measure.
const INDEX_HEADER = /^(?:#|id|no\.?|index)$/i;
const IDENTIFIER_HEADER = /^(?:#|id|no\.?|index|编号|번호|버전|version)$/i;

/** Groups share a unit and fit the palette. The label is the first non-index column (column 0 if every column is one). */
export function chartGroupsFromRows(headers: string[], rows: string[][]): ChartGroup[] {
  if (headers.length < 2 || headers.length > 12 || rows.length < 2 || rows.length > 40) return [];
  const isIndex = (column: number) => INDEX_HEADER.test(headers[column].trim()) || rows.every((row) => !row[column]?.trim() || /^#?\d+$/.test(row[column].trim()));
  const label = Math.max(headers.findIndex((_, column) => !isIndex(column)), 0);
  const byUnit = new Map<string, Array<{ column: number; values: Array<ChartValue | null> }>>();
  // shortcut: an integer-only data column left of the label column reads as an index and is not charted.
  for (let column = label + 1; column < headers.length; column++) {
    if (IDENTIFIER_HEADER.test(headers[column].trim())) continue;
    const values = rows.map((row) => row[label]?.trim() ? parseChartValue(row[column] || "") : null);
    const units = new Set(values.flatMap((value) => value ? [value.unit] : []));
    // Never put different units on the same axis or silently rescale them.
    if (values.filter(Boolean).length < 2 || units.size !== 1) continue;
    const [unit] = units;
    byUnit.set(unit, [...(byUnit.get(unit) || []), { column, values }]);
  }
  return [...byUnit].flatMap(([unit, members]) => {
    const groups: ChartGroup[] = [];
    // Separate charts keep every legend unambiguous without repeating colours.
    for (let start = 0; start < members.length; start += SERIES_COLORS.length) {
      const batch = members.slice(start, start + SERIES_COLORS.length);
      const kept = rows.flatMap((row, r) => batch.some((member) => member.values[r]) ? [{ label: row[label], values: batch.map((member) => member.values[r]) }] : []);
      const series = batch.map(({ column }, slot) => ({ column, header: headers[column] || String(column + 1), slot }));
      groups.push({ unit, series, rows: kept, skipped: rows.length - kept.length });
    }
    return groups;
  });
}

export function chartGroupsFromHast(input: unknown): ChartGroup[] {
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
  return rows.length ? chartGroupsFromRows(rows[0], rows.slice(1)) : [];
}

export function chartDomain(group: ChartGroup): { min: number; max: number; zero: number } {
  const values = group.rows.flatMap((row) => row.values.filter((value): value is ChartValue => value !== null));
  const numbers = values.flatMap((value) => value.end === undefined ? [value.value] : [value.value, value.end]);
  let min = Math.min(0, ...numbers);
  const maxValue = Math.max(0, ...numbers);
  let max = min === maxValue ? maxValue + 1 : maxValue;
  const padding = (max - min) * 0.06;
  if (values.some((value) => value.kind === "upper" && value.value === min)) min -= padding;
  if (values.some((value) => value.kind === "lower" && value.value === max)) max += padding;
  return { min, max, zero: (0 - min) / (max - min) * 100 };
}

const escapeXml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

/** Standalone vector export with escaped labels and no executable markup. */
export function tableChartSvg(groups: ChartGroup[]): string {
  const left = 370, span = 440, bar = 12, step = 18;
  const wrap = (text: string) => {
    const lines: string[] = []; let line = "", width = 0;
    for (const c of text) { const em = /[\u0020-\u007e]/.test(c) ? 0.6 : 1; if (width + em > 24) { lines.push(line); line = ""; width = 0; } line += c; width += em; }
    if (line) lines.push(line); return lines;
  };
  const parts: string[] = [];
  let y = 0;
  for (const group of groups) {
    const domain = chartDomain(group);
    const x = (value: number) => left + (value - domain.min) / (domain.max - domain.min) * span;
    let legendX = 16; y += 22;
    for (const series of group.series) {
      const width = 38 + [...series.header].reduce((sum, c) => sum + (/[\u0020-\u007e]/.test(c) ? 0.6 : 1), 0) * 14;
      if (legendX > 16 && legendX + width > 1024) { legendX = 16; y += 22; }
      parts.push(`<rect x="${legendX}" y="${y - 11}" width="12" height="12" rx="2" fill="${SERIES_COLORS[series.slot]}"/><text x="${legendX + 18}" y="${y}">${escapeXml(series.header)}</text>`);
      legendX += width;
    }
    y += 12;
    const top = y;
    for (const row of group.rows) {
      const lines = wrap(row.label); const height = Math.max(lines.length, group.series.length) * step + 14;
      const labelTop = y + (height - lines.length * step) / 2; const barsTop = y + (height - group.series.length * step) / 2;
      lines.forEach((line, i) => parts.push(`<text x="16" y="${labelTop + 14 + i * step}">${escapeXml(line)}</text>`));
      group.series.forEach(({ slot }, i) => {
        const value = row.values[i]; if (!value) return;
        const barY = barsTop + i * step + (step - bar) / 2; const middle = barY + bar / 2;
        const geometry = chartGeometry(value, domain);
        const rect = (box: { left: number; width: number }, interval = false) => `<rect x="${left + box.left / 100 * span}" y="${barY}" width="${box.width / 100 * span}" height="${bar}" rx="3" fill="${interval ? `url(#interval-hatch-${slot})` : SERIES_COLORS[slot]}"${value.approximate || interval ? ' stroke="#17232c" stroke-dasharray="5 3"' : ""}/>`;
        const limit = geometry.limit ? `<line x1="${x(value.value)}" x2="${x(value.value)}" y1="${middle - 9}" y2="${middle + 9}" stroke="#17232c"/><text x="${x(value.value) + (value.kind === "upper" ? -4 : 4)}" y="${middle + 4}" font-size="12" text-anchor="${value.kind === "upper" ? "end" : "start"}">${value.kind === "upper" ? "←" : "→"}</text>` : "";
        parts.push((geometry.bar ? rect(geometry.bar) : "") + (geometry.interval ? rect(geometry.interval, true) : "") + limit + `<text x="830" y="${middle + 4}" font-size="12">${escapeXml(value.raw)}</text>`);
      });
      y += height;
    }
    parts.push(`<line x1="${x(0)}" x2="${x(0)}" y1="${top}" y2="${y}" stroke="#94a3b8"/><text x="${left}" y="${y + 16}" font-size="12">${Number(domain.min.toFixed(3))}</text><text x="${left + span}" y="${y + 16}" font-size="12" text-anchor="end">${Number(domain.max.toFixed(3))}${group.unit ? ` ${escapeXml(group.unit)}` : ""}</text>`);
    y += 36;
  }
  const hatches = SERIES_COLORS.map((color, i) => `<pattern id="interval-hatch-${i}" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="#F2F0EA"/><path d="M0 6L6 0" stroke="${color}"/></pattern>`).join("");
  const title = escapeXml(groups.flatMap((group) => group.series.map((series) => series.header)).join(", "));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1040" height="${y}" viewBox="0 0 1040 ${y}" role="img"><title>${title}</title><defs>${hatches}</defs><rect width="100%" height="100%" fill="#fff"/><g fill="#17232c" font-size="14" font-family="Malgun Gothic,Apple SD Gothic Neo,Noto Sans KR,Arial,sans-serif">${parts.join("")}</g></svg>`;
}
