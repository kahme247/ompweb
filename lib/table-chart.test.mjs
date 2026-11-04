import assert from "node:assert/strict";
import test from "node:test";
const { parseChartValue, chartGroupsFromRows, chartGroupsFromHast, chartDomain, chartGeometry, tableChartSvg, SERIES_COLORS } = await import("./table-chart.ts");

const tableA = [["Scope", "Estimated saving", "`app0` after (now 93.5%)"], [
  ["#1–#4", "18–46 KB", "about 91.5–92.7%"],
  ["#5 alone (WiFiManager)", "50–60 KB", "about 90.9–91.3%"],
  ["All five", "68–106 KB", "about 88.8–90.5%"],
]];
const tableB = [["#", "Target", "Now", "Proposal", "Estimated saving"], [
  ["1", "updateSetting()", "13.1 KB", "settings table", "10–15 KB"],
  ["2", "REST handlers", "11.7 KB", "table-driven", "3–6 KB"],
  ["3", "AceTime zone_infos.cpp.o", "28 KB", "zone-only registry", "5–15 KB"],
  ["4", "sscanf, 11 call sites", "9.6 KB", "strtol", "≤9.6 KB"],
  ["5", "WiFiManager", "70 KB", "async portal", "50–60 KB"],
]];

test("an approximate multilingual token table produces the same six magnitudes", () => {
  const labels = ["MCP 서버 지시문", "xd:// 디바이스 카탈로그", "MCP Tool Routes", "코어 툴 스키마 13개", "시스템 프롬프트", "memory 요약 + skills 2개"];
  const values = ["~8k tok", "~5k tok", "~2.5k tok", "~4k tok", "~2.5k tok", "~2k tok"];
  const [group] = chartGroupsFromRows(["구성 요소", "규모 (추정)", "내용"], labels.map((label, i) => [label, values[i], "참고 설명"]));
  assert.deepEqual(group.rows.map((row) => row.values[0].value), [8000, 5000, 2500, 4000, 2500, 2000]);
  assert.deepEqual(group.rows.map((row) => row.values[0].raw), values);
  assert.ok(group.rows.every((row) => row.values[0].approximate));
  assert.deepEqual(group.rows.map((row) => row.label), labels);
});

test("prose and malformed grouping are not invented as numeric values", () => {
  for (const value of ["10 ± 2", "v1.2", "13개 도구", "1,2", "1,234,56", "Infinity", "1e999", "—", "about", "aboutish 5", "about5"]) assert.equal(parseChartValue(value), null, value);
  assert.equal(parseChartValue("82.5%").value, 82.5);
  assert.equal(parseChartValue("$1.2M").value, 1200000);
  assert.equal(parseChartValue("5 B").value, 5);
});

test("word prefixes mark a value as approximate, as ~ does", () => {
  const range = parseChartValue("about 91.5–92.7%");
  assert.deepEqual([range.kind, range.value, range.end, range.unit, range.approximate, range.raw], ["range", 91.5, 92.7, "%", true, "about 91.5–92.7%"]);
  for (const raw of ["about 5 KB", "Approx. 5 KB", "approximately 5 KB", "Around 5 KB", "roughly 5 KB", "about $5"]) {
    const value = parseChartValue(raw);
    assert.equal(value.kind, "point", raw); assert.equal(value.value, 5, raw); assert.equal(value.approximate, true, raw);
  }
  assert.equal(parseChartValue("about ≤5 KB").kind, "upper");
  assert.equal(parseChartValue("about ≤5 KB").approximate, true);
  assert.equal(parseChartValue("5 KB").approximate, false);
});

test("axes include zero, support negatives, and never mix units", () => {
  const [group] = chartGroupsFromRows(["이름", "변화"], [["가", "-4"], ["나", "6"]]);
  assert.deepEqual(chartDomain(group), { min: -4, max: 6, zero: 40 });
  assert.deepEqual(chartGroupsFromRows(["이름", "크기"], [["가", "4 GiB"], ["나", "6 MiB"]]), []);
  assert.deepEqual(chartGroupsFromRows(["이름", "설명"], [["가", "좋음"], ["나", "보통"]]), []);
});

test("measures with different units become separate groups and unparsed rows are counted per group", () => {
  const groups = chartGroupsFromRows(["이름", "초", "%"], [["가", "4 s", "90%"], ["나", "6 s", "80%"], ["다", "N/A", "70%"]]);
  assert.deepEqual(groups.map((group) => group.unit), ["s", "%"]);
  assert.deepEqual(groups.map((group) => group.skipped), [1, 0]);
  assert.deepEqual(groups.map((group) => group.rows.length), [2, 3]);
});

