// Shared PrismLight setup: registers a curated grammar set instead of the full
// Prism build, which bundles all ~600 refractor grammars plus the entire CJS
// theme barrel. The fence/file languages that dominate real sessions are
// registered here; unknown fence languages fall back to plain text without
// console noise (the highlighter catches the unknown-language error itself).
//
// IMPORTANT: every grammar is registered EAGERLY via static imports. An earlier
// design lazy-loaded the rarer grammars with `() => import(...)`; under the
// previous Turbopack build those ESM-only refractor chains were split into async
// chunks that intermittently failed to instantiate ("module factory is not
// available"), taking down the whole page. Static imports keep every grammar in
// the entry chunk: nothing is split, so nothing can race. Grammars are small
// regex-based objects, so the eager cost is a few KB on top of the core set.
import type { CSSProperties } from "react";
import createSyntaxElement from "react-syntax-highlighter/dist/esm/create-element";
import PrismLight from "react-syntax-highlighter/dist/esm/prism-light";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import c from "react-syntax-highlighter/dist/esm/languages/prism/c";
import cpp from "react-syntax-highlighter/dist/esm/languages/prism/cpp";
import csharp from "react-syntax-highlighter/dist/esm/languages/prism/csharp";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff";
import docker from "react-syntax-highlighter/dist/esm/languages/prism/docker";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import graphql from "react-syntax-highlighter/dist/esm/languages/prism/graphql";
import hcl from "react-syntax-highlighter/dist/esm/languages/prism/hcl";
import ini from "react-syntax-highlighter/dist/esm/languages/prism/ini";
import java from "react-syntax-highlighter/dist/esm/languages/prism/java";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import kotlin from "react-syntax-highlighter/dist/esm/languages/prism/kotlin";
import makefile from "react-syntax-highlighter/dist/esm/languages/prism/makefile";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import protobuf from "react-syntax-highlighter/dist/esm/languages/prism/protobuf";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import ruby from "react-syntax-highlighter/dist/esm/languages/prism/ruby";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import scss from "react-syntax-highlighter/dist/esm/languages/prism/scss";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import swift from "react-syntax-highlighter/dist/esm/languages/prism/swift";
import toml from "react-syntax-highlighter/dist/esm/languages/prism/toml";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import vsTheme from "react-syntax-highlighter/dist/esm/styles/prism/vs";
import vscDarkPlusTheme from "react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus";

// Every grammar we render. Grammar modules carry their own aliases (ts, py,
// sh, html, yml, dockerfile, ...) and register their own dependencies, so
// registering under the canonical name is enough.
const GRAMMARS: Record<string, unknown> = {
  bash, c, cpp, csharp, css, diff, docker, go, graphql, hcl, ini, java,
  javascript, json, jsx, kotlin, makefile, markdown, markup, protobuf,
  python, ruby, rust, scss, sql, swift, toml, tsx, typescript, yaml,
};

for (const [name, grammar] of Object.entries(GRAMMARS)) {
  PrismLight.registerLanguage(name, grammar);
}

/**
 * True for every language — all grammars are registered eagerly, so nothing
 * ever needs a pending load. Unknown languages are passed through and fall
 * back to plain text inside the highlighter itself.
 */
export function isLanguageRegistered(language: string): boolean {
  void language; // All grammars are eager — kept only for call-site clarity.
  return true;
}

/**
 * Kept for API compatibility with callers that awaited a grammar load before
 * rendering (SyntaxHighlightedCode, FileViewer). Every grammar is already
 * registered, so there is never anything to wait for.
 */
export function ensureLanguageRegistered(language: string): Promise<void> | null {
  void language; // All grammars are eager — kept only for call-site clarity.
  return null;
}

const PRE_STYLE = 'pre[class*="language-"]';

function withoutPreBackground(theme: Record<string, CSSProperties>) {
  const preStyle = { ...theme[PRE_STYLE] };
  delete preStyle.background;
  delete preStyle.backgroundColor;
  return { ...theme, [PRE_STYLE]: preStyle };
}

const vs = withoutPreBackground(vsTheme);
const vscDarkPlus = withoutPreBackground(vscDarkPlusTheme);

export { createSyntaxElement, vs, vscDarkPlus };
export { PrismLight as SyntaxHighlighter };
