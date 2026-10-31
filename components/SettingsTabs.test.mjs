import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { SettingsTabs, SETTINGS_CATEGORIES } = await import("./SettingsTabs.tsx");

test("horizontal settings tabs expose every category description", () => {
  const html = renderToStaticMarkup(React.createElement(SettingsTabs, {
    active: "general",
    onSelect: () => {},
    layout: "horizontal",
  }));

  for (const category of SETTINGS_CATEGORIES) {
    assert.ok(html.includes(`>${category.description}<`), `description is not visibly rendered for ${category.id}`);
  }
});

test("settings tabs render attention indicator when tab needs attention", () => {
  const verticalHtml = renderToStaticMarkup(React.createElement(SettingsTabs, {
    active: "general",
    onSelect: () => {},
    layout: "vertical",
    attentionTabs: { system: "Update available" },
  }));

  const verticalButtonMatch = verticalHtml.match(/<button[^>]+id="settings-tab-system"[^>]*>/);
  assert.ok(verticalButtonMatch, "system tab button should be rendered in vertical layout");
  assert.match(verticalButtonMatch[0], /aria-label="[^"]*\(Update available\)[^"]*"/, "vertical tab button aria-label should include attention label");
  assert.match(verticalButtonMatch[0], /title="[^"]*\(Update available\)[^"]*"/, "vertical tab title should include attention label");

  const horizontalHtml = renderToStaticMarkup(React.createElement(SettingsTabs, {
    active: "general",
    onSelect: () => {},
    layout: "horizontal",
    attentionTabs: { system: "Update available" },
  }));

  const horizontalButtonMatch = horizontalHtml.match(/<button[^>]+id="settings-tab-system"[^>]*>/);
  assert.ok(horizontalButtonMatch, "system tab button should be rendered in horizontal layout");
  assert.match(horizontalButtonMatch[0], /aria-label="[^"]*\(Update available\)[^"]*"/, "horizontal tab button aria-label should include attention label");
  assert.match(horizontalButtonMatch[0], /title="[^"]*\(Update available\)[^"]*"/, "horizontal tab title should include attention label");
  const noAttentionHtml = renderToStaticMarkup(React.createElement(SettingsTabs, {
    active: "general",
    onSelect: () => {},
    layout: "vertical",
  }));
  assert.ok(!noAttentionHtml.includes('(Update available)'), "no attention indicator when attentionTabs is omitted");
});
