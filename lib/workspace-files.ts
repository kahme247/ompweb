// Native filesystem behavior shared by local routes and the authenticated owner daemon.
// No server-only imports or Bun APIs: ompweb host loads this module on Node.
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getConfigAgentRoots, isExistingFilePathAllowed, isProtectedConfigFile, isWindowsAbsolutePath, normalizeSlashes, withFileAccessRoots } from "./file-access";
import { buildEntriesFromFiles, filterFileEntries, parseResultLimit, type FileIndexEntry } from "./file-fuzzy";
import { createChildProcessEnvironment } from "./project-command-env";
import { getGitStatus, getGitFileDiff } from "./git-changes";
import { resolveProject } from "./worktree";
import { isValidSessionId } from "./session-file-references-core";
import { readSessionHeader, resolveSessionPath } from "./session-reader";
import type { OpResult } from "./hosts/session-ops";

const apiErrorResponse = (error: unknown) => Response.json({ error: String(error) }, { status: 500 });
export const WORKSPACE_CHUNK_BYTES = 256 * 1024;

import { getContentDisposition } from "./content-disposition";
import fs from "fs";
import path from "path";
import { getAllowedFileRoots, isFilePathAllowed } from "./file-access";
import { authorizeFileAccess, filePathFromSegments } from "./file-authorization";
import {
  DOCX_PREVIEW_MAX_BYTES,
  IMAGE_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  documentPreviewKind,
  getAudioMime,
  getDocumentMime,
  getFileExt,
  getImageMime,
  getStreamSecurityHeaders,
} from "./file-types";
import { resolveDirentIsDirectory } from "./file-dirent";
import {
  inspectUploadTargets,
  parseUploadConflictStrategy,
  validateUploadFileNames,
} from "./file-upload";
import { parseFormDataWithinLimit, parseJsonWithinLimit, RequestBodyTooLargeError } from "./bounded-form-data";

const IGNORED_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache",
  "target", "vendor", ".DS_Store",
]);

const IGNORED_SUFFIXES = [".pyc"];

const FILE_REQUEST_TYPES = ["list", "read", "download", "meta", "preview"] as const;
type FileRequestType = typeof FILE_REQUEST_TYPES[number];
const FILE_REQUEST_TYPE_SET = new Set<string>(FILE_REQUEST_TYPES);
const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024;
// Multipart boundaries and headers are not file bytes, but must be bounded too.
const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_TOTAL_BYTES + 1024 * 1024;
const MAX_UPLOAD_CHECK_REQUEST_BYTES = 1024 * 1024;

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript", py: "python", rb: "ruby",
  go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
  c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
  html: "html", htm: "html", css: "css", scss: "css", less: "css",
  json: "json", jsonl: "json", yaml: "yaml", yml: "yaml",
  toml: "toml", xml: "xml", md: "markdown", mdx: "markdown",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  sql: "sql", graphql: "graphql", gql: "graphql",
  dockerfile: "dockerfile", tf: "hcl", hcl: "hcl",
  env: "bash", gitignore: "bash", txt: "text",
  pdf: "pdf", docx: "word",
};

function getLanguage(filePath: string): string {
  const base = path.basename(filePath).toLowerCase();
  // Special full-name matches
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === ".env" || base.startsWith(".env.")) return "bash";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  const ext = base.split(".").pop() ?? "";
  return EXT_TO_LANGUAGE[ext] ?? "text";
}

function parseFileRequestType(value: string): FileRequestType | null {
  return FILE_REQUEST_TYPE_SET.has(value) ? (value as FileRequestType) : null;
}

async function getUploadDirectory(segments: string[]): Promise<
  { directory: string } | { response: Response }
> {
  // Strictly absolute: unlike the read path this never fans a relative request
  // out over the allowed roots, which would turn "pick me a directory" into
  // "write anywhere any allowed root points at" (#135).
  const directory = filePathFromSegments(segments);
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(directory, allowedRoots)) {
    return { response: Response.json({ error: "Access denied", code: "access_denied" }, { status: 403 }) };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(directory);
  } catch {
    return { response: Response.json({ error: "Upload directory not found", code: "upload_directory_not_found" }, { status: 404 }) };
  }
  if (!stat.isDirectory()) {
    return { response: Response.json({ error: "Upload target is not a directory", code: "upload_target_not_directory" }, { status: 400 }) };
  }

  // A browsable directory can be a symlink. Resolve both sides before writes
  // so a symlink inside an allowed root cannot redirect uploads outside it.
  const realDirectory = fs.realpathSync(directory);
  const realRoots = new Set<string>();
  for (const root of allowedRoots) {
    try {
      realRoots.add(fs.realpathSync(root));
    } catch {
      // Ignore stale session roots that no longer exist.
    }
  }
  if (!isFilePathAllowed(realDirectory, realRoots)) {
    return { response: Response.json({ error: "Access denied", code: "access_denied" }, { status: 403 }) };
  }

  return { directory: realDirectory };
}

