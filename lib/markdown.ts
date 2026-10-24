import { useEffect, useState } from "react";
import type { Options as ReactMarkdownOptions } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

const markdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./, "math-inline", "math-display"]],
  },
  // `agent://` subagent handles are opened in-app by MarkdownBody.
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "agent"],
  },
  strip: [...(defaultSchema.strip || []), "iframe", "object", "style", "form"],
};

// singleTilde:false requires ~~double~~ tildes for strikethrough. A single `~`
// is the standard CJK numeric-range separator (e.g. "5~7U", "100~200倍"), and
// GFM's default single-tilde strikethrough silently mangles such ranges (#385).
const remarkGfmOptions = { singleTilde: false } as const;

export interface MarkdownPlugins {
  remarkPlugins: NonNullable<ReactMarkdownOptions["remarkPlugins"]>;
  rehypePlugins: NonNullable<ReactMarkdownOptions["rehypePlugins"]>;
}

// Math-free pipeline used until math syntax is detected. The math pipeline is
// built from these same arrays, so the sanitize schema cannot drift between
// the two.
const baseMarkdownPlugins: MarkdownPlugins = {
  remarkPlugins: [[remarkGfm, remarkGfmOptions]],
  rehypePlugins: [rehypeRaw, [rehypeSanitize, markdownSanitizeSchema]],
};

let mathMarkdownPlugins: MarkdownPlugins | null = null;
let mathMarkdownPluginsPromise: Promise<MarkdownPlugins> | null = null;

/**
 * Cheap gate deciding whether the KaTeX pipeline could matter for a document.
 * False positives (e.g. dollar amounts) only cost loading the math chunk;
 * remark-math then decides what is actually math.
 */
export function containsMathSyntax(markdown: string): boolean {
  return markdown.includes("$") || markdown.includes("\\(") || markdown.includes("\\[");
}

const RAW_CODE_CLOSE_PATTERNS: Record<string, RegExp> = {
  code: /<\/code\s*>/i,
  pre: /<\/pre\s*>/i,
  script: /<\/script\s*>/i,
  style: /<\/style\s*>/i,
};

function getRawCodeClosePattern(tag: string): RegExp {
  return RAW_CODE_CLOSE_PATTERNS[tag] ?? new RegExp(`</${tag}\\s*>`, "i");
}

/** Loads remark-math + rehype-katex + the KaTeX CSS once, caching module-level. */
export function loadMathMarkdownPlugins(): Promise<MarkdownPlugins> {
  if (!mathMarkdownPluginsPromise) {
    mathMarkdownPluginsPromise = (async () => {
      const [remarkMath, rehypeKatex] = await Promise.all([
        import("remark-math").then((m) => m.default),
        import("rehype-katex").then((m) => m.default),
      ]);
      if (typeof window !== "undefined") {
        // KaTeX styles are only needed (and only loadable) in the browser.
        await import("katex/dist/katex.min.css");
      }
      mathMarkdownPlugins = {
        remarkPlugins: [...baseMarkdownPlugins.remarkPlugins, remarkMath],
        rehypePlugins: [
          ...baseMarkdownPlugins.rehypePlugins,
          [rehypeKatex, { throwOnError: false, strict: false }],
        ],
      };
      return mathMarkdownPlugins;
    })().catch((error) => {
      // Allow a later render to retry after e.g. a transient network failure.
      mathMarkdownPluginsPromise = null;
      throw error;
    });
  }
  return mathMarkdownPluginsPromise;
}

/**
 * Plugin arrays for ReactMarkdown. Documents without math syntax render with
 * the math-free pipeline and never fetch the KaTeX chunk; the first document
 * containing math triggers the lazy load and re-renders when it lands.
 */
