import assert from "node:assert/strict";
import test from "node:test";
import { sessionHref, sessionLinkHref } from "./session-links.ts";

const origin = "https://omp.test";

test("session hrefs encode the whole identity as one query value", () => {
  assert.equal(sessionHref("host:session/a?b#c &d"), "/?session=host%3Asession%2Fa%3Fb%23c%20%26d");
});

test("recognizes root and query session links while retaining sidebar state and fragments", () => {
  for (const [href, expected] of [
    ["/?session=one&left=0&right=1#message-3", "/?session=one&left=0&right=1#message-3"],
    ["?right=0&session=remote%3Atwo#entry", "/?right=0&session=remote%3Atwo#entry"],
    ["https://omp.test/?session=three&left=1#latest", "/?session=three&left=1#latest"],
  ]) {
    assert.equal(sessionLinkHref(href, origin), expected);
  }
  assert.equal(sessionLinkHref("/?session=one"), "/?session=one", "relative links work without a browser origin");
  assert.equal(sessionLinkHref("https://omp.test/?session=one"), null, "absolute links require a known own origin");
});

test("leaves empty, unrelated, filesystem and foreign-origin links unrecognized", () => {
  for (const href of [
    undefined, "", "/", "/?session=", "?session", "/?other=one", "#session=one",
    "/notes.md?session=one", "./?session=one", "src/file.ts", "/home/me/file.ts",
    "agent://Scout", "javascript:alert(1)", "not a URL",
    "https://else.test/?session=one", "https://omp.test.evil.test/?session=one",
    "http://omp.test/?session=one", "https://omp.test:8443/?session=one", "//else.test/?session=one",
  ]) {
    assert.equal(sessionLinkHref(href, origin), null, String(href));
  }
});
