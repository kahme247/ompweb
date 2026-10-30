import { isValidNotificationId } from "@/lib/notification-events";
import { reportPresence } from "@/lib/notification-hub";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

/** POST /api/notifications/presence { clientId, deviceId, visible, sessionId, seq } — which session this tab shows. */
export async function POST(req: Request) {
  const body: unknown = await req.json().catch(() => null);
  if (
    !isRecord(body) || !isValidNotificationId(body.clientId) || !isValidNotificationId(body.deviceId)
    || typeof body.visible !== "boolean" || !Number.isSafeInteger(body.seq)
  ) {
    return Response.json({ error: "Invalid presence report", code: "invalid_presence" }, { status: 400 });
  }
  const sessionId = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : null;
  reportPresence({ clientId: body.clientId, deviceId: body.deviceId, visible: body.visible, sessionId, seq: Number(body.seq) });
  return new Response(null, { status: 204 });
}
