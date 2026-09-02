"use client";

import { memo, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/lib/i18n";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";

interface MermaidBlockProps {
  code: string;
  isStreaming?: boolean;
  defaultPreview?: boolean;
}

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

type RenderState =
  | { key: string; status: "loading" }
  | { key: string; status: "error" }
  | { key: string; status: "ready"; svg: string };

export function MermaidBlock({ code, isStreaming, defaultPreview = false }: MermaidBlockProps) {
  const { isDark } = useTheme();
  const { t } = useI18n();
  const [showPreview, setShowPreview] = useState(defaultPreview);
  const [renderState, setRenderState] = useState<RenderState | null>(null);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const currentKey = `${isDark ? "dark" : "light"}\n${code}`;
  const previewVisible = showPreview && !isStreaming;

  useEffect(() => {
    if (!previewVisible) return;

    let cancelled = false;
    setRenderState({ key: currentKey, status: "loading" });

    const render = async () => {
      const { default: mermaid } = await import("mermaid");
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: isDark ? "dark" : "default",
      });

      const parsed = await mermaid.parse(code, { suppressErrors: true });
      if (!parsed) throw new Error("Invalid Mermaid diagram");

      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? `mermaid-${crypto.randomUUID()}`
          : `mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const result = await mermaid.render(id, code);
      if (!cancelled) {
        setRenderState({ key: currentKey, status: "ready", svg: result.svg });
      }
    };

    render().catch(() => {
      if (!cancelled) setRenderState({ key: currentKey, status: "error" });
    });

    return () => {
      cancelled = true;
    };
  }, [code, currentKey, isDark, previewVisible, retryKey]);

  const previewButton = (
    <button
      type="button"
      onClick={() => setShowPreview((v) => !v)}
      disabled={isStreaming}
      title={isStreaming ? t("mermaidBlock.previewAfterStreaming") : (previewVisible ? t("mermaidBlock.showSourceTitle") : t("mermaidBlock.previewTitle"))}
      className={["markdown-code-action", previewVisible ? "is-active" : ""].filter(Boolean).join(" ")}
    >
      {previewVisible ? t("mermaidBlock.source") : t("mermaidBlock.preview")}
    </button>
  );

  if (!previewVisible) {
    return <CodeBlock code={code} lang="mermaid" headerAction={previewButton} isStreaming={isStreaming} />;
  }

  const body = renderState?.key === currentKey && renderState.status === "error" ? (
      <div className="mermaid-block mermaid-block-error">
        <span>{t("mermaidBlock.invalidDiagram")}</span>
        <button
          type="button"
          className="markdown-code-action"
          onClick={() => setRetryKey((key) => key + 1)}
          title={t("mermaidBlock.retry")}
        >
          {t("mermaidBlock.retry")}
        </button>
      </div>
    ) : renderState?.key !== currentKey || renderState.status !== "ready" ? (
      <div className="mermaid-block mermaid-block-loading" role="status">{t("mermaidBlock.rendering")}</div>
    ) : (
      <>
        {!zoomOpen && (
          <button
            type="button"
            className="mermaid-block mermaid-preview-button"
            title={t("mermaidBlock.openViewer")}
            aria-label={t("mermaidBlock.openViewer")}
            onClick={() => setZoomOpen(true)}
            dangerouslySetInnerHTML={{ __html: renderState.svg }}
          />
        )}
        {zoomOpen && <MermaidZoomDialog svg={renderState.svg} onClose={() => setZoomOpen(false)} />}
      </>
    );

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">mermaid</span>
        {previewButton}
      </div>
      {body}
    </div>
  );
}

function MermaidZoomDialog({ svg, onClose }: { svg: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [zoom, setZoom] = useState(1);
  const { t } = useI18n();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();

    return () => {
      document.body.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="mermaid-zoom-dialog"
      aria-label={t("mermaidBlock.viewerLabel")}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        // Do not let the Escape reach the window-level listener, which would
        // abort a running agent (same pattern as ImageLightbox).
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="mermaid-zoom-layout">
        <div className="mermaid-zoom-toolbar">
          <span className="mermaid-zoom-title">{t("mermaidBlock.diagramTitle")}</span>
          <div className="mermaid-zoom-actions">
            <div className="mermaid-zoom-stepper">
              <button
                type="button"
                onClick={() => setZoom((value) => Math.max(ZOOM_MIN, value - ZOOM_STEP))}
                disabled={zoom <= ZOOM_MIN}
                title={t("mermaidBlock.zoomOut")}
                aria-label={t("mermaidBlock.zoomOut")}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M5 12h14" />
                </svg>
              </button>
              <span className="mermaid-zoom-value">{Math.round(zoom * 100)}%</span>
              <button
                type="button"
                onClick={() => setZoom((value) => Math.min(ZOOM_MAX, value + ZOOM_STEP))}
                disabled={zoom >= ZOOM_MAX}
                title={t("mermaidBlock.zoomIn")}
                aria-label={t("mermaidBlock.zoomIn")}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            </div>
            <button
              type="button"
              className="mermaid-zoom-icon-button"
              onClick={() => setZoom(1)}
              title={t("mermaidBlock.fitToWidth")}
              aria-label={t("mermaidBlock.fitToWidth")}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
              </svg>
            </button>
            <button
              type="button"
              className="mermaid-zoom-icon-button"
              onClick={onClose}
              title={t("mermaidBlock.close")}
              aria-label={t("mermaidBlock.close")}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        </div>
        <div
          className="mermaid-zoom-viewport"
          onClick={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <div
            className="mermaid-zoom-canvas"
            // Width-based zoom re-lays out the whole SVG on every step;
            // scale is composited. Top-left origin keeps growth scrollable
            // and anchored while zoomed.
            style={{ transform: `scale(${zoom})`, transformOrigin: "top left" }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      </div>
    </dialog>
  );
}

interface CodeBlockProps {
  code: string;
  lang: string;
  headerAction?: ReactNode;
  isStreaming?: boolean;
}

/**
 * Syntax-highlighted code block with copy button.
 * Used as the "source" view for mermaid blocks and for all non-mermaid code fences.
 */
export const CodeBlock = memo(function CodeBlock({ code, lang, headerAction, isStreaming }: CodeBlockProps) {
  const { t } = useI18n();
  const { copied, copy } = useCopyFeedback();
  const [HighlightedCode, setHighlightedCode] = useState<ComponentType<{ code: string; lang: string }> | null>(null);

  useEffect(() => {
    if (isStreaming || HighlightedCode) return;
    let cancelled = false;
    void import("./SyntaxHighlightedCode").then(({ SyntaxHighlightedCode }) => {
      if (!cancelled) setHighlightedCode(() => SyntaxHighlightedCode);
    });
    return () => { cancelled = true; };
  }, [HighlightedCode, isStreaming]);

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">{lang || "text"}</span>
        <div className="markdown-code-actions">
          {headerAction}
          <button
            onClick={() => copy(code)}
            className={copied ? "markdown-code-action is-copied" : "markdown-code-action"}
          >
            {copied ? t("codeBlock.copied") : t("codeBlock.copy")}
          </button>
        </div>
      </div>
      {isStreaming || !HighlightedCode ? (
        <pre style={{
          margin: 0,
          padding: "11px 13px",
          fontSize: "var(--chat-code-font-size)",
          lineHeight: 1.62,
          overflowX: "auto",
          backgroundColor: "color-mix(in srgb, var(--bg) 88%, var(--bg-panel))",
        }}>
          <code style={{ fontFamily: "var(--font-mono)" }}>{code}</code>
        </pre>
      ) : (
        <HighlightedCode code={code} lang={lang} />
      )}
    </div>
  );
});
