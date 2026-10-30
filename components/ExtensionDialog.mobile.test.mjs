import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React from "react";
import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
const { act, cleanup, fireEvent, render, screen } = await import("@testing-library/react/pure.js");

const { ExtensionDialog, shouldDeferAttachedFocus } = await import("./ExtensionDialog.tsx");
const { MOBILE_QUERY } = await import("@/hooks/useIsMobile");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

const OPTIONS = [
  { label: "Red" },
  { label: "Green", preview: "green:\n  hue: 120\n  token: veryLongPreviewTokenWithoutAnyBreakOpportunity" },
];

function askRequest(questions = [{ id: "color", header: "Color", question: "Pick a color", options: OPTIONS, recommended: 1 }]) {
  return { type: "extension_ui_request", id: "ask-1", method: "ask", questions };
}

/** Renders the composer-attached panel — the mobile path these fixes cover. */
function renderAttached(request = askRequest(), attached = true) {
  const responses = [];
  const view = render(React.createElement(ExtensionDialog, {
    request,
    onRespond: (_request, response) => responses.push(response),
    attached,
  }));
  return { responses, view };
}

function staticMarkup(request = askRequest(), props = {}) {
  return renderToStaticMarkup(React.createElement(ExtensionDialog, {
    request,
    onRespond: () => {},
    attached: true,
    ...props,
  }));
}

/** Stubs the media queries the panel reads, the way the ChatInput tests do. */
function stubMedia({ coarse = false, fine = false, narrow = false } = {}) {
  const original = window.matchMedia;
  window.matchMedia = (query) => ({
    matches: query === "(pointer: coarse)"
      ? coarse
      : query === "(pointer: fine)"
        ? fine
        : query === MOBILE_QUERY
          ? narrow
          : false,
    addEventListener() {},
    removeEventListener() {},
  });
  return () => {
    if (original) window.matchMedia = original;
    else delete window.matchMedia;
  };
}

/** Stubs the visual viewport: a `height` below the window height means the
 * on-screen keyboard covers part of the visible area. `undefined` removes the
 * API entirely, which is what SSR and jsdom see. */
function stubVisualViewport(height) {
  const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
  if (height !== undefined) {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        height,
        addEventListener() {},
        removeEventListener() {},
      },
    });
  } else {
    delete window.visualViewport;
  }
  return () => {
    if (original) Object.defineProperty(window, "visualViewport", original);
    else delete window.visualViewport;
  };
}

let restoreMedia = () => {};
let restoreViewport = () => {};

beforeEach(() => {
  // jsdom has no matchMedia and no visualViewport: the default is the
  // desktop-without-a-keyboard case (except `fine`, which jsdom also cannot
  // answer, so tests that care about it stub it explicitly).
  restoreMedia = stubMedia({ fine: true });
  restoreViewport = stubVisualViewport(undefined);
});

afterEach(() => {
  cleanup();
  restoreMedia();
  restoreViewport();
});

// ---- #234: horizontal overflow ------------------------------------------------

test("both ask grids pin their column so a wide question cannot stretch the panel", () => {
  const html = staticMarkup();
  // An implicit `grid-template-columns: none` sizes its track by max-content,
  // so one long unwrapped question makes the panel wider than the composer
  // column and the phone clips the option rows at the right edge (#234).
  const grids = html.match(/grid-template-columns:minmax\(0, 1fr\)/g) ?? [];
  assert.equal(grids.length, 2, "the questions grid and each question's fieldset");
  assert.equal((html.match(/<fieldset [^>]*min-width:0/g) ?? []).length, 1);
  assert.match(html, /<div style="padding:14px">/);
});

test("the option row, its text and its preview cannot push past the panel edge", () => {
  const html = staticMarkup();
  // The label is a flex row inside the fieldset's grid: it needs a zero
  // minimum and wrapping text of its own, otherwise a long option label or
  // preview keeps the track at min-content and overflows.
  assert.match(html, /<label style="[^"]*display:flex[^"]*min-width:0[^"]*"/);
  assert.match(html, /<span style="min-width:0;overflow-wrap:anywhere">Red/);
  // A preview used to be `white-space: pre` + `overflow-x: auto`, which turns
  // every option row into its own horizontal scroller.
  assert.match(html, /font-family:var\(--font-mono\)[^"]*white-space:pre-wrap;overflow-wrap:anywhere">green:/);
  assert.doesNotMatch(html, /overflow-x:auto/);
});

test("the panel, its scroller and the Other textarea can shrink inside the column", () => {
  const html = staticMarkup();
  assert.match(html, /role="dialog"[^>]*style="[^"]*box-sizing:border-box;min-width:0/);
  assert.match(html, /class="extension-dialog-content" style="[^"]*min-width:0/);
  assert.match(html, /<textarea [^>]*style="flex:1;min-width:0/);
});

