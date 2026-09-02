import { NextResponse } from "next/server";
import { closeSync, openSync, readFileSync, readdirSync, readSync, statSync } from "fs";
import * as fsRuntime from "fs";
import { dirname, join } from "path";
import {
  buildSessionTree,
  deleteSessionFileWithArtifacts,
  getLeafEntryId,
  loadSessionFile,
  MAX_SESSION_LOAD_BYTES,
  parseTitleSlotLine,
  readSessionHeaderSync,
  setSessionTitle,
  writeSessionFileAtomicSync,
} from "@/lib/omp/session-files";
import {
  resolveParentSessionId,
  resolveSessionIdByPath,
  resolveSessionPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  buildSessionContext,
  readSessionHeader,
} from "@/lib/session-reader";
import { resolveSessionPathOr404 } from "@/lib/api-utils";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { sessionPathKey } from "@/lib/paths";
import { getRpcSession } from "@/lib/rpc-manager";

/** Stable, client-safe error body for catch-all handlers: details go to the
 *  server log only, never to the browser. */
function sessionsErrorResponse(error: unknown): NextResponse {
  if (error instanceof RequestBodyTooLargeError) {
    return NextResponse.json({ error: "Request body is too large", code: "request_too_large" }, { status: 413 });
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  console.error("[api/sessions]", error);
  return NextResponse.json({ error: "Session request failed", code: "session_request_failed" }, { status: 500 });
}

// BranchNavigator still traverses recursively, so keep the response tree shallow.
const MAX_PROJECTED_TREE_DEPTH = 200;
const MAX_BRANCH_PREVIEW_LENGTH = 40;

function branchPreviewForEntry(entry: { id?: string; type?: string; message?: unknown }): { role?: "user" | "assistant"; text: string } | undefined {
  if (entry.type !== "message" || !entry.message || typeof entry.message !== "object" || Array.isArray(entry.message)) return undefined;
  const message = entry.message as { role?: unknown; content?: unknown };
  let text = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.filter((block): block is { type?: unknown; text?: unknown } => typeof block === "object" && block !== null).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text as string).join(" ")
      : "";
  text = text.replace(/\s+/g, " " ).trim();
  if (text.length > MAX_BRANCH_PREVIEW_LENGTH) text = `${text.slice(0, MAX_BRANCH_PREVIEW_LENGTH)}…`;
  if (!text) text = message.role === "assistant" ? "[assistant]" : "message";
  const role = message.role === "user" || message.role === "assistant" ? message.role : undefined;
  return { ...(role ? { role } : {}), text };
}

/**
 * Project the session tree into the shallow navigation tree sent to the client.
 * Keeps roots, branch points, and leaves while contracting single-child chains
 * without recursive traversal. Contracted entry IDs are attached to the next
 * visible node so the UI can still recognize an active leaf inside the chain.
 */
