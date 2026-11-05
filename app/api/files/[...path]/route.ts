import { apiErrorResponse, opErrorResponse, resolveWorkspaceHost } from "@/lib/api-utils";
import { readWorkspaceBytes, streamWorkspaceFile } from "@/lib/workspace-http";
import * as mammoth from "mammoth";
import { filePathFromSegments } from "@/lib/file-authorization";
import {
  DOCX_PREVIEW_MAX_BYTES,
  IMAGE_PREVIEW_MAX_BYTES,
  getAudioMime,
  getDocumentMime,
  getImageMime,
} from "@/lib/file-types";
import { parseUploadConflictStrategy } from "@/lib/file-upload";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { publishWorkspaceUpload, uploadErrorResponse } from "@/lib/uploads";
import { requestOwner } from "@/lib/web-auth";
import { isRecord } from "@/lib/type-guards";


const FILE_REQUEST_TYPES = ["list", "read", "download", "meta", "preview"] as const;
type FileRequestType = typeof FILE_REQUEST_TYPES[number];
const FILE_REQUEST_TYPE_SET = new Set<string>(FILE_REQUEST_TYPES);
const MAX_UPLOAD_CHECK_REQUEST_BYTES = 1024 * 1024;


function parseFileRequestType(value: string): FileRequestType | null {
  return FILE_REQUEST_TYPE_SET.has(value) ? (value as FileRequestType) : null;
}

export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    const { path: segments } = await params;
    const directory = filePathFromSegments(segments);
    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type") ?? "upload";
    if (type !== "upload" && type !== "upload-check") return Response.json({ error: "Invalid upload request type", code: "invalid_upload_type" }, { status: 400 });
    const body: unknown = await parseJsonWithinLimit(request, MAX_UPLOAD_CHECK_REQUEST_BYTES);
    if (!isRecord(body) || (body.hostId !== undefined && typeof body.hostId !== "string")) return Response.json({ error: "Invalid upload request", code: "invalid_request" }, { status: 400 });
    const queryHost = searchParams.get("hostId");
    if (queryHost && body.hostId && queryHost !== body.hostId) return Response.json({ error: "Host mismatch", code: "workspace_host_mismatch" }, { status: 409 });
    const resolved = await resolveWorkspaceHost(queryHost ?? body.hostId as string | undefined, searchParams.get("sessionId"));
    if ("response" in resolved) return resolved.response;
    const { host } = resolved;
    let names: string[];
    const files = body.uploads;
    if (type === "upload-check") {
      if (!Array.isArray(body.fileNames) || !body.fileNames.every((name) => typeof name === "string")) return Response.json({ error: "Invalid file names", code: "invalid_file_names" }, { status: 400 });
      names = body.fileNames;
    } else {
      if (!Array.isArray(files) || files.length === 0 || files.length > 1000 || !files.every((file) => isRecord(file) && typeof file.id === "string" && typeof file.name === "string")) return Response.json({ error: "Invalid uploads", code: "invalid_uploads" }, { status: 400 });
      names = files.map((file) => file.name as string);
    }
    const inspection = await host.workspaceOps.inspectUploads(directory, names);
    if (!inspection.ok) return opErrorResponse(inspection);
    if (type === "upload-check") return Response.json(inspection.value);
    const strategy = parseUploadConflictStrategy(searchParams.get("conflict"));
    if (!strategy) return Response.json({ error: "Invalid conflict strategy", code: "invalid_conflict_strategy" }, { status: 400 });
    const uploaded: string[] = [], skipped: string[] = [];
    const errors: Array<{ name: string; error: string; code?: string }> = [];
    let failureStatus = 200;
    for (const file of files as Array<{ id: string; name: string }>) {
      try {
        const result = await publishWorkspaceUpload(file.id, requestOwner(request), host.id, directory, file.name, strategy);
        (result.skipped ? skipped : uploaded).push(result.name);
      } catch (error) {
        const response = uploadErrorResponse(error);
        if (errors.length === 0) failureStatus = response.status;
        errors.push({ name: file.name, ...await response.json() });
      }
    }
    const allFailed = errors.length > 0 && uploaded.length === 0 && skipped.length === 0;
    return Response.json({ uploaded, skipped, errors, ...(allFailed ? { error: errors[0].error, code: errors[0].code } : {}) },
      { status: allFailed ? failureStatus : errors.length ? 207 : 200 });
  } catch (error) { return uploadErrorResponse(error); }
}


