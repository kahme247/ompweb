import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { parseChartValue, chartSeriesFromRows, chartSeriesFromHast, chartDomain, tableChartSvg } = await createJiti(import.meta.url).import("./table-chart.ts");

test("an approximate multilingual token table produces the same six magnitudes", () => {
  const labels = ["MCP 서버 지시문", "xd:// 디바이스 카탈로그", "MCP Tool Routes", "코어 툴 스키마 13개", "시스템 프롬프트", "memory 요약 + skills 2개"];
  const values = ["~8k tok", "~5k tok", "~2.5k tok", "~4k tok", "~2.5k tok", "~2k tok"];
  const [chart] = chartSeriesFromRows(["구성 요소", "규모 (추정)", "내용"], labels.map((label, i) => [label, values[i], "참고 설명"]));
  assert.deepEqual(chart.rows.map((row) => row.value), [8000, 5000, 2500, 4000, 2500, 2000]);
  assert.deepEqual(chart.rows.map((row) => row.raw), values);
  assert.ok(chart.rows.every((row) => row.approximate));
  assert.deepEqual(chart.rows.map((row) => row.label), labels);
});

test("ranges, bounds, prose and malformed grouping are not invented as points", () => {
  for (const value of ["28~29k tokens", "<1%", "10 ± 2", "v1.2", "13개 도구", "1,2", "1,234,56", "Infinity", "1e999", "—"]) assert.equal(parseChartValue(value), null, value);
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
