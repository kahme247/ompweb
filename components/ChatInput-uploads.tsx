"use client";

import React from "react";
import { AlertCircle, File as FileIcon, Loader2, RotateCw, X } from "lucide-react";
import type { ChatDraftUpload } from "@/lib/draft-store";
import { UploadFailedError } from "@/lib/event-stream";
import { formatUploadSize } from "@/lib/upload-limits";
import { translate, useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";

// Composer attachments sent As file (docs/specs/2026-11-02-file-uploads-design.md U2): uploaded to the target host on
// attach, then named by id in the prompt.

export interface AttachedUpload {
  id: string;
  name: string;
  size: number;
  hostId: string;
  /** The picked file, to retry or switch back to Inline with; null for one restored from a draft (finished). */
  file: File | null;
  /** Bytes the host has. */
  received: number;
  status: "uploading" | "done" | "error";
  error: string | null;
  /** An image sent As file: its thumbnail (an object URL). */
  previewUrl: string | null;
}

export function draftUploadsToAttachedUploads(uploads: ChatDraftUpload[] | undefined): AttachedUpload[] {
  return (uploads ?? []).map((upload) => ({ ...upload, file: null, received: upload.size, status: "done", error: null, previewUrl: null }));
}

/** Only finished uploads go into a draft: one in flight is lost with the page (spec U2). */
export function attachedUploadsToDraftUploads(uploads: AttachedUpload[]): ChatDraftUpload[] {
  return uploads.filter((upload) => upload.status === "done").map(({ id, name, size, hostId }) => ({ id, name, size, hostId }));
}

/** The upload ids for a send callback: an argument only when there are some (images otherwise stay the last). */
export function uploadArgs(uploads: AttachedUpload[]): [] | [string[]] {
  return uploads.length ? [uploads.map((upload) => upload.id)] : [];
}

/** What a refused send puts back into its draft, besides text and images. */
export function uploadRecovery(uploads: AttachedUpload[]): { uploads?: ChatDraftUpload[] } {
  return uploads.length ? { uploads: attachedUploadsToDraftUploads(uploads) } : {};
}

export function uploadErrorMessage(error: unknown): string {
  return error instanceof UploadFailedError ? formatApiError({ error: error.message, code: error.code }) : translate("chatInput.uploadFailed");
}

const percentOf = (upload: AttachedUpload) => (upload.size > 0 ? Math.floor((upload.received * 100) / upload.size) : 100);

function ChipButton({ label, onClick, children, style }: { label: string; onClick: () => void; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <button
      type="button"
      className="attachment-remove-button"
      onClick={onClick}
      title={label}
      aria-label={label}
      style={{
        flexShrink: 0, width: 18, height: 18,
        borderRadius: "50%",
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "transparent", border: "none",
        cursor: "pointer", padding: 0, color: "var(--text-muted)",
        transition: "color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
        ...style,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = style?.background as string ?? "transparent"; }}
    >
      {children}
    </button>
  );
}

function ProgressBar({ upload }: { upload: AttachedUpload }) {
  const { t } = useI18n();
  const percent = percentOf(upload);
  return (
    <span
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-label={t("chatInput.uploadProgress", { name: upload.name })}
      style={{
        position: "absolute", left: 0, bottom: 0, height: 2, width: `${percent}%`,
        background: "var(--accent)", transition: "width var(--dur-fast) var(--ease-out-warm)",
      }}
    />
  );
}

/** A file sent As file: progress while it uploads, then its size; on failure a retry. Remove aborts it. */
export function UploadChip({ upload, onRemove, onRetry }: { upload: AttachedUpload; onRemove: () => void; onRetry: () => void }) {
  const { t } = useI18n();
  const failed = upload.status === "error";
  return (
    <div
      title={failed ? `${upload.name}: ${upload.error ?? ""}` : upload.name}
      style={{
        position: "relative", overflow: "hidden",
        display: "flex", alignItems: "center", gap: 7,
        maxWidth: 260, height: 30,
        padding: "0 6px 0 9px",
        border: `1px solid ${failed ? "color-mix(in srgb, var(--status-error) 40%, transparent)" : "var(--border)"}`,
        borderRadius: 6,
        background: "var(--bg-panel)",
        fontSize: 12,
        color: "var(--text)",
      }}
    >
      <span style={{ flexShrink: 0, display: "flex", color: failed ? "var(--status-error)" : "var(--text-muted)" }}>
        {failed
          ? <AlertCircle size={13} strokeWidth={2} aria-hidden="true" />
          : upload.status === "uploading"
            ? <Loader2 size={13} strokeWidth={2} className="animate-spin" aria-hidden="true" />
            : <FileIcon size={13} strokeWidth={2} aria-hidden="true" />}
      </span>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: 11.5 }}>
        {upload.name}
      </span>
      <span style={{ flexShrink: 0, fontSize: 10, color: failed ? "var(--status-error)" : "var(--text-dim)" }}>
        {failed ? t("chatInput.uploadFailed") : upload.status === "uploading" ? `${percentOf(upload)}%` : formatUploadSize(upload.size)}
      </span>
      {failed && upload.file && (
        <ChipButton label={t("chatInput.uploadRetry")} onClick={onRetry}>
          <RotateCw size={11} strokeWidth={2} aria-hidden="true" />
        </ChipButton>
      )}
      <ChipButton label={t("chatInput.removeFile")} onClick={onRemove}>
        <X size={11} strokeWidth={2} aria-hidden="true" />
      </ChipButton>
      {upload.status === "uploading" && <ProgressBar upload={upload} />}
    </div>
  );
}