// ---- #235: composer-attached focus --------------------------------------------

test("touch input and phone widths defer focus; a physical desktop keeps it", () => {
  const cases = [
    [{ coarse: true }, true, "phone"],
    [{ coarse: true, narrow: true }, true, "phone with a fine-pointer report"],
    [{ narrow: true }, true, "phone whose pointer queries never match"],
    [{ fine: true, narrow: true }, true, "narrow window: same width as a phone"],
    [{ fine: true }, false, "desktop"],
    [{}, true, "a browser that answers neither query does not claim a keyboard"],
  ];
  for (const [media, expected, label] of cases) {
    const restore = stubMedia(media);
    try {
      assert.equal(shouldDeferAttachedFocus(), expected, label);
    } finally {
      restore();
    }
  }
});

test("a page without matchMedia at all keeps the keyboard focus path", () => {
  const original = window.matchMedia;
  delete window.matchMedia;
  try {
    assert.equal(shouldDeferAttachedFocus(), false);
  } finally {
    if (original) window.matchMedia = original;
  }
});

test("a composer-attached request on a touch device does not open the keyboard", async () => {
  const restore = stubMedia({ coarse: true });
  try {
    renderAttached();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const other = screen.getByRole("group", { name: /Pick a color/ }).querySelector("textarea");
    assert.notEqual(document.activeElement, other);
  } finally {
    restore();
  }
});

// ---- #236: the submit affordance ----------------------------------------------

test("an open keyboard caps the panel to the visible area", () => {
  const viewportHeight = Math.round(window.innerHeight * 0.5);
  const restore = stubVisualViewport(viewportHeight);
  try {
    renderAttached();
    const panel = screen.getByRole("dialog");
    assert.equal(panel.style.maxHeight, "min(420px, 60dvh)", "no keyboard: the CSS cap stands");

    fireEvent.focus(screen.getByRole("group", { name: /Pick a color/ }).querySelector("textarea"));
    assert.equal(panel.style.maxHeight, `${viewportHeight - 12}px`, "the footer must stay inside the visible area");
  } finally {
    restore();
  }
});

/** Resizes the stubbed viewport like a browser does; `layout` also shrinks
 * `innerHeight`, as `interactive-widget: resizes-content` (Android Chrome)
 * and a desktop window or docked dev tools do. */
function stubResizableViewport() {
  const saved = ["innerHeight", "innerWidth"].map((key) => [key, Object.getOwnPropertyDescriptor(window, key)]);
  const restoreViewport = stubVisualViewport(window.innerHeight);
  const set = (key, value) => Object.defineProperty(window, key, { configurable: true, value });
  return {
    full: window.innerHeight,
    resize(height, { layout = true, width } = {}) {
      if (width !== undefined) set("innerWidth", width);
      window.visualViewport.height = height;
      if (layout) set("innerHeight", height);
      act(() => { window.dispatchEvent(new window.Event("resize")); });
    },
    restore() {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(window, key, descriptor);
        else delete window[key];
      }
      restoreViewport();
    },
  };
}

async function focusOther() {
  renderAttached();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const other = screen.getByRole("group", { name: /Pick a color/ }).querySelector("textarea");
  act(() => other.focus());
  return other;
}

for (const [mode, layout] of [["resizes-content", true], ["overlay", false]]) {
  test(`collapsing the keyboard while typing in Other lets the text box go (${mode})`, async () => {
    const restoreMedia = stubMedia({ coarse: true });
    const viewport = stubResizableViewport();
    try {
      const other = await focusOther();
      viewport.resize(Math.round(viewport.full * 0.5), { layout });
      assert.ok(document.activeElement === other, "opening the keyboard keeps the text box");
      // Back button / swipe: focus would stay put, and the next tap (Submit)
      // would raise the keyboard again for a moment.
      viewport.resize(viewport.full, { layout });
      assert.ok(document.activeElement !== other, "a collapsed keyboard must not keep the text box focused");
    } finally {
      viewport.restore();
      restoreMedia();
    }
  });
}

