import { apiErrorResponse } from "@/lib/api-utils";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { getSessionsDir, getSessionDirNameForCwd } from "@/lib/omp/paths";
import { invalidateLocalSessionLists } from "@/lib/hosts/session-index";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { invalidateSessionFileListCache } from "@/lib/omp/session-files";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

// JSON escapes a session's newlines and quotes on the wire. Bound the request
// separately while preserving the 10 MB limit for decoded session content.
const MAX_IMPORT_REQUEST_BYTES = MAX_IMPORT_BYTES * 2 + 64 * 1024;

/** omp session file timestamps: ISO-8601 with `:` and `.` replaced by `-`. */
function isoSessionTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// POST /api/sessions/import — import a native omp session .jsonl file.
// The session keeps its original entries but can only target a workspace the
// user previously authorized through projects, sessions, or cwd selection.
export async function POST(req: Request) {
  try {
    const body = await parseJsonWithinLimit<{ fileName?: unknown; content?: unknown }>(req, MAX_IMPORT_REQUEST_BYTES);
    const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
    const content = typeof body.content === "string" ? body.content : "";
    if (!fileName || fileName.includes("/") || fileName.includes("\\")) {
      return Response.json({ error: "Invalid file name", code: "invalid_file_name" }, { status: 400 });
    }
    if (!content.trim()) {
      return Response.json({ error: "Empty session file", code: "empty_session_file" }, { status: 400 });
    }
    if (Buffer.byteLength(content, "utf8") > MAX_IMPORT_BYTES) {
      return Response.json({ error: "Session file is too large (max 10 MB)", code: "session_file_too_large" }, { status: 400 });
    }

    // Every line must parse as a JSON object, and one of them must be the
    // session header carrying the cwd the file belongs to. The header id is
    // rewritten to a fresh uuid: the id→path caches key on session id, so an
    // imported copy of an existing session must never keep the source id
    // (otherwise opening/deleting the import would hit the original file).
    const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
    let cwd: string | undefined;
    const freshId = randomUUID();
    const rewritten = lines.map((line) => {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        return null;
      }
      if (entry && typeof entry === "object") {
        const record = entry as { type?: unknown; cwd?: unknown; message?: unknown };
        if (record.type === "session" && typeof record.cwd === "string") cwd = record.cwd;
        if (record.type === "session") {
          return JSON.stringify({ ...record, id: freshId });
        }
        // Imported bashExecution entries must not carry fullOutputPath: the
        // bash-output route authorizes tmpdir files only when the session
        // references them, and an imported file could otherwise forge a
        // reference to any pi-bash-*.log (the referenced temp file never
        // survives an import anyway).
        if (record.type === "message") {
          const message = record.message;
          if (message && typeof message === "object" && (message as { role?: unknown }).role === "bashExecution") {
            const safeMessage = { ...message as Record<string, unknown> };
            delete safeMessage.fullOutputPath;
            return JSON.stringify({ ...record, message: safeMessage });
          }
        }
      }
      return line;
    });
    if (rewritten.some((line) => line === null)) {
      return Response.json({ error: "Not a valid omp session file (malformed JSON line)", code: "invalid_session_file" }, { status: 400 });
    }
    if (!cwd) {
      return Response.json({ error: "Not a valid omp session file (missing session header with cwd)", code: "invalid_session_file" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return Response.json({ error: "Imported session workspace is not authorized", code: "import_cwd_not_authorized" }, { status: 403 });
    }

    const sessionDir = path.join(getSessionsDir(), getSessionDirNameForCwd(cwd));
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, `${isoSessionTimestamp()}_${randomUUID()}.jsonl`);
    writeFileSync(sessionFile, rewritten.join("\n") + "\n", "utf8");

    // New session must appear immediately: clear both the list cache and the
    // mtime-keyed walk cache (the AGENTS.md-documented Windows/NTFS trap).
    invalidateSessionListCache();
    invalidateSessionFileListCache();
    // The sidebar lists this machine's sessions through its daemon.
    invalidateLocalSessionLists();

    return Response.json({ success: true, sessionFile });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json({ error: "Session import request is too large", code: "session_import_request_too_large" }, { status: 413 });
    }
    return apiErrorResponse(error);
  }
}
