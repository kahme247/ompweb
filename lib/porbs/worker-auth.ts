import { createHash, createHmac, timingSafeEqual } from "crypto";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname } from "path";
import type { HostId } from "./types";

export interface AuthConfig { hostId: HostId; secret: string; noncePath: string; now?: () => number }
export class WorkerAuthenticator {
  private nonces = new Map<string, number>(); private loaded = false; private queue = Promise.resolve();
  private config: AuthConfig;
  constructor(config: AuthConfig) { this.config = config; if (Buffer.byteLength(config.secret) < 32) throw new Error("worker secret must be at least 32 bytes"); }
  private async load() { if (this.loaded) return; try { const value = JSON.parse(await readFile(this.config.noncePath, "utf8")) as { nonces: [string, number][] }; this.nonces = new Map(value.nonces); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } this.loaded = true; }
  private async persist() { await mkdir(dirname(this.config.noncePath), { recursive: true, mode: 0o700 }); const tmp = `${this.config.noncePath}.${process.pid}.tmp`; await writeFile(tmp, JSON.stringify({ version: 1, nonces: [...this.nonces] }), { mode: 0o600 }); await rename(tmp, this.config.noncePath); }
  canonical(method: string, target: string, body: Buffer, timestamp: string, nonce: string, operationId: string) { return ["1", this.config.hostId, method.toUpperCase(), target, "application/json", createHash("sha256").update(body).digest("hex"), timestamp, nonce, operationId].join("\n"); }
  sign(method: string, target: string, body: Buffer, timestamp: string, nonce: string, operationId: string) { return createHmac("sha256", this.config.secret).update(this.canonical(method, target, body, timestamp, nonce, operationId)).digest("hex"); }
  async verify(method: string, target: string, body: Buffer, headers: Headers, operationId: string) {
    const timestamp = headers.get("x-omp-timestamp") ?? "", nonce = headers.get("x-omp-nonce") ?? "", signature = headers.get("x-omp-signature") ?? "", audience = headers.get("x-omp-audience");
    if (audience !== this.config.hostId || !/^[0-9a-f]{32}$/.test(nonce) || !/^\d+$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature)) throw new Error("unauthorized");
    const now = this.config.now?.() ?? Date.now(); if (Math.abs(now - Number(timestamp)) > 60_000) throw new Error("unauthorized");
    const expected = this.sign(method, target, body, timestamp, nonce, operationId); if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error("unauthorized");
    const task = this.queue.then(async () => { await this.load(); for (const [key, seen] of this.nonces) if (now - seen > 60_000) this.nonces.delete(key); if (this.nonces.has(nonce) || this.nonces.size >= 10_000) throw new Error("unauthorized"); this.nonces.set(nonce, now); await this.persist(); });
    this.queue = task.then(() => undefined, () => undefined); await task;
  }
}
