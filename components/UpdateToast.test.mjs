import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { toast } from "./ui/toast";
import { UpdateToastBody } from "./UpdateToast";

const RELEASES = "https://github.com/kahme247/ompweb/releases/latest";

test("an update toast links the release page instead of showing it as a command", () => {
  const html = renderToStaticMarkup(createElement(UpdateToastBody, { currentVersion: "0.6.0", availableVersion: "0.7.0", target: RELEASES, link: true }));
  assert.match(html, new RegExp(`<a href="${RELEASES}" target="_blank" rel="noopener noreferrer"[^>]*>${RELEASES}</a>`));
  assert.doesNotMatch(html, /<code|<button/);
});

test("an update toast shows a command with Copy, and the action when given", () => {
  const html = renderToStaticMarkup(createElement(UpdateToastBody, {
    currentVersion: "0.6.0",
    availableVersion: "0.7.0",
    target: "npm install -g @kahme247/ompweb",
    link: false,
    action: { label: "Update and restart", onClick: () => {} },
  }));
  assert.match(html, /v0\.6\.0 → v0\.7\.0/);
  assert.match(html, /<code[^>]*>npm install -g @kahme247\/ompweb<\/code>/);
  assert.deepEqual([...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]), ["Copy", "Update and restart"]);
});

test("Copy puts the command on the clipboard and says so", async (t) => {
  const copied = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { copied.push(text); } } });
  t.after(() => delete navigator.clipboard);
  const success = t.mock.method(toast, "success", () => {});
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(() => {
    act(() => root.unmount());
    container.remove();
  });
  await act(async () => {
    root.render(createElement(UpdateToastBody, { currentVersion: "0.6.0", availableVersion: "0.7.0", target: "omp update", link: false }));
  });
  await act(async () => {
    container.querySelector("button").click();
  });
  assert.deepEqual(copied, ["omp update"]);
  assert.deepEqual(success.mock.calls.map((call) => call.arguments), [["Command copied to clipboard"]]);
});
