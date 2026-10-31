import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";


const { UsageConfig } = await import("./UsageConfig.tsx");

test("UsageConfig renders static markup without crashing", () => {
  const html = renderToStaticMarkup(React.createElement(UsageConfig));
  assert.ok(html.length > 0);
  // Initial state renders the loading indicator
  assert.ok(html.includes("Loading usage analytics") || html.includes("Usage"));
});