export function useMarkdownPlugins(markdown: string): MarkdownPlugins {
  const hasMath = containsMathSyntax(markdown);
  const [, setLoadedVersion] = useState(0);

  useEffect(() => {
    if (!hasMath || mathMarkdownPlugins) return;
    let cancelled = false;
    loadMathMarkdownPlugins()
      .then(() => {
        if (!cancelled) setLoadedVersion((version) => version + 1);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [hasMath]);

  return hasMath && mathMarkdownPlugins ? mathMarkdownPlugins : baseMarkdownPlugins;
}

export function normalizeDisplayMath(markdown: string): string {
  if (!containsMathSyntax(markdown)) return markdown;
  const lineBreak = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/);
  const normalized: string[] = [];
  let fence: { marker: string; size: number } | null = null;
  let inlineCodeMarkerSize = 0;
  let rawCodeTag: string | null = null;
  const unmatchedDisplayMathUntil = new Map<string, number>();

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    if (rawCodeTag) {
      normalized.push(line);
      if (getRawCodeClosePattern(rawCodeTag).test(line)) rawCodeTag = null;
      continue;
    }

    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      const size = fenceMatch[1].length;
      if (!fence) fence = { marker, size };
      else if (marker === fence.marker && size >= fence.size) fence = null;
      inlineCodeMarkerSize = 0;
      normalized.push(line);
      continue;
    }

    if (fence) {
      normalized.push(line);
      continue;
    }

    const rawCodeOpen = line.match(/<(code|pre|script|style)\b/i);
    if (rawCodeOpen) {
      const tag = rawCodeOpen[1].toLowerCase();
      const remainder = line.slice((rawCodeOpen.index ?? 0) + rawCodeOpen[0].length);
      if (!getRawCodeClosePattern(tag).test(remainder)) rawCodeTag = tag;
      inlineCodeMarkerSize = 0;
      normalized.push(line);
      continue;
    }

    if (/^(?: {4}|\t)/.test(line) || line.trim() === "") {
      inlineCodeMarkerSize = 0;
      normalized.push(line);
      continue;
    }

    if (inlineCodeMarkerSize || line.includes("`")) {
      inlineCodeMarkerSize = updateInlineCodeMarker(line, inlineCodeMarkerSize);
      normalized.push(line);
      continue;
    }

    const bracketDisplayOneLine = line.match(/^([ ]{0,3})\\\[[ \t]*(.+?)[ \t]*\\\][ \t]*$/);
    if (bracketDisplayOneLine) {
      const math = bracketDisplayOneLine[2].trim();
      if (math) {
        // Keep the content line indented together with the `$$` fence. When the
        // formula is nested inside a GFM list item (indented `$$`), a content line
        // at column 0 becomes a lazy continuation that can mis-parse the fence pair.
        normalized.push(
          `${bracketDisplayOneLine[1]}$$`,
          `${bracketDisplayOneLine[1]}${math}`,
          `${bracketDisplayOneLine[1]}$$`,
        );
        continue;
      }
    }

    const bracketDisplayStart = line.match(/^([ ]{0,3})\\\[[ \t]*$/);
    if (bracketDisplayStart) {
      const closingIndex = findBracketDisplayClose(lines, index + 1);
      if (closingIndex !== -1) {
        normalized.push(
          `${bracketDisplayStart[1]}$$`,
          ...lines.slice(index + 1, closingIndex).map((mathLine) =>
            indentDisplayMathContent(mathLine, bracketDisplayStart[1]),
          ),
          `${bracketDisplayStart[1]}$$`,
        );
        index = closingIndex;
        continue;
      }
    }

    const displayMathMatch = line.match(/^([ \t]{0,3})\$\$(.+)\$\$[ \t]*$/);
    if (displayMathMatch) {
      const math = displayMathMatch[2].trim();
      if (math) {
        normalized.push(
          `${displayMathMatch[1]}$$`,
          `${displayMathMatch[1]}${math}`,
          `${displayMathMatch[1]}$$`,
        );
        continue;
      }
    }

    // Models may glue display fences to the first or last formula line.
    const displayMathMultiLine = line.match(/^([ \t]{0,3})\$\$(.+)$/);
    if (displayMathMultiLine) {
      const indent = displayMathMultiLine[1];
      const firstLine = displayMathMultiLine[2].trimEnd();
      // Keep `$$x$$ and text` inline; it is not a display block opener.
      if (firstLine && !firstLine.includes("$$")) {
        const closing = findDisplayMathClose(lines, index + 1, indent, unmatchedDisplayMathUntil);
        if (closing) {
          normalized.push(`${indent}$$`, `${indent}${firstLine}`);
          for (let j = index + 1; j < closing.index; j++) {
            normalized.push(indentDisplayMathContent(lines[j], indent));
          }
          if (closing.content) normalized.push(`${indent}${closing.content}`);
          normalized.push(`${indent}$$`);
          index = closing.index;
          continue;
        }
      }
    }

    // Normalize bare openers nested in list items, and glued closing fences.
    const displayMathBareOpen = line.match(/^([ \t]{0,3})\$\$\s*$/);
    if (displayMathBareOpen) {
      const indent = displayMathBareOpen[1];
      const closing = findDisplayMathClose(lines, index + 1, indent, unmatchedDisplayMathUntil);
      if (closing && (closing.glued || indent !== "")) {
        normalized.push(`${indent}$$`);
        for (let j = index + 1; j < closing.index; j++) {
          normalized.push(indentDisplayMathContent(lines[j], indent));
        }
        if (closing.content) normalized.push(`${indent}${closing.content}`);
        normalized.push(`${indent}$$`);
        index = closing.index;
        continue;
      }
    }

    normalized.push(normalizeInlineLatexMath(line));
  }

  return normalized.join(lineBreak);
}

interface DisplayMathClose {
  index: number;
  content: string;
  glued: boolean;
}

function findDisplayMathClose(
  lines: string[],
  startIndex: number,
  indent: string,
  unmatchedUntil: Map<string, number>,
): DisplayMathClose | null {
  const knownUnmatchedUntil = unmatchedUntil.get(indent);
  if (knownUnmatchedUntil !== undefined && startIndex < knownUnmatchedUntil) return null;

  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index];
    if (isDisplayMathFence(line, indent)) return { index, content: "", glued: false };
    if (isDisplayMathBlockBoundary(line) || isDisplayMathOpeningLine(line)) {
      unmatchedUntil.set(indent, index);
      return null;
    }
    const content = getDisplayMathGluedCloseContent(line, indent);
    if (content !== null) return { index, content, glued: true };
  }

  unmatchedUntil.set(indent, lines.length);
  return null;
}