function parseUploadFileNames(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return value;
}

export async function postWorkspaceFiles(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path: segments } = await params;
    const uploadDirectory = await getUploadDirectory(segments);
    if ("response" in uploadDirectory) return uploadDirectory.response;
    const { directory } = uploadDirectory;
    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type") ?? "upload";

    if (type === "upload-check") {
      let body: { fileNames?: unknown } | null;
      try {
        body = await parseJsonWithinLimit<{ fileNames?: unknown }>(request, MAX_UPLOAD_CHECK_REQUEST_BYTES);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) return Response.json({ error: "Upload check request is too large", code: "upload_check_too_large" }, { status: 413 });
        body = null;
      }
      const fileNames = parseUploadFileNames(body?.fileNames);
      if (!fileNames) {
        return Response.json({ error: "fileNames must be an array of strings", code: "invalid_file_names" }, { status: 400 });
      }
      const validationError = validateUploadFileNames(fileNames);
      if (validationError) {
        return Response.json({ error: validationError }, { status: 400 });
      }
      if (fileNames.some((name) => isProtectedConfigFile(path.join(directory, name)))) return Response.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
      return Response.json(inspectUploadTargets(directory, fileNames));
    }

    if (type !== "upload") {
      return Response.json({ error: "Invalid upload request type", code: "invalid_upload_type" }, { status: 400 });
    }

    const strategy = parseUploadConflictStrategy(searchParams.get("conflict"));
    if (!strategy) {
      return Response.json({ error: "Invalid conflict strategy", code: "invalid_conflict_strategy" }, { status: 400 });
    }

    let formData: FormData;
    try {
      formData = await parseFormDataWithinLimit(request, MAX_UPLOAD_REQUEST_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return Response.json({ error: "Uploads must total 100MB or less", code: "upload_total_too_large" }, { status: 413 });
      }
      throw error;
    }
    const files = formData.getAll("files").filter((entry): entry is File => typeof entry !== "string");
    if (files.some((file) => file.size > MAX_UPLOAD_FILE_BYTES)) {
      return Response.json({ error: "Each upload must be 25MB or smaller", code: "upload_file_too_large" }, { status: 413 });
    }
    if (files.reduce((total, file) => total + file.size, 0) > MAX_UPLOAD_TOTAL_BYTES) {
      return Response.json({ error: "Uploads must total 100MB or less", code: "upload_total_too_large" }, { status: 413 });
    }
    const fileNames = files.map((file) => file.name);
    const validationError = validateUploadFileNames(fileNames);
    if (validationError) {
      return Response.json({ error: validationError }, { status: 400 });
    }

    if (fileNames.some((name) => isProtectedConfigFile(path.join(directory, name)))) return Response.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    const inspection = inspectUploadTargets(directory, fileNames);
    if (strategy === "error" && inspection.conflicts.length > 0) {
      return Response.json({
        error: "One or more files already exist",
        code: "upload_conflict",
        conflicts: inspection.conflicts,
        nonReplaceable: inspection.nonReplaceable,
      }, { status: 409 });
    }

    const conflictSet = new Set(inspection.conflicts);
    const nonReplaceableSet = new Set(inspection.nonReplaceable);
    const uploaded: string[] = [];
    const skipped: string[] = [];
    const errors: Array<{ name: string; error: string }> = [];
    const recordError = (file: File, error: unknown) => {
      errors.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
    };

    for (const file of files) {
      const destination = path.join(directory, file.name);
      if (conflictSet.has(file.name) && strategy === "skip") {
        skipped.push(file.name);
        continue;
      }
      if (conflictSet.has(file.name) && nonReplaceableSet.has(file.name)) {
        errors.push({ name: file.name, error: "Cannot replace a directory or symbolic link" });
        continue;
      }

      let bytes: Buffer;
      try {
        bytes = Buffer.from(await file.arrayBuffer());
      } catch (error) {
        recordError(file, error);
        continue;
      }
      if (request.signal.aborted) throw new Error("The file request was cancelled");

      if (conflictSet.has(file.name)) {
        try {
          fs.unlinkSync(destination);
        } catch (error) {
          recordError(file, error);
          continue;
        }
      }

      try {
        fs.writeFileSync(destination, bytes, { flag: "wx" });
        uploaded.push(file.name);
      } catch (error) {
        recordError(file, error);
      }
    }

    return Response.json(
      { uploaded, skipped, errors },
      { status: errors.length > 0 ? 207 : 200 },
    );
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

