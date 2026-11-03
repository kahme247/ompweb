import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
const { cleanup, fireEvent, render } = await import("@testing-library/react/pure.js");

const { MarkdownBody } = await import("./MarkdownBody.tsx");

afterEach(cleanup);

function renderChat(markdown, opened = []) {
  return render(React.createElement(MarkdownBody, { cwd: "/home/me/project", onOpenFile: (file) => opened.push(file) }, markdown));
}

test("an inline-code path opens the cleaned path in the file panel", () => {
  const opened = [];
  const { container } = renderChat(
    "Shot: `/var/tmp/omp-sshots-1.webp`, see `src/app.ts:12`, `~/notes/a.md`, `C:\\Users\\me\\b.txt:3:4`.",
    opened,
  );
  const links = [...container.querySelectorAll("a")];

  assert.deepEqual(links.map((a) => a.textContent), ["/var/tmp/omp-sshots-1.webp", "src/app.ts:12", "~/notes/a.md", "C:\\Users\\me\\b.txt:3:4"]);
  assert.ok(links.every((a) => a.firstElementChild?.tagName === "CODE" && !a.hasAttribute("target")));
  for (const link of links) assert.equal(fireEvent.click(link, { button: 0 }), false, "click default must be prevented");
  assert.deepEqual(opened, ["/var/tmp/omp-sshots-1.webp", "/home/me/project/src/app.ts", "~/notes/a.md", "C:/Users/me/b.txt"]);
});

test("ordinary code, scheme handles, fenced blocks and escaping paths stay unlinked", () => {
  const opened = [];
  const { container } = renderChat(
    [
      "`foo.bar()` `foo.bar` `a/b` `x => y` `/compact` `rm -rf /tmp/x` `../outside.ts` `/api/files/a.ts`",
      "`history://abc` `proc://1` `local://plan.md` `https://x.test/a.png` `file:///tmp/a.png`",
      "```\n/var/tmp/a.png\n```",
    ].join("\n\n"),
    opened,
  );

  assert.equal(container.querySelector("a"), null);
  assert.deepEqual(opened, []);
});

test("inline-code paths stay code outside a file-opening view and inside existing links", () => {
  const plain = render(React.createElement(MarkdownBody, null, "`/var/tmp/a.png`"));
  assert.equal(plain.container.querySelector("a"), null);
  cleanup();

  const { container } = renderChat("[`/var/tmp/a.png`](https://x.test)");
  const links = container.querySelectorAll("a");
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute("href"), "https://x.test");
});

test("an Attached files line opens its upload, POSIX or Windows, whatever the name holds", () => {
  const opened = [];
  const { container } = renderChat(
    [
      "Attached files (this session's local:// directory):",
      "- [`local://uploads/a (1) #2 &amp; 50%.txt`](/home/u/s/local/uploads/a%20%281%29%20%232%20%26amp;%2050%25.txt) (/home/u/s/local/uploads/a (1) #2 &amp; 50%.txt, 10 B, text/plain)",
      "- [`local://uploads/[z] b.bin`](d:%5CUsers%5Cme%5C.omp%5Cs%5Clocal%5Cuploads%5C%5Bz%5D%20b.bin) (d:\\Users\\me\\.omp\\s\\local\\uploads\\[z] b.bin, 1 B, application/octet-stream)",
    ].join("\n"),
    opened,
  );
  const links = [...container.querySelectorAll("a")];
  assert.deepEqual(links.map((a) => a.textContent), ["local://uploads/a (1) #2 &amp; 50%.txt", "local://uploads/[z] b.bin"]);
  for (const link of links) assert.equal(fireEvent.click(link, { button: 0 }), false, "click default must be prevented");
  assert.deepEqual(opened, ["/home/u/s/local/uploads/a (1) #2 &amp; 50%.txt", "d:/Users/me/.omp/s/local/uploads/[z] b.bin"]);
});
