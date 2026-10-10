import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, before } from "node:test";
import React from "react";
import { act, cleanup, render } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tryNative: false, tsconfigPaths: true });
const { NotificationList } = await jiti.import("./NotificationList.tsx");
const { toastHistory } = await jiti.import("./ui/toast.tsx");

before(() => { window.Element.prototype.setPointerCapture = () => {}; });
afterEach(() => { cleanup(); toastHistory.clear(); });

function pointer(target, type, x, y, { pointerType = "touch", detail = 1 } = {}) {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, detail });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: pointerType } });
  act(() => { target.dispatchEvent(event); });
}
function drag(target, points, options) {
  const [first, ...rest] = points;
  pointer(target, "pointerdown", ...first, options);
  for (const point of rest) pointer(target, "pointermove", ...point, options);
  pointer(target, "pointerup", ...points.at(-1), options);
}
function mount() {
  act(() => { toastHistory.record("info", "Agent finished", "A long description", { id: "n1", clamp: true }); });
  const view = render(React.createElement(NotificationList));
  return { row: () => view.container.querySelector("li"), description: () => view.container.querySelector("[aria-expanded]") };
}
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 250)));

test("only unread rows carry the unread marker", () => {
  act(() => {
    toastHistory.record("info", "Old", undefined, { id: "old" });
    toastHistory.markAllRead();
    toastHistory.record("info", "New", undefined, { id: "new" });
  });
  const view = render(React.createElement(NotificationList));
  const markedRows = Array.from(view.container.querySelectorAll("li")).filter((li) => li.querySelector('[role="img"]'));
  assert.deepEqual(markedRows.map((li) => li.querySelector(".display-serif").textContent), ["New"]);
});

test("a sideways touch swipe from anywhere on the row slides it out, then removes it, in either direction", async () => {
  for (const points of [[[100, 50], [130, 54], [160, 58]], [[200, 50], [170, 46], [140, 44]]]) {
    const { row, description } = mount();
    drag(description(), points);
    assert.equal(row().style.opacity, "0", "the row slides out before it goes");
    await settle();
    assert.equal(toastHistory.get().length, 0);
    cleanup();
  }
});

test("short, mostly vertical, curved-into-vertical, mouse, and button-started drags keep the row", async () => {
  const { row, description } = mount();
  drag(description(), [[100, 50], [115, 51], [130, 52]]);
  drag(description(), [[100, 50], [120, 85], [150, 120]]);
  // Claimed sideways, then the thumb carries on mostly downward.
  drag(description(), [[100, 50], [125, 52], [150, 120]]);
  // Swiped out, then pulled back toward the start before letting go.
  drag(description(), [[100, 50], [180, 52], [140, 52]]);
  drag(description(), [[200, 50], [80, 52], [140, 52]]);
  drag(description(), [[100, 50], [150, 51], [200, 52]], { pointerType: "mouse" });
  drag(row().querySelector("button"), [[100, 50], [150, 51], [200, 52]]);
  await settle();
  assert.equal(toastHistory.get().length, 1);
  assert.equal(row().style.transform, "");
});

test("a swipe that turns back and then out again still dismisses", async () => {
  const { description } = mount();
  drag(description(), [[100, 50], [180, 52], [140, 52], [190, 54]]);
  await settle();
  assert.equal(toastHistory.get().length, 0);
});

test("the click ending a drag is swallowed; taps and keyboard clicks still reach the row", () => {
  const { description } = mount();
  pointer(description(), "pointerdown", 100, 50, { pointerType: "mouse" });
  pointer(description(), "click", 160, 50, { pointerType: "mouse" });
  assert.equal(description().getAttribute("aria-expanded"), "false");
  pointer(description(), "pointerdown", 100, 50);
  pointer(description(), "click", 103, 51);
  assert.equal(description().getAttribute("aria-expanded"), "true");
  // A keyboard click reports no position; an earlier press must not make it look like a drag.
  pointer(description(), "pointerdown", 100, 50);
  pointer(description(), "click", 0, 0, { detail: 0 });
  assert.equal(description().getAttribute("aria-expanded"), "false");
  // A drag out and back to where it started is still a drag, not a tap.
  pointer(description(), "pointerdown", 100, 50);
  pointer(description(), "pointermove", 160, 50);
  pointer(description(), "click", 101, 50);
  assert.equal(description().getAttribute("aria-expanded"), "false");
});
