import { getHost } from "@/lib/hosts/hub";
import { MaintenanceError, requestMaintenance } from "@/lib/hosts/maintenance-hub";

/** Browser access stays behind the web gate; no application connection is needed. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const headers = { "cache-control": "no-store" };
  if (!getHost(id)) return Response.json({ error: "Unknown host", code: "host_not_found" }, { status: 404, headers });
  try {
    const op = new URL(request.url).searchParams.get("sessions") === "1" ? "listSessions" : "status";
    return Response.json(await requestMaintenance(id, op, {}), { headers });
  } catch (error) {
    if (error instanceof MaintenanceError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers });
    return Response.json({ error: "The host maintenance request failed", code: "maintenance_failed" }, { status: 500, headers });
  }
}
