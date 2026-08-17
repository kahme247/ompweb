import { homedir } from "os";
import { invalidateModelsCache } from "@/lib/models-cache";
import { enableProvider } from "@/lib/omp/model-roles";
import { RpcProcess, type RpcFrame } from "@/lib/omp/rpc-process";
import { disposeUtilityRpc } from "@/lib/omp/rpc-utility";

export const dynamic = "force-dynamic";

/**
 * Interactive login over a dedicated `omp --mode rpc-ui` process. omp drives
 * the flow with extension_ui_request frames: `open_url` carries the OAuth URL,
 * `input` asks for the pasted code/redirect URL, `notify` reports progress.
 * The SSE stream keeps pi-web's event names (auth, prompt_request, progress,
 * success, error, cancelled) so the client flow is unchanged; the POST handler
 * feeds the user's pasted value back as an extension_ui_response frame.
 */

const LOGIN_EXTRA_ARGS = ["--no-session", "--no-extensions", "--no-skills", "--no-lsp"];
const READY_TIMEOUT_MS = 60_000;
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const HEARTBEAT_MS = 30_000;

interface PendingLogin {
  provider: string;
  submit: (value: string) => void;
}

// Registry survives dev-server hot reload; the SSE stream registers its token,
// the POST handler resolves it.
declare global {
  var __ompLoginRegistry: Map<string, PendingLogin> | undefined;
}

function getLoginRegistry(): Map<string, PendingLogin> {
  if (!globalThis.__ompLoginRegistry) globalThis.__ompLoginRegistry = new Map();
  return globalThis.__ompLoginRegistry;
}

// POST /api/auth/login/[provider] — frontend sends redirect URL or auth code
export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const { token, code } = (await req.json()) as { token?: string; code?: string };

  if (!token || !code) {
    return Response.json({ error: "token and code required", code: "login_token_code_required" }, { status: 400 });
  }
  const pending = getLoginRegistry().get(token);
  if (!pending) {
    return Response.json({ error: "No pending login for token", code: "login_no_pending" }, { status: 404 });
  }
  // Exact provider association: the registry records the provider a token was
  // created for. A prefix check on the token alone is unsafe because provider
  // ids may share prefixes (e.g. "openai" vs "openai-codex"), which would let
  // a token for one provider be submitted against another provider's route.
  if (pending.provider !== provider) {
    return Response.json({ error: "Token does not match provider", code: "login_token_mismatch" }, { status: 400 });
  }

  pending.submit(code);
  return Response.json({ ok: true, provider });
}

// GET /api/auth/login/[provider] — SSE stream for the login flow
export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const token = `${provider}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const registry = getLoginRegistry();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      // OAuth flows sit idle while the user is in the browser; keep the SSE
      // connection alive past proxy/Next idle timeouts.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          closed = true;
        }
      }, HEARTBEAT_MS);

      // The user may paste the code before omp's input request arrives (the
      // auth event shows the paste box immediately) — buffer one value.
      let pendingInputId: string | null = null;
      let bufferedValue: string | null = null;

      let proc: RpcProcess | null = null;
      const handleFrame = (frame: RpcFrame) => {
        if (frame.type !== "extension_ui_request") return;
        const method = frame.method;
        if (method === "open_url") {
          send({
            type: "auth",
            url: String(frame.url ?? ""),
            instructions: typeof frame.instructions === "string" ? frame.instructions : null,
            token,
          });
        } else if (method === "input") {
          const id = String(frame.id);
          if (bufferedValue !== null) {
            const value = bufferedValue;
            bufferedValue = null;
            proc?.sendFrame({ type: "extension_ui_response", id, value });
          } else {
            pendingInputId = id;
            send({
              type: "prompt_request",
              message: typeof frame.title === "string" ? frame.title : "Enter the authorization code",
              placeholder: typeof frame.placeholder === "string" ? frame.placeholder : null,
              token,
            });
          }
        } else if (method === "notify") {
          if (typeof frame.message === "string") send({ type: "progress", message: frame.message });
        } else if (method === "cancel") {
          if (pendingInputId !== null && frame.targetId === pendingInputId) pendingInputId = null;
        }
      };

      try {
        proc = new RpcProcess({ cwd: homedir(), extraArgs: LOGIN_EXTRA_ARGS, onFrame: handleFrame });
      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
        clearInterval(heartbeat);
        closed = true;
        try { controller.close(); } catch {}
        return;
      }
      const child = proc;

      registry.set(token, {
        provider,
        submit: (value: string) => {
          if (pendingInputId !== null) {
            const id = pendingInputId;
            pendingInputId = null;
            child.sendFrame({ type: "extension_ui_response", id, value });
          } else {
            bufferedValue = value;
          }
        },
      });

      const cleanup = () => {
        registry.delete(token);
        clearInterval(heartbeat);
        void child.dispose();
      };
      req.signal.addEventListener("abort", cleanup);

      try {
        const ready = await child.waitReady(READY_TIMEOUT_MS);
        await child.negotiateProtocol(ready);
        await child.sendCommand({ type: "login", providerId: provider }, LOGIN_TIMEOUT_MS);
        enableProvider(provider);
        invalidateModelsCache();
        disposeUtilityRpc();
        send({ type: "success" });
      } catch (error) {
        if (req.signal.aborted) {
          send({ type: "cancelled" });
        } else {
          send({ type: "error", message: error instanceof Error ? error.message : String(error) });
        }
      } finally {
        cleanup();
        closed = true;
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