test("rotating with the keyboard up is no collapse, and the later collapse still lets the text box go", async () => {
  const restoreMedia = stubMedia({ coarse: true });
  const viewport = stubResizableViewport();
  try {
    const other = await focusOther();
    viewport.resize(Math.round(viewport.full * 0.5));
    // Landscape, keyboard still up: a new width, a shorter visible area.
    viewport.resize(Math.round(viewport.full * 0.3), { width: window.innerWidth + 300 });
    assert.ok(document.activeElement === other, "rotation must not take the text box away");
    // Back button in landscape: the visible area grows by the keyboard.
    viewport.resize(Math.round(viewport.full * 0.6));
    assert.ok(document.activeElement !== other, "the collapse after a rotation must still let the text box go");
  } finally {
    viewport.restore();
    restoreMedia();
  }
});

test("on a desktop, shrinking and regrowing the window keeps the text box", async () => {
  // Docked dev tools opening and closing, or a window resized vertically.
  const viewport = stubResizableViewport();
  try {
    const other = await focusOther();
    fireEvent.pointerDown(other, { pointerType: "mouse" });
    viewport.resize(Math.round(viewport.full * 0.5));
    viewport.resize(viewport.full);
    assert.ok(document.activeElement === other, "no soft keyboard was involved");
  } finally {
    viewport.restore();
  }
});

test("on a touchscreen laptop, a tap's keyboard is tracked though the mouse is the primary pointer", async () => {
  const viewport = stubResizableViewport();
  try {
    renderAttached();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const other = screen.getByRole("group", { name: /Pick a color/ }).querySelector("textarea");
    fireEvent.pointerDown(other, { pointerType: "touch" });
    act(() => other.focus());
    viewport.resize(Math.round(viewport.full * 0.5));
    assert.equal(screen.getByRole("dialog").style.maxHeight, `${Math.round(viewport.full * 0.5) - 12}px`, "the footer stays above the keyboard");
    viewport.resize(viewport.full);
    assert.ok(document.activeElement !== other, "a collapsed keyboard must not keep the text box focused");
  } finally {
    viewport.restore();
  }
});

test("the keyboard cap applies to every attached method with a text field", () => {
  const viewportHeight = Math.round(window.innerHeight * 0.5);
  const restore = stubVisualViewport(viewportHeight);
  const restoreMedia = stubMedia({ coarse: true });
  try {
    renderAttached({ type: "extension_ui_request", id: "input-1", method: "input", title: "Name?" });
    fireEvent.focus(screen.getByRole("textbox", { name: "Name?" }));
    assert.equal(screen.getByRole("dialog").style.maxHeight, `${viewportHeight - 12}px`);
  } finally {
    restoreMedia();
    restore();
  }
});

test("on touch, focusing an option or button keeps the panel's height", () => {
  const restoreMedia = stubMedia({ coarse: true });
  try {
    const { view } = renderAttached();
    const panel = screen.getByRole("dialog");
    // No keyboard comes up for them, and a resize under the finger made the
    // tap that focused them miss.
    for (const control of [screen.getByRole("radio", { name: "Red" }), screen.getByRole("button", { name: "Submit" })]) {
      fireEvent.focus(control);
      assert.equal(panel.style.maxHeight, "min(420px, 60dvh)");
    }
    view.rerender(React.createElement(ExtensionDialog, {
      request: { type: "extension_ui_request", id: "select-1", method: "select", title: "Which?", options: ["First", "Second"] },
      onRespond: () => {},
      attached: true,
    }));
    fireEvent.focus(screen.getByRole("button", { name: "First" }));
    assert.equal(screen.getByRole("dialog").style.maxHeight, "min(420px, 60dvh)");
  } finally {
    restoreMedia();
  }
});

test("without a visible-area API the panel keeps its CSS cap", () => {
  const { responses } = renderAttached();
  const panel = screen.getByRole("dialog");
  assert.equal(panel.style.maxHeight, "min(420px, 60dvh)");
  const other = screen.getByRole("group", { name: /Pick a color/ }).querySelector("textarea");
  fireEvent.focus(other);
  fireEvent.change(other, { target: { value: "Teal" } });
  assert.equal(panel.style.maxHeight, "min(420px, 60dvh)");
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses, [{ answers: [{ id: "color", selectedOptions: [], customInput: "Teal" }] }]);
});

/** A press as the browser sends it: pointerdown, then the compat mousedown.
 * Returns whether mousedown's default (moving focus) still runs. */