test("Table A yields one KB group and one % group, each with all three rows", () => {
  const groups = chartGroupsFromRows(...tableA);
  assert.deepEqual(groups.map((group) => group.unit), ["KB", "%"]);
  assert.deepEqual(groups.map((group) => group.series.map((series) => series.header)), [["Estimated saving"], ["`app0` after (now 93.5%)"]]);
  for (const group of groups) {
    assert.deepEqual(group.rows.map((row) => row.label), ["#1–#4", "#5 alone (WiFiManager)", "All five"]);
    assert.equal(group.skipped, 0);
    assert.ok(group.rows.every((row) => row.values[0].kind === "range"));
  }
  assert.ok(groups[1].rows.every((row) => row.values[0].approximate));
  assert.equal(groups[1].rows[0].values[0].value, 91.5);
  assert.equal(groups[1].rows[0].values[0].end, 92.7);
});

test("Table B is labelled by Target, skips the # index, and groups Now and Estimated saving on one axis", () => {
  const groups = chartGroupsFromRows(...tableB);
  assert.equal(groups.length, 1);
  const [group] = groups;
  assert.equal(group.unit, "KB");
  assert.deepEqual(group.series.map((series) => series.header), ["Now", "Estimated saving"]);
  assert.deepEqual(group.series.map((series) => series.column), [2, 4]);
  assert.notEqual(group.series[0].slot, group.series[1].slot);
  assert.deepEqual(group.rows.map((row) => row.label), ["updateSetting()", "REST handlers", "AceTime zone_infos.cpp.o", "sscanf, 11 call sites", "WiFiManager"]);
  const limit = group.rows[3].values[1];
  assert.deepEqual([limit.kind, limit.value, limit.inclusive], ["upper", 9.6, true]);
  assert.equal(group.rows[3].values[0].kind, "point");
  assert.equal(group.rows[0].values[1].kind, "range");
  // One shared domain: the largest "Now" value (70) bounds the saving bars too.
  assert.deepEqual(chartDomain(group), { min: 0, max: 70, zero: 0 });
});

test("the label column is the first non-index column, and column 0 when every column is an index", () => {
  for (const header of ["#", "ID", "No.", "no", "Index"]) {
    const [group] = chartGroupsFromRows([header, "Name", "Size"], [["a", "x", "4 KB"], ["b", "y", "6 KB"]]);
    assert.deepEqual(group.rows.map((row) => row.label), ["x", "y"], header);
    assert.deepEqual(group.series.map((series) => series.header), ["Size"], header);
  }
  // An all-digit column is an ordinal even under an ordinary header.
  const [byValue] = chartGroupsFromRows(["Rank", "Name", "Size"], [["#1", "x", "4 KB"], ["#2", "y", "6 KB"]]);
  assert.deepEqual(byValue.rows.map((row) => row.label), ["x", "y"]);
  const [allIndex] = chartGroupsFromRows(["#", "Score"], [["1", "10"], ["2", "20"]]);
  assert.deepEqual(allIndex.rows.map((row) => row.label), ["1", "2"]);
  assert.deepEqual(allIndex.series.map((series) => series.header), ["Score"]);
  // A named column keeps its integers charted, and an id column after the label is never charted.
  const [counts] = chartGroupsFromRows(["File", "ID", "Lines"], [["a.ts", "7", "120"], ["b.ts", "8", "45"]]);
  assert.deepEqual(counts.series.map((series) => series.header), ["Lines"]);
});

test("a cell that does not parse leaves no bar for that series but keeps the row", () => {
  const [group] = chartGroupsFromRows(["Name", "A", "B"], [["x", "4 KB", "n/a"], ["y", "6 KB", "2 KB"], ["z", "8 KB", "3 KB"]]);
  assert.deepEqual(group.rows[0].values.map((value) => value?.value ?? null), [4, null]);
  assert.equal(group.skipped, 0);
});

test("HAST extraction preserves text and export escapes hostile labels and headers", () => {
  const text = (value) => ({ type: "text", value });
  const cell = (tagName, value) => ({ type: "element", tagName, children: [text(value)] });
  const tr = (tag, values) => ({ tagName: "tr", children: values.map((value) => cell(tag, value)) });
  const groups = chartGroupsFromHast({ tagName: "table", children: [{ tagName: "thead", children: [tr("th", ["구성", "<b>토큰</b> & \"co\"", "Duration"])] }, { tagName: "tbody", children: [tr("td", ["<script>alert(1)</script>", "8k tok", "4 s"]), tr("td", ["한글 & 원문", "2k tok", "6 s"])] }] });
  assert.deepEqual(groups.map((group) => group.unit), ["tokens", "s"]);
  assert.deepEqual(groups[1].rows.map((row) => row.values[0].value), [4, 6]);
  const svg = tableChartSvg(groups);
  assert.ok(svg.includes("&lt;script&gt;")); assert.ok(!svg.includes("<script>")); assert.ok(svg.includes("한글 &amp; 원문"));
  assert.ok(svg.includes("&lt;b&gt;토큰&lt;/b&gt; &amp; &quot;co&quot;")); assert.ok(!svg.includes("<b>"));
});

