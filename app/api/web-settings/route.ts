import { broadcastBrowserTransport } from "@/lib/event-stream-hub";
import { BROWSER_TRANSPORTS } from "@/lib/event-stream-protocol";
import { syncInterruptibleSessions } from "@/lib/rpc-manager";
import { parseAgentEnvText, sanitizeAgentEnvValues, type AgentEnvParseResult } from "@/lib/omp/agent-env";
import { pushUploadRetention } from "@/lib/hosts/upload-retention-sync";
import { browserTransportState, loadWebServerSettings, saveWebServerSettings, type WebServerSettings } from "@/lib/web-settings";
import { isRecord } from "@/lib/type-guards";
import { isUploadRetentionDays } from "@/lib/upload-limits";

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
  const payload = body as Partial<Record<keyof WebServerSettings, unknown>>;
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
    const transport = BROWSER_TRANSPORTS.find((value) => value === payload.browserTransport);
    if (!transport) {
      return Response.json({ error: `browserTransport must be one of ${BROWSER_TRANSPORTS.map((value) => `"${value}"`).join(", ")}`, code: "invalid_settings" }, { status: 400 });
    }
    patch.browserTransport = transport;
  }

  if (payload.uploadRetentionDays !== undefined) {
    if (!isUploadRetentionDays(payload.uploadRetentionDays)) {
      return Response.json({ error: "uploadRetentionDays must be a whole number of days from 1 to 3650, or null", code: "invalid_settings" }, { status: 400 });
    }
    patch.uploadRetentionDays = payload.uploadRetentionDays;
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

  const previousTransport = JSON.stringify(browserTransportState());
  const previousRetention = loadWebServerSettings().uploadRetentionDays;
  const settings = saveWebServerSettings(patch);
  // Apply to sessions that are already running, not only the next run. Only when the
  // flag was part of this save — an agentEnv-only write must not touch live sessions.
  if (resumeProvided) syncInterruptibleSessions();
  // Every open browser converges on the new state; an unchanged one is not sent (the worker ignores it anyway).
  const transport = browserTransportState(settings);
  if (JSON.stringify(transport) !== previousTransport) broadcastBrowserTransport(transport);
  // Every host daemon deletes sent uploads by this value: the ones linked now are told at once, the others when they link.
  if (settings.uploadRetentionDays !== previousRetention) pushUploadRetention(settings.uploadRetentionDays);
  return Response.json({ ...settings, agentEnv: sanitizeAgentEnvValues(settings.agentEnv).values });
}