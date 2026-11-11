"use client";

import { useMemo, type CSSProperties } from "react";
import { CodeBlock } from "./MermaidBlock";

interface SvgBlockProps {
  code: string;
  isStreaming?: boolean;
}

// omp/ompweb theme variable aliases. The TUI-facing svg conventions use
// --fg / --muted / --surface / --c1..--c6, which do not exist in the web
// theme; without aliases those fills resolve to nothing and the drawing
// turns black on a dark background. --c1..--c6 map to status colours as an
// approximation (#421).
const SVG_THEME_ALIASES: Record<string, string> = {
  "--fg": "var(--text)",
  "--muted": "var(--text-muted)",
  "--surface": "var(--bg-panel)",
  "--c1": "var(--accent)",
  "--c2": "var(--status-success)",
  "--c3": "var(--status-warning)",
  "--c4": "var(--status-error)",
  "--c5": "var(--status-modified)",
  "--c6": "var(--status-renamed)",
};

// script and foreignObject can run code or embed foreign content; style is
// stripped too — inline SVG CSS applies to the whole document, so a <style>
// block inside a fence could restyle the app. The reference implementation
// in #421 leaves <style> in place; this PR removes it.
const UNSAFE_TAGS = ["script", "foreignObject", "style"];
const UNSAFE_HREF = /^\s*(javascript|data:text\/html)/i;
const UNSAFE_ATTRIBUTE = /^on/i;

function sanitizeSvg(root: Element): void {
  for (const tag of UNSAFE_TAGS) {
    for (const el of root.querySelectorAll(tag)) el.remove();
  }
  // querySelectorAll("*") covers descendants only — the root itself can also
  // carry an on* handler or a javascript: href, so sweep it too.
  for (const el of [root, ...root.querySelectorAll("*")]) {
    for (const attr of [...el.attributes]) {
      if (UNSAFE_ATTRIBUTE.test(attr.name)) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (/^(href|xlink:href)$/i.test(attr.name) && UNSAFE_HREF.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }
}

/**
 * Parse + sanitize an SVG fence into embeddable markup, or null when the
 * source is not a well-formed `<svg>` document (malformed input, or a fence
 * still streaming half-written markup). Pure except for DOMParser /
 * XMLSerializer, so tests drive it directly.
 */
export function parseSvgMarkup(code: string): string | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(code, "image/svg+xml");
  } catch {
    return null;
  }
  if (doc.querySelector("parsererror")) return null;
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg") return null;
  sanitizeSvg(root);
  const style = root.getAttribute("style");
  root.setAttribute("style", `${style ? `${style};` : ""}max-width:100%;height:auto`);
  if (!root.hasAttribute("fill")) root.setAttribute("fill", "currentColor");
  if (!root.hasAttribute("xmlns")) root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return new XMLSerializer().serializeToString(root);
}

export function SvgBlock({ code, isStreaming }: SvgBlockProps) {
  const markup = useMemo(() => parseSvgMarkup(code), [code]);

  // Streaming generates half-written markup; fall back to the code block until
  // the fence closes.
  if (!markup) {
    return <CodeBlock code={code} lang="svg" isStreaming={isStreaming} />;
  }
  return (
    <div
      className="markdown-svg-block"
      style={{
        ...SVG_THEME_ALIASES,
        color: "var(--text)",
        display: "flex",
        justifyContent: "center",
        overflow: "auto",
        padding: "4px 0",
      } as CSSProperties}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
