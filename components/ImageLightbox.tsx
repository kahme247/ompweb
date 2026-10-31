"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ImgHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { Maximize } from "lucide-react";
import { useI18n } from "@/lib/i18n";

const ZOOM_MAX = 8;
/** Lowest zoom when the fitted size is larger; big images can go below it down to their fit. */
const ZOOM_FLOOR = 0.1;
const ZOOM_FACTOR = 1.25;

interface Size { width: number; height: number }

/** Scale that fits `image` inside `box`; never above 1, so small images keep their real size. */
export function fitZoom(image: Size, box: Size): number {
  if (image.width <= 0 || image.height <= 0 || box.width <= 0 || box.height <= 0) return 1;
  return Math.min(1, box.width / image.width, box.height / image.height);
}

/** One zoom step in or out, clamped to [min(fit, 10%), 800%]. */
export function stepZoom(zoom: number, direction: 1 | -1, fit: number): number {
  const next = direction > 0 ? zoom * ZOOM_FACTOR : zoom / ZOOM_FACTOR;
  return Math.min(ZOOM_MAX, Math.max(Math.min(fit, ZOOM_FLOOR), next));
}

interface ClickableImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> {
  /** Image source: string URL (data:, http(s):, blob:, /api/files/...) or Blob. */
  src: ImgHTMLAttributes<HTMLImageElement>["src"];
  /** Larger image for the lightbox when `src` is only a preview. */
  fullSrc?: string;
}

/**
 * Click-to-preview image: renders the thumbnail inline and opens a full-screen
 * lightbox with zoom controls on click. Accepts any img props (style, className,
 * width, ...) and forwards them to the thumbnail element.
 *
 * Blob sources (part of React 19's img-src union) render through a managed
 * object URL that is revoked when the source changes or the component unmounts
 * — the same mechanism React's experimental `enableSrcObject` will use natively.
 */
