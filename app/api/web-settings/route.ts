import { broadcastBrowserTransport } from "@/lib/event-stream-hub";
import { syncInterruptibleSessions } from "@/lib/rpc-manager";
import { parseAgentEnvText, sanitizeAgentEnvValues, type AgentEnvParseResult } from "@/lib/omp/agent-env";
import { loadWebServerSettings, saveWebServerSettings, type WebServerSettings } from "@/lib/web-settings";
import { isRecord } from "@/lib/type-guards";

/** GET/PUT /api/web-settings - omp-web's own server-side settings. */
export async function GET() {
  return Response.json(readSettings());
}

/** Never surface a variable lib/omp/agent-env.ts would refuse to spawn with. */
function readSettings(): WebServerSettings {
  const settings = loadWebServerSettings();
  return { ...settings, agentEnv: sanitizeAgentEnvValues(settings.agentEnv).values };
}

export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  if (!isRecord(body)) {
    return Response.json({ error: "Request body must be a settings object", code: "invalid_settings" }, { status: 400 });
  }
  const payload = body as { autoResumeSessions?: unknown; agentToolsEnabled?: unknown; agentEnv?: unknown; browserTransport?: unknown };
  const patch: Partial<WebServerSettings> = {};

  // Both keys are optional so a caller can update one without reading the other;
  // anything present is still validated.
  let resumeProvided = false;
  if (payload.autoResumeSessions !== undefined) {
    if (typeof payload.autoResumeSessions !== "boolean") {
      return Response.json({ error: "autoResumeSessions must be a boolean", code: "invalid_settings" }, { status: 400 });
    }
    patch.autoResumeSessions = payload.autoResumeSessions;
    resumeProvided = true;
  }

  if (payload.agentToolsEnabled !== undefined) {
    if (typeof payload.agentToolsEnabled !== "boolean") {
      return Response.json({ error: "agentToolsEnabled must be a boolean", code: "invalid_settings" }, { status: 400 });
    }
    patch.agentToolsEnabled = payload.agentToolsEnabled;
  }

  if (payload.browserTransport !== undefined) {
    if (payload.browserTransport !== "sse" && payload.browserTransport !== "websocket") {
      return Response.json({ error: "browserTransport must be \"sse\" or \"websocket\"", code: "invalid_settings" }, { status: 400 });
    }
    patch.browserTransport = payload.browserTransport;
  }

  if (payload.agentEnv !== undefined) {
    // Either raw KEY=VALUE text (what the settings textarea holds) or a record.
    let parsed: AgentEnvParseResult;
    if (typeof payload.agentEnv === "string") {
      parsed = parseAgentEnvText(payload.agentEnv);
    } else if (isRecord(payload.agentEnv)) {
      parsed = sanitizeAgentEnvValues(payload.agentEnv);
    } else {
      return Response.json(
        { error: "agentEnv must be KEY=VALUE text or an object of variables", code: "invalid_agent_env" },
        { status: 400 },
      );
    }
    if (parsed.errors.length > 0) {
      return Response.json(
        { error: "agentEnv contains invalid or reserved variable names", code: "invalid_agent_env", errors: parsed.errors },
        { status: 400 },
      );
    }
    patch.agentEnv = parsed.values;
  }

  const previousTransport = loadWebServerSettings().browserTransport;
  const settings = saveWebServerSettings(patch);
  // Apply to sessions that are already running, not only the next run. Only when the
  // flag was part of this save — an agentEnv-only write must not touch live sessions.
  if (resumeProvided) syncInterruptibleSessions();
  if (settings.browserTransport !== previousTransport) broadcastBrowserTransport(settings.browserTransport);
  return Response.json({ ...settings, agentEnv: sanitizeAgentEnvValues(settings.agentEnv).values });
}