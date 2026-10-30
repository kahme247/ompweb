import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
