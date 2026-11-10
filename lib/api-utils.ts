import { randomUUID } from "node:crypto";
import { readBodyWithinLimit, RequestBodyTooLargeError } from "./bounded-form-data";
import { pooledWorkspaceForSession } from "./hosts/pool-starts";
import { isValidSessionId } from "./session-file-references-core";
import type { WorkspaceContext, WorkspaceRequest } from "./workspace-files";
import { isLinkUp, type Host } from "./hosts/host";
import { getHost, hostUploadOp, sendUploadFrame, dropUploadFrames, onUploadEvent } from "./hosts/hub";
import { HostOpError, LINK_LIMITS } from "./hosts/link-protocol";
import type { OpResult } from "./hosts/session-ops";
import { hostForSessionId, hostSessions } from "./hosts/session-index";
import { LOCAL_HOST_ID } from "./hosts/registry";
import { getRpcSession, WebRpcError } from "./rpc-manager";

const SESSION_NOT_FOUND = { error: "Session not found", code: "session_not_found" } as const;

/** Resolve a session id to the host holding its file: a live session's own host first, then the
 * hosts' lists. A 404 JSON response when no host has it, 503 while this machine's sessions are unknown. */
export async function resolveSessionHostOr404(
  id: string,
): Promise<{ host: Host } | { response: Response }> {
  const live = getRpcSession(id);
  if (live?.isAlive()) return { host: live.host };
  try {
    const host = await hostForSessionId(id);
    return host ? { host } : { response: Response.json(SESSION_NOT_FOUND, { status: 404 }) };
  } catch (error) {
    // Nothing was sent: a command the composer holds is refused, not lost.
    if (error instanceof HostOpError && error.code === "host_offline") return { response: apiErrorResponse(new WebRpcError(error.message, "host_offline", "refused")) };
    throw error;
  }
}

/** 503 `{hostOffline: true, delivery: "refused"}` while a host's link is down; null when it takes requests. */
export function hostOfflineResponse(host: Host): Response | null {
  if (isLinkUp(host.status())) return null;
  return apiErrorResponse(new WebRpcError(`${host.label} is offline`, "host_offline", "refused"));
}

/** The host a request names (`hostId`, this machine when absent): 404 when unknown, 503 while offline. */
export function resolveHostOrError(hostId: unknown): { host: Host } | { response: Response } {
  const host = hostId === undefined ? getHost(LOCAL_HOST_ID) : typeof hostId === "string" ? getHost(hostId) : null;
  if (!host) return { response: Response.json({ error: "Host not found", code: "host_not_found" }, { status: 404 }) };
  const offline = hostOfflineResponse(host);
  return offline ? { response: offline } : { host };
}

/** The JSON error response for a failed host op. */
export function opErrorResponse(result: Extract<OpResult<unknown>, { ok: false }>): Response {
  return Response.json({ error: result.error, code: result.code }, { status: result.status });
}

/** Uniform JSON error body used by most API routes. A host link failure keeps
 * its status (503 offline, 504 timeout) and code; a session whose host is
 * offline answers 503 `{hostOffline: true}`, plus its `delivery` for an agent
 * command ("unknown": the link dropped after it was sent, so it may still run). */
export function apiErrorResponse(error: unknown, status = 500): Response {
  if (error instanceof HostOpError || (error instanceof WebRpcError && error.code === "host_offline")) {
    const offline = error.code === "host_offline";
    const delivery = error instanceof WebRpcError ? error.delivery : undefined;
    return Response.json(
      { error: error.message, code: error.code, ...(offline ? { hostOffline: true } : {}), ...(delivery ? { delivery } : {}) },
      { status: error instanceof HostOpError ? error.status : 503 },
    );
  }
  return Response.json({ error: String(error) }, { status });
}

/** Browser session identity selects authority; browser cwd/hostId never do. */
export async function resolveWorkspaceOwner(sessionId: string): Promise<{ host: Host; context: WorkspaceContext } | { response: Response }> {
  if (!isValidSessionId(sessionId)) return { response: Response.json(SESSION_NOT_FOUND, { status: 404 }) };
  const live = getRpcSession(sessionId);
  if (live?.isAlive()) {
    const offline = hostOfflineResponse(live.host);
    return offline ? { response: offline } : { host: live.host, context: { sessionId, cwd: live.cwd } };
  }
  const retained = pooledWorkspaceForSession(sessionId);
  if (retained) {
    const host = getHost(retained.hostId);
    if (!host) return { response: Response.json(SESSION_NOT_FOUND, { status: 404 }) };
    const offline = hostOfflineResponse(host);
    return offline ? { response: offline } : { host, context: { sessionId, cwd: retained.cwd, projectRoot: retained.projectRoot } };
  }
  const resolved = await resolveSessionHostOr404(sessionId);
  if ("response" in resolved) return resolved;
  const offline = hostOfflineResponse(resolved.host);
  if (offline) return { response: offline };
  const info = (await hostSessions(resolved.host.id)).find((entry) => entry.id === sessionId);
  return info?.cwd
    ? { host: resolved.host, context: { sessionId, cwd: info.cwd, projectRoot: info.projectRoot } }
    : { response: Response.json(SESSION_NOT_FOUND, { status: 404 }) };
}

