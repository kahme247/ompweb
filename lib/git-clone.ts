// Pure helpers for cloning a repository into a new workspace. Shared by the
// clone route (validation) and the directory picker (target preview, progress).

export type CloneFrame =
  | { type: "output"; text: string }
  | { type: "done"; path: string }
  | { type: "cancelled"; path: string }
  | { type: "error"; error: string; code: string };
export interface CloneProgress { cursor: number; reset: boolean; frames: CloneFrame[]; terminal: boolean }
const HTTPS_URL = /^https:\/\/[^\s/@]+(?:@[^\s/]+)?\/\S+$/;
const SSH_URL = /^ssh:\/\/(?:[^\s/@]+@)?[^\s/]+\/\S+$/;
// scp-like `user@host:path` / `alias:path`. A 2+ char host and no backslashes
// keep Windows paths (`C:/repo`, `C:\repo`) out; `::` transports never match.
const SCP_URL = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]{2,}:(?!:|\/\/)[^\s\\]+$/;
const DIRECTORY_NAME = /^[A-Za-z0-9._-]+$/;

/** Accepts https, ssh:// and scp-like ssh URLs only (no file://, ext::, or
 *  option-looking input); returns the directory name git would clone into,
 *  or null when the URL is unsupported or yields no safe name. */
export function cloneDirectoryName(url: string): string | null {
  const trimmed = url.trim();
  if (!HTTPS_URL.test(trimmed) && !SSH_URL.test(trimmed) && !SCP_URL.test(trimmed)) return null;
  const path = trimmed.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf(":")) + 1).replace(/\.git$/, "");
  return DIRECTORY_NAME.test(name) && name !== "." && name !== ".." ? name : null;
}

const MAX_PROGRESS_LINES = 200;
const MAX_PROGRESS_CHARS = 256 * 1024;

/** Appends git output to the progress log, applying carriage returns (git
 *  rewrites its progress line with `\r`) so the log keeps only each line's
 *  latest state. A trailing `\r` is kept so the next chunk overwrites it. */
export function appendProgress(log: string, chunk: string): string {
  const lines = (log + chunk).split("\n").map((line) => {
    const segments = line.split("\r").filter(Boolean);
    const latest = segments[segments.length - 1] ?? "";
    return line.endsWith("\r") && latest ? `${latest}\r` : latest;
  });
  const bounded = lines.slice(-MAX_PROGRESS_LINES).join("\n").slice(-MAX_PROGRESS_CHARS);
  const first = bounded.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? bounded.slice(1) : bounded;
}
