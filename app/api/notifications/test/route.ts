import { isValidNotificationId } from "@/lib/notification-events";
import { sendTestPush } from "@/lib/notification-hub";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

/** POST /api/notifications/test { deviceId } — one push to this device; 502 when the push service refuses it. */
export async function POST(req: Request) {
  const body: unknown = await req.json().catch(() => null);
  if (!isRecord(body) || !isValidNotificationId(body.deviceId)) {
    return Response.json({ error: "deviceId is required", code: "invalid_device" }, { status: 400 });
  }
  const result = await sendTestPush(body.deviceId);
  return result.ok ? new Response(null, { status: 204 }) : Response.json({ error: result.error, code: "push_failed" }, { status: 502 });
}
