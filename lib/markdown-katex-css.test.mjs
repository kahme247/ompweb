import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

let freshImport = 0;
const loadFresh = async () => (await import(`./markdown.ts?fresh=${freshImport++}`)).loadMathMarkdownPlugins;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function katexLink() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const link = document.querySelector("link[data-katex]");
    if (link) return link;
    await sleep(10);
  }
  throw new Error("the KaTeX stylesheet link was never appended");
}

afterEach(() => {
  document.head.replaceChildren();
});

for (const event of ["load", "error"]) {
  test(`math plugins wait for the KaTeX stylesheet to ${event} and link it once`, async () => {
    const loadMathMarkdownPlugins = await loadFresh();
    let settled = false;
    const first = loadMathMarkdownPlugins().then((plugins) => {
      settled = true;
      return plugins;
    });
    const link = await katexLink();
    assert.equal(link.getAttribute("href"), "/katex/katex.min.css");
    await sleep(20);
    assert.equal(settled, false);

    link.dispatchEvent(new window.Event(event));
    const plugins = await first;

    assert.equal(await loadMathMarkdownPlugins(), plugins);
    assert.equal(document.querySelectorAll("link[data-katex]").length, 1);
  });
}