function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wrapDocxPreviewHtml(bodyHtml: string, fileName: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light; }
  html, body { margin: 0; min-height: 100%; background: #eef1f5; color: #171717; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 28px; }
  main {
    box-sizing: border-box;
    max-width: 840px;
    min-height: calc(100vh - 56px);
    margin: 0 auto;
    padding: 56px 64px;
    background: #fff;
    box-shadow: 0 8px 28px rgba(15, 23, 42, 0.14);
  }
  .file-title {
    margin: 0 0 28px;
    padding-bottom: 10px;
    border-bottom: 1px solid #e5e7eb;
    color: #6b7280;
    font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    word-break: break-word;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.1em 0 0.45em; color: #111827; }
  p { margin: 0.65em 0; line-height: 1.7; }
  table { border-collapse: collapse; max-width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #d1d5db; padding: 6px 9px; vertical-align: top; }
  img { max-width: 100%; height: auto; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  a { color: #2563eb; }
  @media (max-width: 720px) {
    body { padding: 0; background: #fff; }
    main { min-height: 100vh; padding: 28px 22px; box-shadow: none; }
  }
</style>
</head>
<body>
<main>
<div class="file-title">${escapeHtml(fileName)}</div>
${bodyHtml}
</main>
</body>
</html>`;
}

export async function GET(
  request: Request,
  { params, disableIdleTimeout }: { params: Promise<{ path: string[] }>; disableIdleTimeout: () => void }
) {
  try {
    const { path: segments } = await params;
    const { searchParams } = new URL(request.url);
    const type = parseFileRequestType(searchParams.get("type") ?? "list");
    if (!type) return Response.json({ error: "Invalid file request type", code: "invalid_request_type" }, { status: 400 });
    const input = { segments, sessionId: searchParams.get("sessionId") };
    const resolved = await resolveWorkspaceHost(searchParams.get("hostId") ?? undefined, input.sessionId);
    if ("response" in resolved) return resolved.response;
    const { host } = resolved;
    if (type === "list") {
      const result = await host.workspaceOps.listFilesInRoot(input, searchParams.get("root"));
      return result.ok ? Response.json(result.value) : opErrorResponse(result);
    }
    const checked = await host.workspaceOps.fileInfo(input);
    if (!checked.ok) return opErrorResponse(checked);
    const info = checked.value;
    if (info.isDirectory) return Response.json({ error: "Not a file", code: "not_a_file" }, { status: 400 });
    if (type === "meta") return Response.json({ size: info.size, language: info.language, mime: info.mime, previewKind: info.previewKind });
    const image = getImageMime(info.path);
    const audio = getAudioMime(info.path);
    const document = getDocumentMime(info.path);
    if (type === "read" && !image && !audio && !document) {
      const result = await host.workspaceOps.readTextFile(input);
      return result.ok ? Response.json(result.value) : opErrorResponse(result);
    }
    if (type === "preview" && info.previewKind !== "docx") {
      return Response.json({ error: "Preview not available for this file type", code: "preview_unavailable" }, { status: 400 });
    }
    const opened = await host.workspaceOps.openFile(input);
    if (!opened.ok) return opErrorResponse(opened);
    if ((type === "read" && image && opened.value.info.size > IMAGE_PREVIEW_MAX_BYTES)
      || (type === "preview" && opened.value.info.size > DOCX_PREVIEW_MAX_BYTES)) {
      await host.workspaceOps.closeFile(opened.value.id);
      return Response.json({ error: "File too large for preview (>10MB)", code: type === "preview" ? "docx_too_large" : "image_too_large" }, { status: 413 });
    }
    disableIdleTimeout();
    if (type === "preview") {
      const buffer = await readWorkspaceBytes(host, opened.value, DOCX_PREVIEW_MAX_BYTES);
      const result = await mammoth.convertToHtml({ buffer }, { externalFileAccess: false, convertImage: mammoth.images.dataUri });
      return new Response(wrapDocxPreviewHtml(result.value, info.name), { headers: {
        "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache",
        "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
        "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
      } });
    }
    return streamWorkspaceFile(host, opened.value, image ?? audio ?? document ?? "application/octet-stream", request.headers.get("range"), type === "download");
  } catch (error) {
    return apiErrorResponse(error);
  }
}
