"use client";

import { useEffect, useState } from "react";
import { ensureLanguageRegistered, isLanguageRegistered, SyntaxHighlighter, vs, vscDarkPlus } from "@/lib/syntax-highlight";
import { useTheme } from "@/hooks/useTheme";

interface Props {
  code: string;
  lang: string;
}

function PlainCode({ code }: { code: string }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: "11px 13px",
        fontSize: "var(--chat-code-font-size)",
        lineHeight: 1.62,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        color: "var(--text)",
        backgroundColor: "color-mix(in srgb, var(--bg) 88%, var(--bg-panel))",
        fontFamily: "var(--font-mono)",
      }}
    >
      {code}
    </pre>
  );
}

export function SyntaxHighlightedCode({ code, lang }: Props) {
  const { isDark } = useTheme();
  const [ready, setReady] = useState(() => isLanguageRegistered(lang));

  useEffect(() => {
    let cancelled = false;
    setReady(isLanguageRegistered(lang));
    const promise = ensureLanguageRegistered(lang);
    if (promise) {
      promise.then(() => { if (!cancelled) setReady(true); });
    }
    return () => { cancelled = true; };
  }, [lang]);

  if (!ready) {
    return <PlainCode code={code} />;
  }

  return (
    <SyntaxHighlighter
      language={lang || "text"}
      style={isDark ? vscDarkPlus : vs}
      showLineNumbers
      lineNumberStyle={{ color: "var(--text-dim)", fontStyle: "normal" }}
      customStyle={{
        margin: 0,
        padding: "11px 13px",
        fontSize: "var(--chat-code-font-size)",
        lineHeight: 1.62,
        borderRadius: 0,
        backgroundColor: "color-mix(in srgb, var(--bg) 88%, var(--bg-panel))",
      }}
      codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
    >
      {code}
    </SyntaxHighlighter>
  );
}
