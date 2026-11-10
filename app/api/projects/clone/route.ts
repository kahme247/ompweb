import { join } from "path";
import { cloneDirectoryName } from "@/lib/git-clone";
import { cloneRepository } from "@/lib/project-clone";
import { ProjectPathError, validateProjectPath } from "@/lib/project-registry";

// In-flight clones by client-chosen id, so DELETE can cancel one while its
// POST stream stays open to report the cleanup.
const clones = new Map<string, AbortController>();
const CLONE_ID = /^[A-Za-z0-9-]{1,64}$/;

type CloneFrame =
  | { type: "output"; text: string }
  | { type: "done"; path: string }
  | { type: "cancelled"; path: string }
  | { type: "error"; error: string; code: string };

// POST /api/projects/clone  body: { id, parent, url }
// Clones `url` into `<parent>/<repo name>` and streams NDJSON frames:
// output chunks, then exactly one of done / cancelled / error. The target is
// removed on failure or cancellation (DELETE, or the client disconnecting).
export async function POST(req: Request, { disableIdleTimeout }: { disableIdleTimeout: () => void }) {
  let body: { id?: unknown; parent?: unknown; url?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request", code: "invalid_request" }, { status: 400 });
  }
  const id = typeof body.id === "string" && CLONE_ID.test(body.id) ? body.id : null;
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const name = cloneDirectoryName(url);
  if (!id || clones.has(id)) return Response.json({ error: "Invalid request", code: "invalid_request" }, { status: 400 });
  if (!name) return Response.json({ error: "Enter an https:// or ssh Git URL", code: "invalid_git_url" }, { status: 400 });
  let target: string;
  try {
    target = join(validateProjectPath(typeof body.parent === "string" ? body.parent : ""), name);
  } catch (error) {
    if (error instanceof ProjectPathError) return Response.json({ error: error.message, code: error.code }, { status: 400 });
    throw error;
  }
  // Registered before any await so a cancel sent while the target is being
  // created is not a 404; cloneRepository skips git and cleans up its own target.
  const controller = new AbortController();
  clones.set(id, controller);
  req.signal.addEventListener("abort", () => controller.abort(), { once: true });
  if (req.signal.aborted) controller.abort();
  const encoder = new TextEncoder();
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      streamController = value;
    },
    cancel() {
      controller.abort();
    },
  });
  const send = (frame: CloneFrame) => {
    try {
      streamController.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
    } catch {
      // Client gone; the clone still finishes its cleanup.
    }
  };
  const outputReady = Promise.withResolvers<null>();
  const operation = cloneRepository({
    origin: url,
    target,
    signal: controller.signal,
    onOutput(text) {
      send({ type: "output", text });
      outputReady.resolve(null);
    },
  }).then((result) => {
    clones.delete(id);
    if (result.ok) send({ type: "done", path: result.value.path });
    else if (result.code === "clone_cancelled") send({ type: "cancelled", path: target });
    else send({ type: "error", error: result.error, code: result.code });
    try {
      streamController.close();
    } catch {
      // Already closed by a disconnect.
    }
    return result;
  });
  // The helper owns atomic target acquisition. Wait for output or completion so
  // acquisition conflicts still return HTTP 409 rather than a streamed error.
  const first = await Promise.race([outputReady.promise, operation]);
  if (first && !first.ok && (first.code === "clone_target_exists" || first.code === "clone_target_failed")) {
    return Response.json({ error: first.error, code: first.code }, { status: first.status });
  }
  disableIdleTimeout();
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}

// DELETE /api/projects/clone  body: { id } — cancel an in-flight clone.
export async function DELETE(req: Request) {
  const body = await req.json().catch(() => ({})) as { id?: unknown };
  const controller = typeof body.id === "string" ? clones.get(body.id) : undefined;
  if (!controller) return Response.json({ error: "No clone in progress", code: "clone_not_found" }, { status: 404 });
  controller.abort();
  return Response.json({ ok: true });
}
