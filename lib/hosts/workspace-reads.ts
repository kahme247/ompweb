import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type { WorkspaceFileInfo, WorkspaceRead } from "../workspace-types";
import { HostOpError, LINK_LIMITS } from "./link-protocol";

interface OpenRead { handle: FileHandle; info: WorkspaceFileInfo; timer: NodeJS.Timeout }

export class WorkspaceReads {
  private readonly files = new Map<string, OpenRead>();

  private idle(id: string): NodeJS.Timeout {
    const timer = setTimeout(() => void this.close(id).catch(() => {}), 120_000);
    timer.unref?.();
    return timer;
  }

  add(handle: FileHandle, info: WorkspaceFileInfo): WorkspaceRead {
    const id = randomUUID();
    this.files.set(id, { handle, info, timer: this.idle(id) });
    return { id, info };
  }

  async read(id: string, offset: number, length: number): Promise<Buffer> {
    const file = this.files.get(id);
    if (!file) throw new HostOpError(404, "file_read_missing", "The file read has ended");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1
      || length > LINK_LIMITS.pieceBytes || offset > file.info.size - length) {
      throw new HostOpError(400, "invalid_file_range", "Invalid file read range");
    }
    clearTimeout(file.timer);
    file.timer = this.idle(id);
    const buffer = Buffer.allocUnsafe(length);
    let total = 0;
    while (total < length) {
      const { bytesRead } = await file.handle.read(buffer, total, length - total, offset + total);
      if (bytesRead === 0) throw new HostOpError(409, "file_changed", "The file changed while it was being read");
      total += bytesRead;
    }
    return buffer;
  }

  async close(id: string): Promise<void> {
    const file = this.files.get(id);
    if (!file) return;
    this.files.delete(id);
    clearTimeout(file.timer);
    await file.handle.close();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.files.keys()].map((id) => this.close(id)));
  }
}
