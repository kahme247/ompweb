import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { parseChartValue, chartSeriesFromRows, chartSeriesFromHast, chartDomain, chartGeometry, tableChartSvg } = await createJiti(import.meta.url).import("./table-chart.ts");

test("an approximate multilingual token table produces the same six magnitudes", () => {
  const labels = ["MCP 서버 지시문", "xd:// 디바이스 카탈로그", "MCP Tool Routes", "코어 툴 스키마 13개", "시스템 프롬프트", "memory 요약 + skills 2개"];
  const values = ["~8k tok", "~5k tok", "~2.5k tok", "~4k tok", "~2.5k tok", "~2k tok"];
  const [chart] = chartSeriesFromRows(["구성 요소", "규모 (추정)", "내용"], labels.map((label, i) => [label, values[i], "참고 설명"]));
  assert.deepEqual(chart.rows.map((row) => row.value), [8000, 5000, 2500, 4000, 2500, 2000]);
  assert.deepEqual(chart.rows.map((row) => row.raw), values);
  assert.ok(chart.rows.every((row) => row.approximate));
  assert.deepEqual(chart.rows.map((row) => row.label), labels);
});

test("prose and malformed grouping are not invented as numeric values", () => {
  for (const value of ["10 ± 2", "v1.2", "13개 도구", "1,2", "1,234,56", "Infinity", "1e999", "—"]) assert.equal(parseChartValue(value), null, value);
  assert.equal(parseChartValue("82.5%").value, 82.5);
  assert.equal(parseChartValue("$1.2M").value, 1200000);
  assert.equal(parseChartValue("5 B").value, 5);
});

test("axes include zero, support negatives, and never mix units", () => {
  const [chart] = chartSeriesFromRows(["이름", "변화"], [["가", "-4"], ["나", "6"]]);
  assert.deepEqual(chartDomain(chart), { min: -4, max: 6, zero: 40 });
  assert.deepEqual(chartSeriesFromRows(["이름", "크기"], [["가", "4 GiB"], ["나", "6 MiB"]]), []);
  assert.deepEqual(chartSeriesFromRows(["이름", "설명"], [["가", "좋음"], ["나", "보통"]]), []);
});

test("multiple measures stay separate and missing rows are counted", () => {
  const charts = chartSeriesFromRows(["이름", "초", "%"], [["가", "4 s", "90%"], ["나", "6 s", "80%"], ["다", "N/A", "70%"]]);
  assert.equal(charts.length, 2); assert.equal(charts[0].skipped, 1); assert.equal(charts[1].skipped, 0);
});

test("HAST extraction preserves text and export escapes hostile labels", () => {
  const text = (value) => ({ type: "text", value });
  const cell = (tagName, value) => ({ type: "element", tagName, children: [text(value)] });
  const tr = (tag, values) => ({ tagName: "tr", children: values.map((value) => cell(tag, value)) });
  const [chart] = chartSeriesFromHast({ tagName: "table", children: [{ tagName: "thead", children: [tr("th", ["구성", "토큰"])] }, { tagName: "tbody", children: [tr("td", ["<script>alert(1)</script>", "8k tok"]), tr("td", ["한글 & 원문", "2k tok"])] }] });
  const svg = tableChartSvg(chart);
  assert.ok(svg.includes("&lt;script&gt;")); assert.ok(!svg.includes("<script>")); assert.ok(svg.includes("한글 &amp; 원문"));
});


test("ranges and limits retain all four rows from a mixed estimate table", () => {
  const raw = ["~9k", "~8–9k", "~4k", "<1k"];
  const [chart] = chartSeriesFromRows(["항목", "분량"], raw.map((value, i) => [`항목 ${i}`, value]));
  assert.equal(chart.rows.length, 4);
  assert.equal(chart.skipped, 0);
  assert.deepEqual(chart.rows.map(row => row.kind), ["point", "range", "point", "upper"]);
  assert.deepEqual(chart.rows.map(row => row.raw), raw);
  assert.equal(chart.rows[1].value, 8000);
  assert.equal(chart.rows[1].end, 9000);
  const domain = chartDomain(chart);
  const range = chartGeometry(chart.rows[1], domain);
  assert.ok(range.interval.width > 0);
  assert.equal(chartGeometry(chart.rows[3], domain).bar, null, "an upper limit is not an exact value bar");
  assert.match(tableChartSvg(chart), /&lt;1k/);
  assert.match(tableChartSvg(chart), /url\(#interval-hatch\)/);
});

test("range shorthand, explicit units, negative intervals, and inclusive bounds", () => {
  for (const raw of ["8-9k", "8~9k", "~8– 9k", "8k–9k", "8k–9", "8 to 9k"]) {
    const value = parseChartValue(raw);
    assert.equal(value.kind, "range", raw); assert.equal(value.value, 8000, raw); assert.equal(value.end, 9000, raw);
  }
  assert.equal(parseChartValue("28~29k tokens").unit, "tokens");
  assert.equal(parseChartValue("≤1%").inclusive, true);
  assert.equal(parseChartValue("> -5").kind, "lower");
  assert.equal(parseChartValue("-9--8").end, -8);
  const [cross] = chartSeriesFromRows(["Name", "Value"], [["A", "-4–6"], ["B", "0"]]);
  assert.equal(chartGeometry(cross.rows[0], chartDomain(cross)).bar.width, 0);
  assert.equal(chartGeometry(cross.rows[0], chartDomain(cross)).interval.width, 100);
  for (const raw of ["9–8k", "8 GiB–9 MiB", "v8–9", "8–9 cats"]) assert.equal(parseChartValue(raw), null, raw);
  const [limits] = chartSeriesFromRows(["Name", "Value"], [["A", "<-4"], ["B", ">6"]]);
  assert.ok(chartDomain(limits).min < -4);
  assert.ok(chartDomain(limits).max > 6);
});