function projectTreeForResponse<T extends { entry: { id: string }; children: T[]; compressedEntryIds?: string[] }>(
  nodes: T[]
): T[] {
  const keep = new Set<T>();
  const roots = new Set(nodes);
  const seen = new Set<T>();
  const stack = [...nodes];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);

    if (
      roots.has(node) ||
      node.children.length !== 1
    ) {
      keep.add(node);
    }

    for (const child of node.children) {
      stack.push(child);
    }
  }

  const cloneNode = (node: T, compressedEntryIds?: string[], branchPreview?: { role?: "user" | "assistant"; text: string }): T => ({
    ...node,
    children: [],
    ...(compressedEntryIds?.length ? { compressedEntryIds } : {}),
    ...(branchPreview ? { branchPreview } : {}),
  });
  const projectedRoots = nodes.map((node) => cloneNode(node, undefined, branchPreviewForEntry(node.entry)));
  const tasks = nodes.map((source, index) => ({
    source,
    projected: projectedRoots[index],
    depth: 1,
  }));

  const appendFlattenedKeptDescendants = (source: T, projectedParent: T) => {
    const pending = [{ node: source, compressedEntryIds: [] as string[], branchPreview: undefined as { role?: "user" | "assistant"; text: string } | undefined }];
    const flattenedSeen = new Set<T>();

    while (pending.length > 0) {
      const { node, compressedEntryIds, branchPreview } = pending.pop()!;
      if (flattenedSeen.has(node)) continue;
      flattenedSeen.add(node);

      if (keep.has(node)) {
        projectedParent.children.push(cloneNode(node, compressedEntryIds, branchPreview ?? branchPreviewForEntry(node.entry)));
      }

      for (let i = node.children.length - 1; i >= 0; i--) {
        pending.push({
          node: node.children[i],
          compressedEntryIds: keep.has(node)
            ? []
            : [...compressedEntryIds, node.entry.id],
          branchPreview: keep.has(node) ? undefined : (branchPreview ?? branchPreviewForEntry(node.entry)),
        });
      }
    }
  };

  while (tasks.length > 0) {
    const { source, projected, depth } = tasks.pop()!;

    for (const sourceChild of source.children) {
      let child = sourceChild;

      if (depth >= MAX_PROJECTED_TREE_DEPTH) {
        appendFlattenedKeptDescendants(child, projected);
        continue;
      }

      const compressedEntryIds: string[] = [];
      let branchPreview = branchPreviewForEntry(child.entry);
      while (!keep.has(child) && child.children.length === 1) {
        compressedEntryIds.push(child.entry.id);
        child = child.children[0];
        branchPreview ??= branchPreviewForEntry(child.entry);
      }

      if (!keep.has(child)) {
        continue;
      }

      const projectedChild = cloneNode(child, compressedEntryIds, branchPreview);
      projected.children.push(projectedChild);
      tasks.push({ source: child, projected: projectedChild, depth: depth + 1 });
    }
  }

  return projectedRoots;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;

    const searchParams = new URL(req.url).searchParams;
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    const includeState = searchParams.has("includeState");

    const { header, entries, error: loadError } = loadSessionFile(filePath, {
      resolveBlobs: true,
      skipToolResultImages: deferToolResultImages,
    });
    if (loadError === "too_large") {
      return NextResponse.json(
        { error: "Session file is too large to open in omp-web", code: "session_file_too_large" },
        { status: 413 },
      );
    }
    if (!header) {
      return NextResponse.json({ error: "Session file is missing or malformed", code: "session_file_malformed" }, { status: 404 });
    }
    const leafId = getLeafEntryId(entries);
    const tree = projectTreeForResponse(buildSessionTree(entries));
    const context = buildSessionContext(entries, leafId, { deferThinking, deferToolResultImages });

    let modified = header.timestamp ?? new Date().toISOString();
    try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const parentSessionId = header.parentSession
      ? await resolveParentSessionId(header.parentSession)
      : undefined;
    const info = {
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: header.title,
      created: header.timestamp,
      modified,
      messageCount: context.messages.length,
      firstMessage: context.messages.find((m) => m.role === "user")
        ? (() => {
            const msg = context.messages.find((m) => m.role === "user")!;
            const c = (msg as { content: unknown }).content;
            return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
          })()
        : "(no messages)",
      parentSessionId,
    };

    // ?includeState=1 inlines the wrapper's live agent state (same shape as
    // GET /api/agent/[id]) so the client's post-turn refresh is one request
    // instead of two. On a get_state failure the field is omitted entirely —
    // callers treat a missing `agent` as "fetch it separately".
    let agent: { running: boolean; state?: unknown } | undefined;
    if (includeState) {
      const rpc = getRpcSession(id);
      if (rpc?.isAlive()) {
        try {
          agent = { running: true, state: await rpc.send({ type: "get_state" }) };
        } catch {
          // Leave agent unset; the session payload is still valid without it.
        }
      } else {
        agent = { running: false };
      }
    }

    return NextResponse.json({
      sessionId: id,
      filePath,
      info,
      leafId,
      tree,
      context,
      ...(agent ? { agent } : {}),
    });
  } catch (error) {
    return sessionsErrorResponse(error);
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const { name } = await parseJsonWithinLimit<{ name?: string }>(req, 64 * 1024);
    if (typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "name is required", code: "session_name_required" }, { status: 400 });
    }
    // A running omp process owns its session file; route the rename through it
    // so the in-memory title cannot clobber ours on the next flush. This runs
    // before the path check because omp does not create the session file until
    // the history holds an assistant message.
    let renamed = false;
    const rpc = getRpcSession(id);
    if (rpc?.isAlive?.() && typeof rpc.send === "function") {
      try {
        await rpc.send({ type: "set_session_name", name: name.trim() });
        renamed = true;
      } catch {
        // Fall back to the on-disk title slot below.
      }
    }
    if (!renamed) {
      const resolved = await resolveSessionPathOr404(id);
      if ("response" in resolved) return resolved.response;
      const filePath = resolved.filePath;
      setSessionTitle(filePath, name.trim(), "user");
    }
    invalidateSessionListCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return sessionsErrorResponse(error);
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;

    // Read only the bounded header before deleting.
    const deletedHeader = readSessionHeader(filePath);
    const deletedSessionId = deletedHeader?.id ?? id;
    const parentSession = deletedHeader?.parentSession;

    // Children reference their parent either by file path or by bare session id
    // (see resolveParentSessionId), so the grandparent has to be written back in
    // whichever form each child used. Resolve both forms up front.
    let grandparentPath: string | undefined;
    let grandparentId: string | undefined;
    if (parentSession) {
      const idForPath = await resolveSessionIdByPath(parentSession);
      if (idForPath) {
        grandparentPath = parentSession;
        grandparentId = idForPath;
      } else {
        const pathForId = await resolveSessionPath(parentSession);
        if (pathForId) {
          grandparentPath = pathForId;
          grandparentId = parentSession;
        }
      }
    }

    // Re-attach all direct children to this session's parent (cascade re-parent)
    // Scan sibling files in the same directory
    const targetPathKey = sessionPathKey(filePath);
    const dir = dirname(filePath);
    const skippedChildren: Array<{ id: string; reason: string }> = [];
    try {
      const readDirectorySync = Reflect.get(fsRuntime, "readdirSync") as typeof readdirSync;
      const files = readDirectorySync(dir).filter(
        (file) => file.endsWith(".jsonl") && sessionPathKey(join(dir, file)) !== targetPathKey,
      );
      for (const file of files) {
        const childPath = join(dir, file);

        // Re-parenting rewrites the whole child file; a child at/above the
        // load ceiling would cause a huge allocation (RangeError) during the
        // read and a full-file rewrite. Skip it like a live session.
        try {
          if (statSync(childPath).size > MAX_SESSION_LOAD_BYTES) {
            // Report the real session id when the header is readable without
            // loading the whole file (bounded 64KB prefix read).
            let oversizedId = file;
            try {
              const fd = openSync(childPath, "r");
              try {
                const head = Buffer.alloc(64 * 1024);
                const bytes = readSync(fd, head, 0, head.length, 0);
                const lines = head.toString("utf8", 0, bytes).split("\n");
                const headerIndex = parseTitleSlotLine(lines[0] ?? "") ? 1 : 0;
                const parsed = JSON.parse(lines[headerIndex] ?? "{}") as { id?: unknown };
                if (typeof parsed.id === "string") oversizedId = parsed.id;
              } finally {
                closeSync(fd);
              }
            } catch {
              // Header unreadable — fall back to the basename.
            }
            skippedChildren.push({ id: oversizedId, reason: "session_child_too_large" });
            continue;
          }
        } catch {
          continue; // vanished between readdir and stat — not a child we can fix
        }
        const childHeader = readSessionHeaderSync(childPath);
        if (!childHeader || !childHeader.parentSession) continue;
        const linkedByPath = sessionPathKey(childHeader.parentSession) === targetPathKey;
        if (!linkedByPath && childHeader.parentSession !== deletedSessionId) continue;

        // A live omp process owns its session file and flushes its whole
        // in-memory state on write — our rewrite would be clobbered by (or
        // interleaved with) its next flush.
        const childId = childHeader.id;
        if (childId && getRpcSession(childId)?.isAlive?.()) {
          skippedChildren.push({ id: childId, reason: "session_child_live" });
          continue;
        }

        let lines: string[];
        let headerIndex: number;
        let header: { type?: string; id?: string; parentSession?: string };
        try {
          lines = readFileSync(childPath, "utf8").split("\n");
          headerIndex = parseTitleSlotLine(lines[0] ?? "") ? 1 : 0;
          header = JSON.parse(lines[headerIndex]) as typeof header;
        } catch {
          continue;
        }


        // Write the replacement in the same form the child used.
        header.parentSession = linkedByPath
          ? (grandparentPath ?? parentSession)
          : (grandparentId ?? parentSession);
        lines[headerIndex] = JSON.stringify(header);
        try {
          // Atomic: writeFileSync truncates first, so a crash or ENOSPC here
          // would permanently truncate a session the user did NOT delete.
          writeSessionFileAtomicSync(childPath, lines.join("\n"), "reparent");
        } catch {
          skippedChildren.push({ id: childId ?? file, reason: "session_child_rewrite_failed" });
        }
      }
    } catch { /* skip if dir unreadable */ }

    // Await the child's exit before unlinking: omp flushes session state on
    // shutdown and would recreate the file if it were still running.
    await getRpcSession(id)?.destroyAndWait?.();
    deleteSessionFileWithArtifacts(filePath);
    invalidateSessionPathCache(id);
    invalidateSessionListCache();
    return NextResponse.json({
      ok: true,
      ...(skippedChildren.length > 0 ? { skippedChildren } : {}),
    });
  } catch (error) {
    return sessionsErrorResponse(error);
  }
}