function press(target, pointerType) {
  fireEvent.pointerDown(target, { pointerType });
  return fireEvent.mouseDown(target);
}

test("on touch, while Other is being typed, a press elsewhere in the panel keeps focus there", async () => {
  // A phone: the panel leaves focus alone until tapped (#235).
  const restore = stubMedia({ coarse: true });
  const composer = document.body.appendChild(document.createElement("textarea"));
  try {
    renderAttached();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const other = screen.getByRole("group", { name: /Pick a color/ }).querySelector("textarea");
    const red = screen.getByRole("radio", { name: "Red" });
    const targets = [red, red.closest("label"), screen.getByRole("button", { name: "Cancel" }), screen.getByRole("button", { name: "Submit" })];
    // No text box of the panel focused: no keyboard of ours to protect.
    for (const target of targets) assert.equal(press(target, "touch"), true);
    act(() => composer.focus());
    for (const target of targets) assert.equal(press(target, "touch"), true, "a field outside the panel is not ours to keep");
    act(() => red.focus());
    assert.equal(press(screen.getByRole("button", { name: "Submit" }), "touch"), true, "a focused radio raises no keyboard");

    act(() => other.focus());
    // A focus change on press closes the phone keyboard and resizes the panel
    // before the click, so the click misses the option or button it aimed at.
    for (const pointerType of ["touch", "pen"]) {
      for (const target of targets) assert.equal(press(target, pointerType), false, `${target.textContent} must not take focus (${pointerType})`);
    }
    assert.equal(press(other, "touch"), true, "the text box itself still takes the press");
  } finally {
    composer.remove();
    restore();
  }
});

test("a mouse press in the panel moves focus as usual, even on a touch-first device", () => {
  // The pointer media query describes the primary pointer only; a hybrid
  // device's mouse must keep text selection and radio arrow keys.
  const restore = stubMedia({ coarse: true });
  try {
    renderAttached();
    act(() => screen.getByRole("group", { name: /Pick a color/ }).querySelector("textarea").focus());
    assert.equal(press(screen.getByText("Red"), "mouse"), true);
  } finally {
    restore();
  }
});

test("choosing an option takes focus from Other, so later typing cannot pick Other", () => {
  renderAttached();
  const other = screen.getByRole("group", { name: /Pick a color/ }).querySelector("textarea");
  const red = screen.getByRole("radio", { name: "Red" });
  act(() => other.focus());
  // A touch press on the radio itself keeps focus in Other; the change must move it.
  assert.equal(press(red, "touch"), false);
  fireEvent.click(red);
  // Compare identities: a failing element diff walks the whole jsdom graph.
  assert.ok(document.activeElement === red, "the chosen radio has focus");
});

test("answering releases the Other text box at once, so the keyboard does not wait for the server", () => {
  const { responses } = renderAttached();
  const other = screen.getByRole("group", { name: /Pick a color/ }).querySelector("textarea");
  act(() => other.focus());
  fireEvent.change(other, { target: { value: "Teal" } });
  // The panel stays mounted until omp acknowledges the answer (plus a hand-off delay).
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  assert.equal(responses.length, 1);
  assert.ok(document.activeElement !== other, "the Other text box must not keep focus");
});

test("tapping back into kept Other text chooses it even when focus never left", () => {
  renderAttached();
  const other = screen.getByRole("group", { name: /Pick a color/ }).querySelector("textarea");
  fireEvent.change(other, { target: { value: "Teal" } });
  fireEvent.click(screen.getByRole("radio", { name: "Red" }));
  assert.equal(screen.getByRole("radio", { name: /Other/ }).checked, false);
  // A tap that finds focus already in the box fires no focus event.
  fireEvent.click(other);
  assert.equal(screen.getByRole("radio", { name: /Other/ }).checked, true);
  assert.equal(screen.getByRole("radio", { name: "Red" }).checked, false);
});

// ---- touch targets (globals.css) ----------------------------------------------

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

test("the dialog footer scales with the touch-target preference", () => {
  assert.match(ruleBody('html[data-touch-targets="accessible"] .extension-dialog-footer > button'), /min-height:\s*44px/);
  assert.match(
    css,
    /@media \(max-width: 640px\) and \(pointer: coarse\) and \(hover: none\) \{\s*html:not\(\[data-touch-targets="compact"\]\):not\(\[data-touch-targets="accessible"\]\) \.extension-dialog-footer > button \{\s*min-height: 40px;/,
  );
});
