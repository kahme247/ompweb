// The daemon's saved link (`<agent dir>/omp-web/host.json`), shared by `ompweb host`
// and the web server (local-bootstrap): no daemon or spawn code, no `next/*` or `@/` imports.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../omp/paths";
import { isRecord } from "../type-guards";

const loginFile = () => join(getAgentDir(), "omp-web", "host.json");

export const isLoopbackHost = (hostname: string) => hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);

/** Save the server URL and host token, owner-only. The token never goes through argv. */
export function loginHost(options: { url: string; token: string }): void {
  const { protocol } = new URL(options.url);
  if (protocol !== "https:" && protocol !== "http:") throw new Error("The server URL must start with https:// or http://");
  const token = options.token.trim();
  if (!token) throw new Error("The host token is empty");
  const file = loginFile();
  mkdirSync(dirname(file), { recursive: true });
  // A fresh 0600 file renamed into place: the token never sits in a wider-mode file.
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ url: options.url.replace(/\/+$/, ""), token })}\n`, { mode: 0o600 });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** What `loginHost` saved, or null before the first login. */
export function readHostLogin(): { url: string; token: string } | null {
  try {
    const saved: unknown = JSON.parse(readFileSync(loginFile(), "utf8"));
    if (isRecord(saved) && typeof saved.url === "string" && typeof saved.token === "string") return { url: saved.url, token: saved.token };
  } catch {
    // Missing or unreadable: not logged in.
  }
  return null;
}
