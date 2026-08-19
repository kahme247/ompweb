import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname } from "path";
import type { HostId, RemoteSessionId, SessionPlacement } from "./types";

export class PlacementStore {
  private placements = new Map<RemoteSessionId, SessionPlacement>();
  private loaded = false;
  private queue = Promise.resolve();
  readonly path: string;
  constructor(path: string) { this.path = path; }
  private async load() {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as { version: 1; placements: SessionPlacement[] };
      if (parsed.version !== 1 || !Array.isArray(parsed.placements)) throw new Error("unsupported placement store");
      for (const p of parsed.placements) if (p.version === 1) this.placements.set(p.sessionId, p);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }
  private async save() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, JSON.stringify({ version: 1, placements: [...this.placements.values()] }), { mode: 0o600 });
    await rename(temp, this.path);
  }
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn); this.queue = result.then(() => undefined, () => undefined); return result;
  }
  async createPending(sessionId: RemoteSessionId, hostId: HostId, workspaceId: string): Promise<SessionPlacement> {
    return this.serialize(async () => { await this.load(); const prior = this.placements.get(sessionId); if (prior) return prior;
      const now = new Date().toISOString(); const value: SessionPlacement = { version: 1, sessionId, hostId, workspaceId, lifecycle: "creating", revision: 1, createdAt: now, updatedAt: now };
      this.placements.set(sessionId, value); await this.save(); return value; });
  }
  async get(id: RemoteSessionId) { await this.load(); return this.placements.get(id); }
  async list() { await this.load(); return [...this.placements.values()]; }
  async compareAndSet(id: RemoteSessionId, revision: number, patch: Partial<Pick<SessionPlacement, "lifecycle">>) {
    return this.serialize(async () => { await this.load(); const old = this.placements.get(id); if (!old || old.revision !== revision) throw new Error("placement_revision_conflict");
      const next = { ...old, ...patch, revision: revision + 1, updatedAt: new Date().toISOString() }; this.placements.set(id, next); await this.save(); return next; });
  }
}
