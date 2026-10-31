import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { MarkdownBody } = await import("./MarkdownBody.tsx");
const { normalizeDisplayMath, loadMathMarkdownPlugins } = await import("../lib/markdown.ts");
const { GithubRepoContext } = await import("../lib/github-refs.ts");

function renderMarkdown(markdown) {
  return renderToStaticMarkup(
    React.createElement(MarkdownBody, {
      cwd: "/home/me/project",
      onOpenFile() {},
    }, markdown),
  );
}

test("opens non-file markdown links in a safe new tab", () => {
  const html = renderMarkdown("[docs](https://example.com/docs)");

  assert.match(
    html,
    /<a (?=[^>]*href="https:\/\/example\.com\/docs")(?=[^>]*target="_blank")(?=[^>]*rel="noopener noreferrer")[^>]*>docs<\/a>/,
  );
  assert.doesNotMatch(html, /\snode=/);
});

test("keeps local file markdown links in the app", () => {
  const html = renderMarkdown("[file](components/MarkdownBody.tsx)");

  assert.match(html, /<a href="components\/MarkdownBody\.tsx">file<\/a>/);
  assert.doesNotMatch(html, /target=|rel=|\snode=/);
});

test("renders math as plain text until the lazy KaTeX pipeline loads", () => {
  const html = renderMarkdown(String.raw`射线为 \(r_c = K^{-1}p\)。`);

  assert.doesNotMatch(html, /class="katex"/);
  assert.match(html, /r_c/);
});

test("renders LaTeX parenthesis delimiters as inline math", async () => {
  await loadMathMarkdownPlugins();
  const html = renderMarkdown(String.raw`射线为 \(r_c = K^{-1}p\)。`);

  assert.match(html, /class="katex"/);
  assert.match(html, /r_c/);
});

test("renders paired LaTeX bracket delimiters as display math", async () => {
  await loadMathMarkdownPlugins();
  const html = renderMarkdown(String.raw`\[
P(\lambda)=o_b+\lambda r_b
\]`);
  const oneLineHtml = renderMarkdown(String.raw`\[P(\lambda)=o_b+\lambda r_b\]`);

  assert.match(html, /class="katex-display"/);
  assert.match(html, /lambda/);
  assert.match(oneLineHtml, /class="katex-display"/);
});

