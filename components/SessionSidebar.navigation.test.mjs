import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The navigate back/forward buttons live in the sidebar header, first in the
// quiet-utilities group (before Archived Sessions) and disabled per the
// history stack's bounds. AppShell always passes the `navigation` prop; the
// undefined case only covers any future host that renders the sidebar
// standalone.

const { SessionSidebar } = await import("./SessionSidebar.tsx");

const noop = () => {};
const baseProps = {
  selectedSessionId: null,
  onSelectSession: noop,
  addProjectOpen: false,
  setAddProjectOpen: noop,
  onOpenArchive: noop,
};

const navigation = (canBack, canForward) => ({
  canBack,
  canForward,
  onBack: noop,
  onForward: noop,
  backShortcut: "⌘[",
  forwardShortcut: "⌘]",
});

/** The full opening tag of the button carrying this aria-label. */
function buttonTagFor(html, label) {
  const match = html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`));
  assert.ok(match, `button with label ${label} renders`);
  return match[0];
}

test("renders back/forward buttons before Archived Sessions, disabled per stack bounds", () => {
  const html = renderToStaticMarkup(React.createElement(SessionSidebar, {
    ...baseProps,
    navigation: navigation(false, true),
  }));

  const back = html.indexOf('aria-label="Navigate back"');
  const forward = html.indexOf('aria-label="Navigate forward"');
  const archive = html.indexOf('aria-label="Archived Sessions"');
  assert.ok(back > 0, "navigate-back button renders");
  assert.ok(forward > 0, "navigate-forward button renders");
  assert.ok(back < archive && forward < archive, "navigation buttons sit before Archived Sessions");
  // Both buttons live inside the .sidebar-nav-buttons wrapper that the
  // .sidebar-shell container query hides on narrow sidebars.
  const wrapper = html.indexOf('class="sidebar-nav-buttons"');
  assert.ok(wrapper > 0, "nav buttons render inside their collapsible wrapper");
  assert.ok(wrapper < back && wrapper < forward, "wrapper opens before both buttons");

  // canBack=false disables back; canForward=true keeps forward enabled.
  assert.match(buttonTagFor(html, "Navigate back"), /disabled/);
  assert.doesNotMatch(buttonTagFor(html, "Navigate forward"), /disabled/);
});

test("both buttons enable when the stack allows travel in both directions", () => {
  const html = renderToStaticMarkup(React.createElement(SessionSidebar, {
    ...baseProps,
    navigation: navigation(true, true),
  }));
  assert.doesNotMatch(buttonTagFor(html, "Navigate back"), /disabled/);
  assert.doesNotMatch(buttonTagFor(html, "Navigate forward"), /disabled/);
});

test("no navigation buttons without the navigation prop", () => {
  const html = renderToStaticMarkup(React.createElement(SessionSidebar, baseProps));
  assert.equal(html.indexOf('aria-label="Navigate back"'), -1);
  assert.equal(html.indexOf('aria-label="Navigate forward"'), -1);
});