async function stageWorkspaceBody(host: Host, id: string, bytes: Uint8Array, request: Request): Promise<void> {
  const attempt = randomUUID();
  let received = 0;
  let failure: Error | null = null;
  let wake: (() => void) | undefined;
  const detach = onUploadEvent((hostId, ack) => {
    if (hostId !== host.id) return;
    if (!ack) failure = new HostOpError(503, "host_offline", "The file owner is offline");
    else if (ack.id === id && ack.attempt === attempt) {
      if (ack.error) failure = new HostOpError(ack.error.status, ack.error.code, ack.error.message);
      received = ack.received;
    } else return;
    wake?.();
  });
  const abort = () => { failure = new Error("The upload was cancelled"); wake?.(); };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    if (request.signal.aborted) abort();
    await hostUploadOp(host.id, "uploadStart", { id, attempt, name: "workspace-multipart", type: "application/octet-stream", size: bytes.byteLength, workspaceBody: true });
    for (let offset = 0; offset < bytes.byteLength; offset += LINK_LIMITS.pieceBytes) {
      if (failure) throw failure;
      const chunk = bytes.subarray(offset, offset + LINK_LIMITS.pieceBytes);
      const target = offset + chunk.byteLength;
      if (!sendUploadFrame(host.id, id, chunk)) throw new HostOpError(503, "host_offline", "The file owner is offline");
      while (received < target && !failure) {
        const gate = Promise.withResolvers<void>();
        wake = gate.resolve;
        const timer = setTimeout(() => { failure = new HostOpError(504, "host_timeout", "The owner did not acknowledge the upload"); gate.resolve(); }, LINK_LIMITS.opTimeoutMs);
        await gate.promise;
        clearTimeout(timer);
        wake = undefined;
      }
      if (failure) throw failure;
    }
  } finally {
    detach();
    request.signal.removeEventListener("abort", abort);
  }
}

/** Owner response bodies stay demand-driven and use only bounded binary reads. */
export async function serveWorkspaceRequest(request: Request, kind: WorkspaceRequest["kind"], segments?: string[], disableIdleTimeout?: () => void): Promise<Response> {
  let host: Host | undefined;
  let uploadId: string | undefined;
  try {
    const sessionId = new URL(request.url).searchParams.get("sessionId");
    const owner = await resolveWorkspaceOwner(sessionId ?? "");
    if ("response" in owner) return owner.response;
    host = owner.host;
    const input: WorkspaceRequest = {
      context: owner.context, kind, url: request.url, method: request.method as "GET" | "POST", segments,
      headers: Object.fromEntries(["content-type", "content-length", "range"].flatMap((name) => {
        const value = request.headers.get(name);
        return value === null ? [] : [[name, value]];
      })),
    };
    if (request.method === "POST") {
      const check = new URL(request.url).searchParams.get("type") === "upload-check";
      const bytes = await readBodyWithinLimit(request, check ? 1024 * 1024 : 101 * 1024 * 1024);
      if (check) input.jsonBody = new TextDecoder().decode(bytes);
      else {
        uploadId = randomUUID();
        await stageWorkspaceBody(host, uploadId, bytes, request);
        input.bodyUploadId = uploadId;
      }
    }
    if (request.signal.aborted) throw new Error("The file request was cancelled");
    const result = await host.sessionOps.workspaceRequest(input);
    if (!result.ok) return opErrorResponse(result);
    const { status, headers, readId } = result.value;
    if (!readId) return new Response(null, { status, headers });
    const ops = host.sessionOps;
    let closed = false;
    let detachStatus = () => {};
    const close = async () => {
      if (closed) return;
      closed = true;
      detachStatus();
      request.signal.removeEventListener("abort", abort);
      await ops.workspaceClose(readId).catch(() => {});
    };
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const fail = (error: Error) => {
      if (closed) return;
      controller.error(error);
      void close();
    };
    const abort = () => fail(new Error("The file request was cancelled"));
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        detachStatus = host!.onStatus((state) => { if (!isLinkUp(state)) fail(new HostOpError(503, "host_offline", "The file owner is offline")); });
        request.signal.addEventListener("abort", abort, { once: true });
        if (request.signal.aborted) abort();
      },
      async pull(streamController) {
        if (closed) return;
        try {
          const chunk = await ops.workspaceRead(readId);
          if (closed) return;
          if (!chunk.ok) throw new HostOpError(chunk.status, chunk.code, chunk.error);
          if (chunk.value === null) { await close(); streamController.close(); }
          else streamController.enqueue(chunk.value);
        } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      },
      cancel: close,
    }, { highWaterMark: 0 });
    disableIdleTimeout?.();
    return new Response(body, { status, headers });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      const check = new URL(request.url).searchParams.get("type") === "upload-check";
      return Response.json({ error: check ? "Upload check request is too large" : "Uploads must total 100MB or less", code: check ? "upload_check_too_large" : "upload_total_too_large" }, { status: 413 });
    }
    return apiErrorResponse(error);
  } finally {
    if (host && uploadId) {
      dropUploadFrames(host.id, uploadId);
      await hostUploadOp(host.id, "uploadAbort", { id: uploadId }).catch(() => {});
    }
  }
}