test("export shows every group, grouped bars and a legend naming each series", () => {
  const svg = tableChartSvg([...chartGroupsFromRows(...tableA), ...chartGroupsFromRows(...tableB)]);
  for (const header of ["Estimated saving", "`app0` after (now 93.5%)", "Now"]) assert.ok(svg.includes(`>${header}</text>`), header);
  for (const label of ["WiFiManager", "All five", "updateSetting()"]) assert.ok(svg.includes(`>${label}</text>`), label);
  for (const raw of ["about 91.5–92.7%", "68–106 KB", "13.1 KB", "≤9.6 KB"]) assert.ok(svg.includes(`>${raw}</text>`), raw);
  // Series are told apart by colour: the legend swatches of Table B's two series differ.
  for (const [slot, header] of [[0, "Now"], [1, "Estimated saving"]]) assert.match(svg, new RegExp(`fill="${SERIES_COLORS[slot]}"/><text x="[\\d.]+" y="[\\d.]+">${header}</text>`));
  assert.match(svg, /fill="url\(#interval-hatch-1\)"/);
  // One axis per group, ending at that group's own maximum and unit.
  assert.ok(svg.includes(">106 KB</text>")); assert.ok(svg.includes(">92.7 %</text>")); assert.ok(svg.includes(">70 KB</text>"));
  assert.ok(!/<script|onload|javascript:/i.test(svg));
});

test("wide same-unit tables preserve every series without repeating a legend color within a chart", () => {
  const headers = ["Target", ...Array.from({ length: 11 }, (_, i) => `Measure ${i + 1}`)];
  const rows = ["A", "B"].map((label) => [label, ...Array.from({ length: 11 }, (_, i) => `${i + 1} KB`)]);
  const groups = chartGroupsFromRows(headers, rows);
  assert.deepEqual(groups.flatMap((group) => group.series.map((series) => series.header)), headers.slice(1));
  for (const group of groups) {
    const colors = group.series.map((series) => SERIES_COLORS[series.slot]);
    assert.equal(new Set(colors).size, group.series.length, "legend colors must distinguish every series in each chart");
    assert.deepEqual(group.rows[0].values.map((value) => value.value), group.series.map((series) => series.column));
    const svg = tableChartSvg([group]);
    for (const header of group.series.map((series) => series.header)) {
      assert.ok(svg.includes(`>${header}</text>`), `export must include ${header}`);
    }
  }
});

test("ranges and limits retain all four rows from a mixed estimate table", () => {
  const raw = ["~9k", "~8–9k", "~4k", "<1k"];
  const [group] = chartGroupsFromRows(["항목", "분량"], raw.map((value, i) => [`항목 ${i}`, value]));
  const values = group.rows.map((row) => row.values[0]);
  assert.equal(group.rows.length, 4);
  assert.equal(group.skipped, 0);
  assert.deepEqual(values.map((value) => value.kind), ["point", "range", "point", "upper"]);
  assert.deepEqual(values.map((value) => value.raw), raw);
  assert.equal(values[1].value, 8000);
  assert.equal(values[1].end, 9000);
  const domain = chartDomain(group);
  const range = chartGeometry(values[1], domain);
  assert.ok(range.interval.width > 0);
  assert.equal(chartGeometry(values[3], domain).bar, null, "an upper limit is not an exact value bar");
  assert.match(tableChartSvg([group]), /&lt;1k/);
  assert.match(tableChartSvg([group]), /url\(#interval-hatch-0\)/);
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
  const [cross] = chartGroupsFromRows(["Name", "Value"], [["A", "-4–6"], ["B", "0"]]);
  assert.equal(chartGeometry(cross.rows[0].values[0], chartDomain(cross)).bar.width, 0);
  assert.equal(chartGeometry(cross.rows[0].values[0], chartDomain(cross)).interval.width, 100);
  for (const raw of ["9–8k", "8 GiB–9 MiB", "v8–9", "8–9 cats"]) assert.equal(parseChartValue(raw), null, raw);
  const [limits] = chartGroupsFromRows(["Name", "Value"], [["A", "<-4"], ["B", ">6"]]);
  assert.ok(chartDomain(limits).min < -4);
  assert.ok(chartDomain(limits).max > 6);
});