function isDisplayMathFence(line: string, indent: string): boolean {
  if (indent === "") return /^ {0,3}\$\$\s*$/.test(line);
  return line.startsWith(indent) && /^\$\$\s*$/.test(line.slice(indent.length));
}

function getDisplayMathGluedCloseContent(line: string, indent: string): string | null {
  if (!line.startsWith(indent)) return null;
  const match = line.slice(indent.length).match(/^(.+?)\$\$\s*$/);
  if (!match) return null;
  const content = match[1].trimEnd();
  return content && !content.includes("$$") ? content : null;
}

function isDisplayMathOpeningLine(line: string): boolean {
  return /^ {0,3}\$\$(?:\S|[ \t]+\S)/.test(line);
}

function isDisplayMathBlockBoundary(line: string): boolean {
  return (
    /^ {0,3}(`{3,}|~{3,})/.test(line) ||
    /^[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/.test(line) ||
    /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(line) ||
    /^ {0,3}>/.test(line) ||
    /<(code|pre|script|style)\b/i.test(line)
  );
}

function indentDisplayMathContent(line: string, indent: string): string {
  if (!indent || !line || line.startsWith("\t")) return line;
  const leadingSpaces = line.match(/^ */)?.[0].length ?? 0;
  if (leadingSpaces >= indent.length) return line;
  return `${indent.slice(leadingSpaces)}${line}`;
}

function findBracketDisplayClose(lines: string[], startIndex: number): number {
  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index];
    if (/^ {0,3}\\\][ \t]*$/.test(line)) return index;

    // Do not pair delimiters across another Markdown block boundary.
    if (
      /^ {0,3}(`{3,}|~{3,})/.test(line) ||
      /^ {0,3}\\\[[ \t]*$/.test(line) ||
      /<(code|pre|script|style)\b/i.test(line)
    ) {
      return -1;
    }
  }

  return -1;
}

function updateInlineCodeMarker(line: string, initialMarkerSize: number): number {
  let markerSize = initialMarkerSize;
  for (let cursor = 0; cursor < line.length;) {
    if (line[cursor] !== "`") {
      cursor++;
      continue;
    }

    let end = cursor + 1;
    while (line[end] === "`") end++;
    const runSize = end - cursor;
    if (markerSize === 0) markerSize = runSize;
    else if (runSize === markerSize) markerSize = 0;
    cursor = end;
  }
  return markerSize;
}

function normalizeInlineLatexMath(line: string): string {
  if (
    /^\s{0,3}\[[^\]]+\]:/.test(line) ||
    /]\s*\(/.test(line) ||
    /<(?:!--|\/?[A-Za-z][^>]*>)/.test(line) ||
    /\b(?:https?|file|mailto):/i.test(line) ||
    /\b[A-Za-z]:\\/.test(line)
  ) {
    return line;
  }

  return line.replace(
    /(?<!\\)\\\(([^`\r\n$]+?)(?<!\\)\\\)/g,
    (match, math: string) => (math.trim() ? `$${math}$` : match),
  );
}