test("leaves an unmatched LaTeX bracket delimiter unchanged", () => {
  const markdown = String.raw`before
\[
x + y
after`;

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize LaTeX delimiters inside Markdown code", () => {
  const markdown = "    \\(indented\\)\n\n`code\n\\(inline\\)`\n\n```text\n\\[\nfenced\n\\]\n```";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize LaTeX delimiters inside raw HTML code", () => {
  const markdown = "<code>\\(inline\\)</code>\n\n<pre>\n\\(block\\)\n</pre>";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("returns exact input reference when no math syntax is present and preserves pre blocks with math-like text", () => {
  const plain = "Hello world\nThis has no math syntax at all.\n";
  assert.strictEqual(normalizeDisplayMath(plain), plain);

  const preWithMathLike = "<pre>\n$$x = y$$\n\\[z = w\\]\n\\(a = b\\)\n</pre>";
  assert.equal(normalizeDisplayMath(preWithMathLike), preWithMathLike);
});

test("does not normalize escaped delimiters or link destinations", () => {
  const escaped = String.raw`Literal: \\(x+y\\).`;
  const link = String.raw`[docs](https://example.com/\(manual\))`;

  assert.equal(normalizeDisplayMath(escaped), escaped);
  assert.equal(normalizeDisplayMath(link), link);
});

function renderWithRepo(markdown, repo) {
  return renderToStaticMarkup(
    React.createElement(GithubRepoContext.Provider, { value: repo }, React.createElement(MarkdownBody, null, markdown)),
  );
}

test("links bare #N to the session repository and owner/repo#N to its own", () => {
  const html = renderWithRepo("On PR #3460 (see can1357/oh-my-pi#12130).", "kahme247/ompweb");

  assert.match(html, /<a href="https:\/\/github\.com\/kahme247\/ompweb\/issues\/3460"[^>]*>#3460<\/a>/);
  assert.match(html, /<a href="https:\/\/github\.com\/can1357\/oh-my-pi\/issues\/12130"[^>]*>can1357\/oh-my-pi#12130<\/a>/);
});

test("leaves bare #N plain without a repository but still links owner/repo#N", () => {
  const html = renderWithRepo("#12 and a/b#7", null);

  assert.doesNotMatch(html, /issues\/12/);
  assert.match(html, /href="https:\/\/github\.com\/a\/b\/issues\/7"/);
});

test("does not link references in code, existing links, or glued to words and paths", () => {
  const html = renderWithRepo("`#1` [see #2](https://x.test) C#3 file.ts#4 a/b/c#5 #6x #0 https://x.test/p#7", "o/r");

  assert.doesNotMatch(html, /github\.com/);
});

test("does not leak react-markdown node metadata onto inline code", () => {
  const html = renderMarkdown("Run `npm test` or [`docs`](https://example.com).");

  assert.match(html, /<code class="markdown-inline-code">npm test<\/code>/);
  assert.doesNotMatch(html, /\snode=/);
});

const agentLinkModule = await import("../lib/agent-links.ts");
const { AgentLinkContext, agentLinkIds } = agentLinkModule;

function renderWithAgentLinks(markdown) {
  return renderToStaticMarkup(
    React.createElement(AgentLinkContext.Provider, { value() {} },
      React.createElement(MarkdownBody, null, markdown)),
  );
}

test("links agent:// handles in prose, exact inline code, and markdown links", () => {
  const html = renderWithAgentLinks("Output at agent://Review.Child. See `agent://Scout` and [notes](agent://Notes/0).");

  assert.match(html, /<a href="agent:\/\/Review\.Child"[^>]*>agent:\/\/Review\.Child<\/a>\./);
  assert.match(html, /<a href="agent:\/\/Scout"[^>]*><code[^>]*>agent:\/\/Scout<\/code><\/a>/);
  assert.match(html, /<a href="agent:\/\/Notes\/0"[^>]*>notes<\/a>/);
  assert.doesNotMatch(html, /target="_blank"/);
});

test("leaves agent:// handles inside code and larger code spans unlinked", () => {
  const html = renderWithAgentLinks("`write agent://Scout`\n\n```\nagent://Scout\n```\n\nxagent://Scout");

  assert.doesNotMatch(html, /<a /);
});

test("renders agent:// handles as plain text outside a chat view", () => {
  const html = renderToStaticMarkup(React.createElement(MarkdownBody, null, "[out](agent://Scout) agent://Scout"));

  assert.doesNotMatch(html, /<a /);
  assert.match(html, /out agent:\/\/Scout/);
});

test("resolves agent:// hrefs to nested id before the base id", () => {
  assert.deepEqual(agentLinkIds("agent://Parent/Child"), ["Parent.Child", "Parent"]);
  assert.deepEqual(agentLinkIds("agent://Parent/items/0?x"), ["Parent.items.0", "Parent"]);
  assert.deepEqual(agentLinkIds("agent://Parent/a.b"), ["Parent"]);
  assert.deepEqual(agentLinkIds("agent://Parent?q=.x"), ["Parent"]);
  assert.deepEqual(agentLinkIds("https://example.com"), []);
});

test("links agent:// handles before GitHub refs cannot claim their suffix", () => {
  const html = renderToStaticMarkup(
    React.createElement(GithubRepoContext.Provider, { value: "o/r" },
      React.createElement(AgentLinkContext.Provider, { value() {} },
        React.createElement(MarkdownBody, null, "agent://Foo#12"))),
  );

  assert.match(html, /<a href="agent:\/\/Foo"[^>]*>agent:\/\/Foo<\/a>#12/);
  assert.doesNotMatch(html, /github\.com/);
});

test("drops rather than blanks agent: hrefs that are not subagent handles", () => {
  const html = renderWithAgentLinks("[a](agent:Foo) <a href=\"agent:Bar\">b</a> agent://all `agent://all` [c](agent://all) <a href=\"agent://all?q=.x\">d</a>");

  assert.doesNotMatch(html, /href=""/);
  assert.doesNotMatch(html, /href="agent:/);
});

test("opens the most specific roster entry, else a disk-backed stub for the base id", () => {
  const { agentLinkTarget } = agentLinkModule;
  const parent = { id: "Parent", agent: "task", status: "completed", index: 0 };
  const child = { id: "Parent.Child", agent: "scout", status: "started", index: 1 };

  assert.equal(agentLinkTarget(["Parent.Child", "Parent"], [parent, child]), child);
  assert.equal(agentLinkTarget(["Parent.Child", "Parent"], [parent]), parent);
  assert.deepEqual(agentLinkTarget(["Gone.Kid", "Gone"], [parent]), {
    id: "Gone", agent: "Gone", status: "completed", index: 0, source: "history",
  });
});