/**
 * An image chip: its thumbnail, an Inline / As file switch, and remove. `upload` is set while it goes As file (progress,
 * failure and retry as on a file chip). `canSwitch` false: the other mode is not available (too large to send inline,
 * or no file to upload).
 */
export function ImageChip({ previewUrl, upload, canSwitch, onSwitch, onRemove, onRetry }: {
  previewUrl: string | null;
  upload: AttachedUpload | null;
  canSwitch: boolean;
  onSwitch: () => void;
  onRemove: () => void;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  const failed = upload?.status === "error";
  return (
    <div style={{ position: "relative", flexShrink: 0 }} title={failed ? upload?.error ?? undefined : undefined}>
      <div style={{ position: "relative", width: 56, height: 56, overflow: "hidden", borderRadius: 6, border: `1px solid ${failed ? "var(--status-error)" : "var(--border)"}` }}>
        {previewUrl && <img src={previewUrl} alt="" style={{ width: 56, height: 56, objectFit: "cover", display: "block" }} />}
        <button
          type="button"
          onClick={onSwitch}
          disabled={!canSwitch}
          aria-label={t(upload ? "chatInput.imageSwitchToInline" : "chatInput.imageSwitchToFile")}
          title={canSwitch ? t("chatInput.imageModeHint") : t("chatInput.imageInlineTooLarge")}
          style={{
            position: "absolute", left: 2, right: 2, bottom: 3,
            height: 15, padding: 0, borderRadius: 4,
            border: "1px solid var(--border)",
            background: "color-mix(in srgb, var(--bg-panel) 90%, transparent)",
            color: upload ? "var(--accent)" : "var(--text-muted)",
            fontSize: 9.5, fontWeight: 600, lineHeight: "13px",
            cursor: canSwitch ? "pointer" : "default",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}
        >
          {t(upload ? "chatInput.imageAsFile" : "chatInput.imageInline")}
        </button>
        {upload?.status === "uploading" && <ProgressBar upload={upload} />}
      </div>
      {failed && upload?.file && onRetry && (
        <ChipButton
          label={t("chatInput.uploadRetry")}
          onClick={onRetry}
          style={{ position: "absolute", top: -5, left: -5, width: 24, height: 24, background: "var(--bg-panel)", border: "1px solid var(--status-error)", color: "var(--status-error)" }}
        >
          <RotateCw size={11} strokeWidth={2} aria-hidden="true" />
        </ChipButton>
      )}
      <ChipButton
        label={t("chatInput.removeImage")}
        onClick={onRemove}
        style={{ position: "absolute", top: -5, right: -5, width: 24, height: 24, background: "var(--bg-panel)", border: "1px solid var(--border)" }}
      >
        <X size={11} strokeWidth={2} aria-hidden="true" />
      </ChipButton>
    </div>
  );
}
