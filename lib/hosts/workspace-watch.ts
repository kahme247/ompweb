import fs from "node:fs";
import path from "node:path";
import type { WorkspaceFileEvent, WorkspaceFileInfo, WorkspaceFileRequest } from "../workspace-types";
import { HostOpError } from "./link-protocol";

type Watch = { epoch: string; close(): void };
/** Parent-directory watching survives an editor's atomic rename over the file. */
export class WorkspaceWatches {
  private readonly watches = new Map<string, Watch>();
  constructor(private readonly inspect: (input: WorkspaceFileRequest) => Promise<WorkspaceFileInfo>, private readonly emit: (id: string, epoch: string, event: WorkspaceFileEvent) => void) {}

  async watch(id: string, epoch: string, input: WorkspaceFileRequest): Promise<WorkspaceFileInfo> {
    if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(id) || typeof epoch !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(epoch)) throw new HostOpError(400, "invalid_request", "Invalid watch identity");
    this.watches.get(id)?.close();
    let active = true;
    let watcher: fs.FSWatcher | undefined;
    let trailing: NodeJS.Timeout | undefined;
    const watch: Watch = { epoch, close: () => {
      active = false; clearTimeout(trailing); watcher?.close();
      if (this.watches.get(id) === watch) this.watches.delete(id);
    } };
    this.watches.set(id, watch);
    const requireActive = () => { if (!active) throw new HostOpError(409, "watch_closed", "The watch was closed before it started"); };
    try {
      let info = await this.inspect(input);
      requireActive();
      if (info.isDirectory) throw new HostOpError(400, "not_a_file", "Not a file");
      let chain = Promise.resolve();
      const check = () => {
        chain = chain.then(async () => {
          if (!active) return;
          try {
            const next = await this.inspect(input);
            if (!active) return;
            if (next.isDirectory) throw new Error("The file was replaced by a directory");
            if (next.mtimeMs !== info.mtimeMs || next.size !== info.size) {
              info = next;
              this.emit(id, epoch, { type: "change", mtime: new Date(next.mtimeMs).toISOString(), size: next.size });
            }
          } catch {
            if (active) { this.emit(id, epoch, { type: "error", message: "The watched file is unavailable" }); watch.close(); }
          }
        });
      };
      watcher = fs.watch(path.dirname(info.path), (_event, name) => {
        if (name != null && String(name) !== path.basename(info.path)) return;
        check(); clearTimeout(trailing); trailing = setTimeout(check, 50); trailing.unref?.();
      });
      watcher.on("error", () => { if (active) { this.emit(id, epoch, { type: "error", message: "Failed to watch file" }); watch.close(); } });
      info = await this.inspect(input);
      requireActive();
      if (info.isDirectory) throw new HostOpError(400, "not_a_file", "Not a file");
      return info;
    } catch (error) { watch.close(); throw error; }
  }

  unwatch(id: string, epoch: string): void { const watch = this.watches.get(id); if (watch?.epoch === epoch) watch.close(); }
  closeAll(): void { for (const watch of this.watches.values()) watch.close(); }
}