function createFileBodyStream(filePath: string, range?: { start: number; end: number }): ReadableStream<Uint8Array> {
  const fd = fs.openSync(filePath, "r");
  let position = range?.start ?? 0;
  let closed = false;
  const close = () => { if (!closed) { closed = true; fs.closeSync(fd); } };
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (closed) return;
      try {
        const remaining = range ? range.end - position + 1 : WORKSPACE_CHUNK_BYTES;
        if (remaining <= 0) { close(); controller.close(); return; }
        const bytes = Buffer.allocUnsafe(Math.min(WORKSPACE_CHUNK_BYTES, remaining));
        const count = fs.readSync(fd, bytes, 0, bytes.length, position);
        if (count === 0) { close(); controller.close(); return; }
        position += count;
        controller.enqueue(bytes.subarray(0, count));
      } catch (error) { close(); controller.error(error); }
    },
    cancel: close,
  }, { highWaterMark: 0 });
}

function streamFile(filePath: string, stat: fs.Stats, contentType: string, rangeHeader: string | null, asDownload = false): Response {
  const headers = {
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
    "Accept-Ranges": "bytes",
    "Content-Disposition": getContentDisposition(path.basename(filePath), !asDownload, "download"),
    // Shared by the full-body, 206, and 416 paths below.
    ...getStreamSecurityHeaders(contentType),
  };

  if (!rangeHeader) {
    return new Response(stat.size === 0 ? null : createFileBodyStream(filePath), {
      headers: {
        ...headers,
        "Content-Length": String(stat.size),
      },
    });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) {
    return new Response(null, {
      status: 416,
      headers: {
        ...headers,
        "Content-Range": `bytes */${stat.size}`,
      },
    });
  }

  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : stat.size - 1;
  if (!match[1] && match[2]) {
    const suffixLength = Number(match[2]);
    start = Math.max(stat.size - suffixLength, 0);
    end = stat.size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= stat.size) {
    return new Response(null, {
      status: 416,
      headers: {
        ...headers,
        "Content-Range": `bytes */${stat.size}`,
      },
    });
  }

  end = Math.min(end, stat.size - 1);
  const chunkSize = end - start + 1;
  return new Response(createFileBodyStream(filePath, { start, end }), {
    status: 206,
    headers: {
      ...headers,
      "Content-Length": String(chunkSize),
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
    },
  });
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

export async function getWorkspaceFiles(
  request: Request,
  { params, disableIdleTimeout }: { params: Promise<{ path: string[] }>; disableIdleTimeout: () => void }
) {
  try {
    const { path: segments } = await params;
    const { searchParams } = new URL(request.url);
    const rawType = searchParams.get("type") ?? "list";
    const type = parseFileRequestType(rawType);
    if (!type) {
      return Response.json({ error: "Invalid file request type", code: "invalid_request_type" }, { status: 400 });
    }
    const sessionId = searchParams.get("sessionId");
    // The explorer's "Show hidden items" toggle: for `type=list` only, skip the
    // IGNORED_NAMES/IGNORED_SUFFIXES skip-list so build/ and friends can be
    // browsed. Everything else (reads, downloads) never applied it anyway.
    const showHidden = searchParams.get("hidden") === "1";

    const access = await authorizeFileAccess(segments, sessionId, type !== "list");
    if (!access.ok) {
      return Response.json({ error: access.error, code: access.code }, { status: access.status });
    }
    const { filePath, stat } = access;
    // A paused media element stops reading its stream, which Bun's idle timeout would cut. Lifted once the stream exists.
    const stream = (contentType: string, asDownload = false) => {
      const response = streamFile(filePath, stat, contentType, request.headers.get("range"), asDownload);
      disableIdleTimeout();
      return response;
    };

    if (type === "read") {
      if (!stat.isFile()) {
        return Response.json({ error: "Not a file", code: "not_a_file" }, { status: 400 });
      }
      const imageMime = getImageMime(filePath);
      if (imageMime) {
        if (stat.size > IMAGE_PREVIEW_MAX_BYTES) {
          return Response.json({ error: "Image too large (>10MB)", code: "image_too_large" }, { status: 413 });
        }
        return stream(imageMime);
      }
      const audioMime = getAudioMime(filePath);
      if (audioMime) {
        return stream(audioMime);
      }
      const documentMime = getDocumentMime(filePath);
      if (documentMime) {
        return stream(documentMime);
      }
      if (stat.size > TEXT_PREVIEW_MAX_BYTES) {
        return Response.json({ error: "File too large for preview (>256KB)", code: "file_too_large_preview" }, { status: 413 });
      }
      const content = fs.readFileSync(filePath, "utf-8");
      const language = getLanguage(filePath);
      return Response.json({ content, language, size: stat.size });
    }

    if (type === "download") {
      if (!stat.isFile()) {
        return Response.json({ error: "Not a file", code: "not_a_file" }, { status: 400 });
      }
      const mime = getImageMime(filePath) || getAudioMime(filePath) || getDocumentMime(filePath) || "application/octet-stream";
      return stream(mime, true);
    }

    if (type === "meta") {
      if (!stat.isFile()) {
        return Response.json({ error: "Not a file", code: "not_a_file" }, { status: 400 });
      }
      const imageMime = getImageMime(filePath);
      const audioMime = getAudioMime(filePath);
      const documentMime = getDocumentMime(filePath);
      return Response.json({
        size: stat.size,
        language: getLanguage(filePath),
        mime: imageMime || audioMime || documentMime || "text/plain",
        previewKind: documentPreviewKind(filePath),
      });
    }

    if (type === "preview") {
      if (!stat.isFile()) {
        return Response.json({ error: "Not a file", code: "not_a_file" }, { status: 400 });
      }
      if (getFileExt(filePath) !== "docx") {
        return Response.json({ error: "Preview not available for this file type", code: "preview_unavailable" }, { status: 400 });
      }
      if (stat.size > DOCX_PREVIEW_MAX_BYTES) {
        return Response.json({ error: "DOCX too large for preview (>10MB)", code: "docx_too_large" }, { status: 413 });
      }

      const mammoth = await import("mammoth");
      const result = await mammoth.convertToHtml(
        { path: filePath },
        {
          externalFileAccess: false,
          convertImage: mammoth.images.dataUri,
        }
      );
      const html = wrapDocxPreviewHtml(result.value, path.basename(filePath));
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
          "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    // type === "list"
    if (!stat.isDirectory()) {
      return Response.json({ error: "Not a directory", code: "not_a_directory" }, { status: 400 });
    }

    // Avoid per-entry stat calls for normal files and directories. Symlinks and
    // filesystems without directory type information use the stat fallback.
    const readDirectorySync = Reflect.get(fs, "readdirSync") as typeof fs.readdirSync;
    const dirents = readDirectorySync(filePath, { withFileTypes: true });
    const entries = dirents
      .filter((d) => showHidden || (!IGNORED_NAMES.has(d.name) && !IGNORED_SUFFIXES.some((s) => d.name.endsWith(s))))
      .flatMap((d) => {
        const isDir = resolveDirentIsDirectory(d, path.join(filePath, d.name));
        return isDir === null
          ? []
          : [{ name: d.name, isDir, size: 0, modified: "" }];
      })
      .sort((a, b) => {
        // Dirs first, then files, both alphabetically
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return Response.json({ entries, path: filePath });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

const execFileAsync = promisify(execFile);

/** Cap on the plain (no-query) response used as the client-side index */
const MAX_FILES = 5000;
/** Hard caps on the full in-memory listing that ?q= searches against */
const GIT_HARD_CAP = 200_000;
const WALK_HARD_CAP = 50_000;
const MAX_WALK_DEPTH = 8;
const MAX_QUERY_LENGTH = 500;
const CACHE_TTL_MS = 10_000;
const CACHE_MAX_ENTRIES = 20;

interface FileListing {
  /** Full listing up to the hard cap (not the client cap) */
  files: string[];
  /** True when even the hard cap was exceeded */
  hardTruncated: boolean;
}

interface CacheEntry {
  listing: FileListing;
  /** Derived lazily on the first ?q= search against this listing */
  entries?: FileIndexEntry[];
  /** Same, restricted to files, for callers that never show directories */
  fileEntries?: FileIndexEntry[];
  expiresAt: number;
}

// Per-cwd cache on globalThis so it survives a `bun --hot` re-evaluation; the @ menu
// re-requests on every open and searches on every keystroke, so listings must
// not be recomputed within a short window.
declare global {
  var __piFileIndexCache: Map<string, CacheEntry> | undefined;
  var __piFileIndexPending: Map<string, Promise<FileListing>> | undefined;
}

function getIndexCache(): Map<string, CacheEntry> {
  if (!globalThis.__piFileIndexCache) globalThis.__piFileIndexCache = new Map();
  return globalThis.__piFileIndexCache;
}

/**
 * Build the listing for one cwd, collapsing concurrent callers onto the same
 * scan. Without this, several refreshes in flight would each run `git ls-files`
 * and the slowest one could overwrite a newer cache entry.
 */
function loadListing(cwd: string): Promise<FileListing> {
  if (!globalThis.__piFileIndexPending) globalThis.__piFileIndexPending = new Map();
  const pending = globalThis.__piFileIndexPending;
  const inFlight = pending.get(cwd);
  if (inFlight) return inFlight;
  const scan = (async () => (await listWithGit(cwd)) ?? listWithWalk(cwd))()
    .finally(() => { pending.delete(cwd); });
  pending.set(cwd, scan);
  return scan;
}

async function listWithGit(cwd: string): Promise<FileListing | null> {
  try {
    const gitOptions = {
      timeout: 10_000,
      maxBuffer: 64 * 1024 * 1024,
      env: createChildProcessEnvironment({ LC_ALL: "C" }),
    };
    // --cached lists index entries, including files already removed from the
    // working tree. Those would show up as results that 404 the moment anyone
    // opens them, so subtract what git reports as deleted. That query is
    // auxiliary: a stale-but-complete listing beats throwing away the git
    // listing over it, which would fall back to the depth-capped readdir walk.
    const [listed, deleted] = await Promise.all([
      execFileAsync("git", ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], gitOptions),
      execFileAsync("git", ["-C", cwd, "ls-files", "--deleted", "-z"], gitOptions).catch(() => null),
    ]);
    const missing = new Set((deleted?.stdout ?? "").split("\0").filter(Boolean));
    const all = listed.stdout.split("\0").filter((file) => file && !missing.has(file));
    if (all.length > GIT_HARD_CAP) {
      return { files: all.slice(0, GIT_HARD_CAP), hardTruncated: true };
    }
    return { files: all, hardTruncated: false };
  } catch {
    // Not a git repo (or git unavailable) — caller falls back to readdir walk.
    return null;
  }
}

function listWithWalk(cwd: string): FileListing {
  const files: string[] = [];
  const readDirectorySync = Reflect.get(fs, "readdirSync") as typeof fs.readdirSync;
  // BFS so shallow files win when the cap truncates the listing.
  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: cwd, rel: "", depth: 0 }];
  let head = 0;
  while (head < queue.length) {
    const { abs, rel, depth } = queue[head++]!;
    let dirents: fs.Dirent[];
    try {
      dirents = readDirectorySync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (IGNORED_NAMES.has(d.name) || IGNORED_SUFFIXES.some((s) => d.name.endsWith(s))) continue;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (depth + 1 <= MAX_WALK_DEPTH) {
          queue.push({ abs: path.join(abs, d.name), rel: childRel, depth: depth + 1 });
        }
      } else if (d.isFile()) {
        if (files.length >= WALK_HARD_CAP) {
          return { files, hardTruncated: true };
        }
        files.push(childRel);
      }
    }
  }
  return { files, hardTruncated: false };
}

// GET /api/file-index?cwd=/abs/path[&q=query][&limit=n][&kind=file][&refresh=1]
// Without q: { files: string[] (relative to cwd, capped at MAX_FILES),
// truncated: boolean } — the client-side index for local filtering.
// With q: { matches: { path, isDir }[] } — ranked against the FULL listing so
// repos larger than MAX_FILES still find deep files (cap applied after
// matching, like the TUI passing the query to fd). limit defaults to the `@`
// menu size and is clamped to MAX_RESULT_LIMIT; kind=file drops directories
// before ranking and reports a `truncated` flag; refresh=1 rebuilds the listing
// instead of using the TTL cache, for the explorer's refresh button.
// Guarded by the same allow-list as /api/files.
export async function getWorkspaceIndex(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const cwd = searchParams.get("cwd")?.trim() ?? "";
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return Response.json({ error: "cwd must be an absolute path", code: "cwd_must_be_absolute" }, { status: 400 });
    }
    const query = searchParams.get("q")?.slice(0, MAX_QUERY_LENGTH) ?? "";

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots)) {
      return Response.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      return Response.json({ error: "Directory not found", code: "directory_not_found" }, { status: 404 });
    }
    if (!stat.isDirectory()) {
      return Response.json({ error: "Not a directory", code: "not_a_directory" }, { status: 400 });
    }
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return Response.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }

    const cache = getIndexCache();
    const now = Date.now();
    // An explicit refresh in the UI must not be answered from the TTL window,
    // or a file the agent just wrote stays invisible. loadListing collapses
    // concurrent rebuilds onto one scan, which is the whole bound: an age gate
    // on top of it can only suppress the refresh the user actually asked for.
    const forceRefresh = searchParams.get("refresh") === "1";
    let cached = cache.get(cwd);
    if (!cached || cached.expiresAt <= now || forceRefresh) {
      const listing = await loadListing(cwd);
      for (const [key, entry] of cache) {
        if (entry.expiresAt <= now) cache.delete(key);
      }
      // Replacing an existing key does not grow the cache, so it must not wipe
      // the listings of unrelated projects.
      if (!cache.has(cwd) && cache.size >= CACHE_MAX_ENTRIES) cache.clear();
      // Timed after the scan, not from `now`: a large repo can take longer to
      // list than the whole TTL, which would store an already-expired entry.
      cached = { listing, expiresAt: Date.now() + CACHE_TTL_MS };
      cache.set(cwd, cached);
    }

    if (query) {
      const limit = parseResultLimit(searchParams.get("limit"));
      cached.entries ??= buildEntriesFromFiles(cached.listing.files);
      // Directories score a ranking bonus, so a caller that only renders files
      // must drop them before the limit is applied: "api" in this repo matches
      // 67 directories, which would otherwise consume half the budget and
      // silently push matching files out of the response.
      if (searchParams.get("kind") === "file") {
        cached.fileEntries ??= cached.entries.filter((entry) => !entry.isDir);
        // Ask for one past the limit: the extra row never ships, it only tells
        // the panel that the list it shows is incomplete. A listing that hit the
        // hard cap is incomplete the same way, and is worth reporting even
        // though fewer than `limit` rows matched what survived.
        const ranked = filterFileEntries(cached.fileEntries, query, limit + 1);
        const truncated = ranked.length > limit || cached.listing.hardTruncated;
        return Response.json({
          matches: truncated ? ranked.slice(0, limit) : ranked,
          truncated,
        });
      }
      return Response.json({ matches: filterFileEntries(cached.entries, query, limit) });
    }

    const { files, hardTruncated } = cached.listing;
    return Response.json({
      files: files.slice(0, MAX_FILES),
      truncated: hardTruncated || files.length > MAX_FILES,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function getWorkspaceGitStatus(request: Request) {
  try {
    const cwd = new URL(request.url).searchParams.get("cwd")?.trim() ?? "";
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return Response.json({ error: "cwd must be an absolute path", code: "cwd_must_be_absolute" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots)) {
      return Response.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      return Response.json({ error: "Directory not found", code: "directory_not_found" }, { status: 404 });
    }
    if (!stat.isDirectory()) {
      return Response.json({ error: "Not a directory", code: "not_a_directory" }, { status: 400 });
    }
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return Response.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }

    return Response.json(await getGitStatus(cwd));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function getWorkspaceGitDiff(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const cwd = searchParams.get("cwd")?.trim() ?? "";
    const filePath = searchParams.get("path")?.trim() ?? "";
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return Response.json({ error: "cwd must be an absolute path", code: "cwd_must_be_absolute" }, { status: 400 });
    }
    if (!filePath || (!filePath.startsWith("/") && !isWindowsAbsolutePath(filePath))) {
      return Response.json({ error: "path must be an absolute path", code: "path_must_be_absolute" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots) || !isFilePathAllowed(filePath, allowedRoots) || isProtectedConfigFile(filePath)) {
      return Response.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }
    if (!isExistingFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(filePath, allowedRoots)) {
      return Response.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }

    return Response.json(await getGitFileDiff(cwd, filePath));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export interface WorkspaceContext { sessionId: string; cwd: string; projectRoot?: string }
export interface WorkspaceRequest {
  context: WorkspaceContext;
  kind: "files" | "index" | "git-status" | "git-diff";
  url: string;
  method: "GET" | "POST";
  segments?: string[];
  headers?: Record<string, string>;
  jsonBody?: string;
  bodyUploadId?: string;
}
export interface WorkspaceResponse { status: number; headers: Array<[string, string]>; readId: string | null }
export interface WorkspaceChange { type: "change"; mtime: string; size: number }
interface WorkspaceRead {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  pending?: Uint8Array;
  busy: boolean;
  holdsFile: boolean;
}
interface WorkspaceWatch {
  watcher: fs.FSWatcher;
  trailing?: NodeJS.Timeout;
  change: WorkspaceChange | null;
  wake?: () => void;
}
const workspaceReads = new Map<string, WorkspaceRead>();
const workspaceWatches = new Map<string, WorkspaceWatch>();
let workspaceEpoch = 0;
let workspaceAbort = new AbortController();

async function ownerRoots(context: WorkspaceContext): Promise<Set<string>> {
  if (!context || !isValidSessionId(context.sessionId) || typeof context.cwd !== "string"
    || context.cwd.includes("\0") || !path.isAbsolute(context.cwd)) throw new Error("Invalid owner workspace");
  const sessionPath = await resolveSessionPath(context.sessionId);
  const cwd = (sessionPath ? readSessionHeader(sessionPath)?.cwd : undefined) || context.cwd;
  if (!path.isAbsolute(cwd) || cwd.includes("\0")) throw new Error("Invalid native session workspace");
  const roots = new Set([normalizeSlashes(cwd)]);
  const project = await resolveProject(cwd);
  roots.add(normalizeSlashes(project.projectRoot));
  for (const root of getConfigAgentRoots()) roots.add(root);
  return roots;
}

/** The same native handlers run locally and on the owning daemon. */
export async function runWorkspaceRequest(input: WorkspaceRequest, body?: Uint8Array<ArrayBuffer>): Promise<OpResult<WorkspaceResponse>> {
  const epoch = workspaceEpoch;
  const signal = workspaceAbort.signal;
  if (!input || !["files", "index", "git-status", "git-diff"].includes(input.kind)
    || !["GET", "POST"].includes(input.method) || typeof input.url !== "string" || input.url.length > 65536
    || (input.segments !== undefined && (!Array.isArray(input.segments) || !input.segments.every((part) => typeof part === "string")))
    || (input.jsonBody !== undefined && (typeof input.jsonBody !== "string" || Buffer.byteLength(input.jsonBody) > 1024 * 1024))) {
    return { ok: false, status: 400, code: "invalid_request", error: "Invalid workspace request" };
  }
  const roots = await ownerRoots(input.context);
  if (epoch !== workspaceEpoch) return { ok: false, status: 503, code: "host_offline", error: "The owner link closed" };
  const response = await withFileAccessRoots(roots, async () => {
    const request = new Request(input.url, { method: input.method, headers: input.headers, signal, ...(input.method === "POST" ? { body: body ?? input.jsonBody ?? "" } : {}) });
    if (input.kind === "files") {
      const context = { params: Promise.resolve({ path: input.segments ?? [] }), disableIdleTimeout() {} };
      return input.method === "POST" ? postWorkspaceFiles(request, context) : getWorkspaceFiles(request, context);
    }
    if (input.method !== "GET") return Response.json({ error: "Invalid request", code: "invalid_request" }, { status: 400 });
    if (input.kind === "index") return getWorkspaceIndex(request);
    if (input.kind === "git-status") return getWorkspaceGitStatus(request);
    return getWorkspaceGitDiff(request);
  });
  if (epoch !== workspaceEpoch) {
    await response.body?.cancel();
    return { ok: false, status: 503, code: "host_offline", error: "The owner link closed" };
  }
  const readId = response.body ? randomUUID() : null;
  // Only streamed files retain a native fd; JSON/HTML bodies are already materialized.
  if (readId) workspaceReads.set(readId, { reader: response.body!.getReader(), busy: false, holdsFile: response.headers.has("accept-ranges") });
  return { ok: true, value: { status: response.status, headers: [...response.headers.entries()], readId } };
}

export async function readWorkspaceBody(id: string): Promise<OpResult<Uint8Array | null>> {
  const entry = workspaceReads.get(id);
  if (!entry) return { ok: false, status: 410, code: "workspace_read_closed", error: "The file read is closed" };
  if (entry.busy) return { ok: false, status: 409, code: "workspace_read_busy", error: "The file is already being read" };
  entry.busy = true;
  try {
    if (!entry.pending?.byteLength) {
      const next = await entry.reader.read();
      if (next.done) {
        await closeWorkspaceBody(id);
        return { ok: true, value: null };
      }
      entry.pending = next.value;
    }
    const bytes = entry.pending.subarray(0, WORKSPACE_CHUNK_BYTES);
    entry.pending = entry.pending.subarray(bytes.byteLength);
    return { ok: true, value: bytes };
  } catch (error) {
    await closeWorkspaceBody(id);
    throw error;
  } finally { entry.busy = false; }
}

export async function closeWorkspaceBody(id: string): Promise<OpResult<null>> {
  const entry = workspaceReads.get(id);
  workspaceReads.delete(id);
  if (entry) await entry.reader.cancel().catch(() => {});
  return { ok: true, value: null };
}

export async function openWorkspaceWatch(context: WorkspaceContext, rawPath: string): Promise<OpResult<{ id: string; filePath: string }>> {
  const epoch = workspaceEpoch;
  const roots = await ownerRoots(context);
  const access = await withFileAccessRoots(roots, () => authorizeFileAccess(rawPath.replace(/\\/g, "/").replace(/^\/+/, "").split("/"), context.sessionId, true));
  if (!access.ok) return { ok: false, status: access.status, code: access.code, error: access.error };
  if (!access.stat.isFile()) return { ok: false, status: 400, code: "not_a_file", error: "Not a file" };
  if (epoch !== workspaceEpoch) return { ok: false, status: 503, code: "host_offline", error: "The owner link closed" };
  const id = randomUUID();
  let lastMtime = access.stat.mtimeMs;
  let lastSize = access.stat.size;
  const check = () => {
    let size = -1;
    let mtime = new Date();
    let mtimeMs = -1;
    try {
      const stat = fs.statSync(access.filePath);
      size = stat.size; mtime = stat.mtime; mtimeMs = stat.mtimeMs;
    } catch { /* Report a removed file once. */ }
    if (size === lastSize && mtimeMs === lastMtime) return;
    lastSize = size; lastMtime = mtimeMs;
    const watch = workspaceWatches.get(id);
    if (!watch) return;
    watch.change = { type: "change", mtime: mtime.toISOString(), size: Math.max(0, size) };
    watch.wake?.();
  };
  const watcher = fs.watch(access.filePath, () => {
    check();
    const watch = workspaceWatches.get(id);
    if (watch) { clearTimeout(watch.trailing); watch.trailing = setTimeout(check, 50); }
  });
  workspaceWatches.set(id, { watcher, change: null });
  watcher.on("error", () => { void closeWorkspaceWatch(id); });
  return { ok: true, value: { id, filePath: access.filePath } };
}

export async function pollWorkspaceWatch(id: string): Promise<OpResult<WorkspaceChange | null>> {
  const watch = workspaceWatches.get(id);
  if (!watch) return { ok: false, status: 410, code: "workspace_watch_closed", error: "The file watch is closed" };
  if (!watch.change) {
    const gate = Promise.withResolvers<void>();
    const timer = setTimeout(() => { watch.wake = undefined; gate.resolve(); }, 1000);
    watch.wake = () => { clearTimeout(timer); watch.wake = undefined; gate.resolve(); };
    await gate.promise;
  }
  const change = watch.change;
  watch.change = null;
  return { ok: true, value: change };
}

export async function closeWorkspaceWatch(id: string): Promise<OpResult<null>> {
  const watch = workspaceWatches.get(id);
  workspaceWatches.delete(id);
  if (watch) { clearTimeout(watch.trailing); watch.watcher.close(); watch.wake?.(); }
  return { ok: true, value: null };
}

export function workspaceReadsBusy(): boolean {
  for (const read of workspaceReads.values()) if (read.holdsFile) return true;
  return false;
}

/** Link loss invalidates late opens as well as all existing native resources. */
export function resetWorkspaceResources(): void {
  workspaceEpoch++;
  workspaceAbort.abort();
  workspaceAbort = new AbortController();
  for (const id of workspaceReads.keys()) void closeWorkspaceBody(id);
  for (const id of workspaceWatches.keys()) void closeWorkspaceWatch(id);
}
