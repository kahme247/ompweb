// The daemon's saved links, shared by `ompweb host` and local-bootstrap.
// Pure Node: no daemon/spawn code, `next/*` or `@/` imports.
import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, readFileSync, type Stats, unlinkSync, writeFileSync } from "node:fs";
import { type FileHandle, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getAgentDir } from "../omp/paths";
import { isRecord } from "../type-guards";

const loginFile = () => join(getAgentDir(), "omp-web", "host.json");
const trimUrl = (url: string) => url.replace(/\/+$/, "");

export type HostLink = { url: string; token: string };
type SavedLink = HostLink & Record<string, unknown>;
type HostConfig = Record<string, unknown> & { url?: string; token?: string; links?: SavedLink[] };

export const isLoopbackHost = (hostname: string) => hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);

/** Existing configuration must never be confused with a first login. */
export class HostLoginUnreadableError extends Error {
  readonly name = "HostLoginUnreadableError";
}

function normalizeLink(link: HostLink): HostLink {
  const { protocol } = new URL(link.url);
  if (protocol !== "https:" && protocol !== "http:") throw new Error("The server URL must start with https:// or http://");
  const token = link.token.trim();
  if (!token) throw new Error("The host token is empty");
  return { url: trimUrl(link.url), token };
}

function readConfig(): HostConfig {
  const file = loginFile();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new HostLoginUnreadableError(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let saved: unknown;
  try {
    saved = JSON.parse(text);
    if (!isRecord(saved)) throw new Error();
    const checkLink = (link: unknown) => {
      if (!isRecord(link) || typeof link.url !== "string" || typeof link.token !== "string") throw new Error();
      normalizeLink({ url: link.url, token: link.token });
    };
    if ("url" in saved || "token" in saved) checkLink(saved);
    if ("links" in saved) {
      if (!Array.isArray(saved.links)) throw new Error();
      saved.links.forEach(checkLink);
    }
  } catch {
    throw new HostLoginUnreadableError(`${file} is not valid host link configuration`);
  }
  return saved as HostConfig;
}

function configLinks(saved: HostConfig): SavedLink[] {
  return saved.links ?? (saved.url !== undefined && saved.token !== undefined ? [{ url: saved.url, token: saved.token }] : []);
}

/** Only a missing links list falls back to the primary used by older daemons. */
export function readHostLinks(): HostLink[] {
  return configLinks(readConfig()).map(({ url, token }) => ({ url: trimUrl(url), token }));
}

function ownerExited(text: string): boolean {
  const owner: unknown = JSON.parse(text);
  if (!isRecord(owner) || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) return false;
  try {
    process.kill(owner.pid as number, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** A lock's age proves nothing: only ESRCH proves that its owner has exited.
 * Recovery is serialized by an exclusive `.recover` file so it can never unlink a lock a faster recoverer's successor just took. */
function recoverLock(lock: string): void {
  const mutex = `${lock}.recover`;
  try {
    const before = lstatSync(lock);
    if (!before.isFile()) return;
    const text = readFileSync(lock, "utf8");
    if (!ownerExited(text)) return;
    // Published by link(): the mutex never exists without its owner's pid, so a crash cannot leave an unreadable one.
    const temp = `${mutex}.${process.pid}.${randomUUID()}`;
    writeFileSync(temp, JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: "wx" });
    let ours: Stats;
    try {
      ours = lstatSync(temp);
      linkSync(temp, mutex);
    } catch (error) {
      // Another recoverer holds the mutex; only a proven-dead one is displaced.
      if ((error as NodeJS.ErrnoException).code === "EEXIST" && ownerExited(readFileSync(mutex, "utf8"))) unlinkSync(mutex);
      return;
    } finally {
      unlinkSync(temp);
    }
    try {
      const current = lstatSync(lock);
      if (current.dev === before.dev && current.ino === before.ino && readFileSync(lock, "utf8") === text) unlinkSync(lock);
    } finally {
      try {
        const now = lstatSync(mutex);
        if (now.dev === ours.dev && now.ino === ours.ino) unlinkSync(mutex);
      } catch {
        // Already gone.
      }
    }
  } catch {
    // Another writer may have released/recovered it; unreadable ownership is never a stale lock.
  }
}

async function mutateConfig(update: (saved: HostConfig) => void): Promise<void> {
  const file = loginFile();
  const lock = `${file}.lock`;
  await mkdir(dirname(file), { recursive: true });
  const deadline = Date.now() + 5_000;
  let lease: FileHandle;
  for (;;) {
    try {
      lease = await open(lock, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      recoverLock(lock);
      if (Date.now() >= deadline) throw new Error(`Host configuration lock timed out: ${lock}`);
      await sleep(50);
    }
  }
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let failure: { error: unknown } | undefined;
  try {
    await lease.writeFile(JSON.stringify({ pid: process.pid }));
    const saved = readConfig();
    const before = JSON.stringify(saved);
    update(saved);
    if (JSON.stringify(saved) !== before) {
      // Exclusive creation prevents a stale or substituted temp file from widening token permissions.
      const output = await open(temp, "wx", 0o600);
      try {
        await output.writeFile(`${JSON.stringify(saved)}\n`);
      } finally {
        await output.close();
      }
      await rename(temp, file);
    }
  } catch (error) {
    failure = { error };
  }
  // Release never throws mid-way, and a release error never masks the update's own.
  try {
    await rm(temp, { force: true });
  } catch (error) {
    failure ??= { error };
  }
  try {
    const held = await lease.stat();
    const current = lstatSync(lock);
    if (current.dev === held.dev && current.ino === held.ino) unlinkSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") failure ??= { error };
  }
  try {
    await lease.close();
  } catch (error) {
    failure ??= { error };
  }
  if (failure) throw failure.error;
}

/** Upsert one URL, preserving the legacy primary and all other links.
 * Local bootstrap selects/validates its shared token inside the same lock. */
export async function addHostLink(input: HostLink | (() => HostLink)): Promise<void> {
  await mutateConfig((saved) => {
    const link = normalizeLink(typeof input === "function" ? input() : input);
    const links = configLinks(saved);
    const index = links.findIndex(({ url }) => trimUrl(url) === link.url);
    if (index === -1) links.push(link);
    else links[index] = { ...links[index], ...link };
    if (saved.url === undefined || trimUrl(saved.url) === link.url) Object.assign(saved, link); // v6 daemons only read the top-level pair.
    saved.links = links;
  });
}

/** Remove membership only; the legacy primary remains for v6 readers. */
export async function removeHostLink(url: string): Promise<void> {
  await mutateConfig((saved) => {
    saved.links = configLinks(saved).filter((link) => trimUrl(link.url) !== trimUrl(url));
  });
}

/** Replace the primary, retaining secondary links and unknown settings. Tokens never use argv. */
export async function loginHost(input: HostLink): Promise<void> {
  const link = normalizeLink(input);
  await mutateConfig((saved) => {
    const links = configLinks(saved).filter(({ url }) => trimUrl(url) !== trimUrl(saved.url ?? "") || trimUrl(url) === link.url);
    const index = links.findIndex(({ url }) => trimUrl(url) === link.url);
    if (index === -1) links.push(link);
    else links[index] = { ...links[index], ...link };
    Object.assign(saved, link, { links });
  });
}

/** The legacy primary, or null before login or when it cannot be read. */
export function readHostLogin(): HostLink | null {
  try {
    const saved: unknown = JSON.parse(readFileSync(loginFile(), "utf8"));
    if (isRecord(saved) && typeof saved.url === "string" && typeof saved.token === "string") return { url: saved.url, token: saved.token };
  } catch {
    // Retain the legacy reader's tolerant behaviour.
  }
  return null;
}