export function ClickableImage({ src, fullSrc, alt, ...imgProps }: ClickableImageProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (typeof src === "string" || src === undefined) {
      setObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(src);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [src]);

  const resolvedSrc = typeof src === "string" ? src : objectUrl ?? "";

  // Never render a broken clickable thumbnail for a missing source.
  if (!resolvedSrc) return null;

  return (
    <>
      <button
        type="button"
        className="image-clickable"
        onClick={(event) => {
          // Linked markdown images (`[![alt](img)](url)`) wrap this button in
          // an anchor; never let the click bubble and navigate away.
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
        aria-label={alt ? t("imagePreview.openWithAlt", { alt }) : t("imagePreview.open")}
        title={alt ? t("imagePreview.openWithAlt", { alt }) : t("imagePreview.open")}
      >
        <img src={resolvedSrc} alt={alt ?? ""} loading="lazy" {...imgProps} />
      </button>
      {/*
        Portal to <body>: a linked markdown image (`[![alt](img)](url)`) would
        otherwise keep the dialog inside the anchor, so clicks on the viewer
        (zoom, close) would bubble into anchor navigation. The dialog only
        renders when `open`, which is strictly client-side — the short-circuit
        keeps `document.body` off the SSR path.
      */}
      {open && createPortal(<ImageLightbox src={fullSrc ?? resolvedSrc} alt={alt ?? ""} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function ImageLightbox({ src, alt, onClose }: { src: ClickableImageProps["src"]; alt: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  // "fit" follows the window as it resizes; a number is a zoom the user chose.
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [natural, setNatural] = useState<Size | null>(null);
  // Load finished either way: a broken image is shown as the browser renders it.
  const [settled, setSettled] = useState(false);
  const [box, setBox] = useState<Size | null>(null);
  // Centre of the view as a fraction of the content, kept across a zoom change.
  const anchorRef = useRef<{ x: number; y: number } | null>(null);
  const [uiScale, setUiScale] = useState(1);
  const { t } = useI18n();

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // Interface Scale zooms the root, so layout pixels are uiScale screen
    // pixels. Measure in screen pixels so 100% is one image pixel per pixel.
    const uiScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")) || 1;
    setUiScale(uiScale);
    // contentRect excludes the viewport padding, so "fit" leaves the margin visible.
    const observer = new ResizeObserver(([entry]) => {
      setBox({ width: entry.contentRect.width * uiScale, height: entry.contentRect.height * uiScale });
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const ready = natural !== null && box !== null;
  const fit = ready ? fitZoom(natural, box) : 1;
  const scale = zoom === "fit" ? fit : zoom;
  const minZoom = Math.min(fit, ZOOM_FLOOR);

  const zoomTo = (next: number | "fit") => {
    const viewport = viewportRef.current;
    if (viewport) {
      anchorRef.current = {
        x: (viewport.scrollLeft + viewport.clientWidth / 2) / viewport.scrollWidth,
        y: (viewport.scrollTop + viewport.clientHeight / 2) / viewport.scrollHeight,
      };
    }
    setZoom(next);
  };

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const anchor = anchorRef.current;
    if (!viewport || !anchor) return;
    anchorRef.current = null;
    viewport.scrollLeft = anchor.x * viewport.scrollWidth - viewport.clientWidth / 2;
    viewport.scrollTop = anchor.y * viewport.scrollHeight - viewport.clientHeight / 2;
  }, [scale]);

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
      className="image-lightbox-dialog"
      aria-label={t("imagePreview.viewerLabel")}
      onClick={(event) => {
        // createPortal moves the DOM to <body>, but React synthetic events
        // still bubble through the component tree: without this, clicks on
        // viewer controls would reach a wrapping anchor's onClick (mixed
        // markdown links like `[text ![img]](file)`) and open its target.
        event.stopPropagation();
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // stopPropagation: the app's window-level Escape handler aborts a
        // running agent — closing the lightbox must not also stop it.
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="image-lightbox-layout">
        <div className="image-lightbox-toolbar">
          <span className="image-lightbox-title">{alt || t("imagePreview.imageTitle")}</span>
          <div className="image-lightbox-actions">
            <div className="image-lightbox-stepper">
              <button
                type="button"
                onClick={() => zoomTo(stepZoom(scale, -1, fit))}
                disabled={!ready || scale <= minZoom}
                title={t("imagePreview.zoomOut")}
                aria-label={t("imagePreview.zoomOut")}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M5 12h14" />
                </svg>
              </button>
              <span className="image-lightbox-zoom-value" aria-hidden={!ready}>{ready ? `${Math.round(scale * 100)}%` : "…"}</span>
              <button
                type="button"
                onClick={() => zoomTo(stepZoom(scale, 1, fit))}
                disabled={!ready || scale >= ZOOM_MAX}
                title={t("imagePreview.zoomIn")}
                aria-label={t("imagePreview.zoomIn")}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            </div>
            <button
              type="button"
              className="image-lightbox-icon-button"
              onClick={() => zoomTo("fit")}
              aria-pressed={zoom === "fit"}
              title={t("imagePreview.fitToScreen")}
              aria-label={t("imagePreview.fitToScreen")}
            >
              <Maximize size={13} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="image-lightbox-icon-button image-lightbox-actual-size"
              onClick={() => zoomTo(1)}
              aria-pressed={zoom === 1}
              title={t("imagePreview.actualSize")}
              aria-label={t("imagePreview.actualSize")}
            >
              1:1
            </button>
            <button
              type="button"
              className="image-lightbox-icon-button"
              onClick={onClose}
              title={t("imagePreview.close")}
              aria-label={t("imagePreview.close")}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        </div>
        <div
          ref={viewportRef}
          className="image-lightbox-viewport"
          onClick={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <img
            src={src}
            alt={alt}
            className="image-lightbox-img"
            onLoad={(event) => {
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
              // Some engines report 0×0 for SVGs without an intrinsic size: show those unsized.
              if (width > 0 && height > 0) setNatural({ width, height });
              setSettled(true);
            }}
            onError={() => setSettled(true)}
            // Real layout size, not transform: scale, so a zoomed-in image
            // scrolls to every edge. Hidden until it can be sized to fit.
            style={ready
              ? { width: natural.width * scale / uiScale, height: natural.height * scale / uiScale }
              : settled ? undefined : { visibility: "hidden" }}
          />
        </div>
      </div>
    </dialog>
  );
}
