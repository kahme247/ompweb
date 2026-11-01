import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
const { act, cleanup, render } = await import("@testing-library/react/pure.js");

const { OmpRuntimeVersion } = await import("./ChatWindow.tsx");
afterEach(cleanup);

test("version survives refresh errors but confirmed unavailability invalidates it", async (t) => {
  const pending = [];
  t.mock.method(globalThis, "fetch", () => new Promise((resolve, reject) => {
    pending.push({ resolve, reject });
  }));
  const mount = () => render(React.createElement(OmpRuntimeVersion));
  const respond = async (version, status = 200) => {
    await act(async () => {
      pending.shift().resolve(new Response(JSON.stringify({ version }), { status }));
    });
  };

  let view = mount();
  assert.equal(view.container.textContent, "omp Loading…");
  await respond(null, 500);
  assert.equal(view.container.textContent, "omp not found");
  view.unmount();

  view = mount();
  await respond("omp/18.1.21");
  assert.equal(view.container.textContent, "omp v18.1.21");
  view.unmount();

  view = mount();
  assert.equal(view.container.textContent, "omp v18.1.21");
  await respond(null, 500);
  assert.equal(view.container.textContent, "omp v18.1.21");
  view.unmount();

  view = mount();
  await act(async () => pending.shift().reject(new Error("offline")));
  assert.equal(view.container.textContent, "omp v18.1.21");
  view.unmount();

  view = mount();
  await respond(null);
  assert.equal(view.container.textContent, "omp not found");
  view.unmount();

  view = mount();
  assert.equal(view.container.textContent, "omp Loading…");
  await respond("omp/18.1.22");
  assert.equal(view.container.textContent, "omp v18.1.22");
});
