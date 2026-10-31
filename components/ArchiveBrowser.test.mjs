import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";


const {
  formatArchiveSize,
  formatArchiveRelativeTime,
  MetadataRow,
} = await import("./ArchiveBrowser.tsx");

test("formatArchiveSize formats bytes correctly", () => {
  assert.equal(formatArchiveSize(0), "0 B");
  assert.equal(formatArchiveSize(512), "512 B");
  assert.equal(formatArchiveSize(1024), "1.0 KB");
  assert.equal(formatArchiveSize(2048), "2.0 KB");
  assert.equal(formatArchiveSize(1024 * 1024), "1.0 MB");
  assert.equal(formatArchiveSize(5.5 * 1024 * 1024), "5.5 MB");
});

test("formatArchiveRelativeTime formats past times accurately", () => {
  const now = 1_700_000_000_000;
  const isoNow = new Date(now).toISOString();
  const iso5MinAgo = new Date(now - 5 * 60_000).toISOString();
  const iso2HoursAgo = new Date(now - 2 * 3600_000).toISOString();
  const iso3DaysAgo = new Date(now - 3 * 86400_000).toISOString();

  assert.equal(formatArchiveRelativeTime(isoNow, now), "now");
  assert.equal(formatArchiveRelativeTime(iso5MinAgo, now), "5m");
  assert.equal(formatArchiveRelativeTime(iso2HoursAgo, now), "2h");
  assert.equal(formatArchiveRelativeTime(iso3DaysAgo, now), "3d");
});

test("MetadataRow renders label and value", () => {
  function DummyIcon() {
    return React.createElement("span", { "data-testid": "dummy-icon" }, "icon");
  }

  const html = renderToStaticMarkup(
    React.createElement(MetadataRow, {
      icon: DummyIcon,
      label: "Directory",
      value: "/workspace/my-project",
      mono: true,
    }),
  );

  assert.match(html, /Directory/);
  assert.match(html, /\/workspace\/my-project/);
  assert.match(html, /data-testid="dummy-icon"/);
});
