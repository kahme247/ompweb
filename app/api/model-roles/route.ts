import { invalidateModelsCache } from "@/lib/models-cache";
import { readModelRoles, writeModelRoles } from "@/lib/omp/model-roles";

export function GET() {
  try {
    return Response.json(readModelRoles());
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 400 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json() as { roles?: unknown };
    if (!body.roles || typeof body.roles !== "object" || Array.isArray(body.roles)) {
      return Response.json({ error: "roles must be an object" }, { status: 400 });
    }
    const roles = Object.fromEntries(Object.entries(body.roles).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[0].trim().length > 0 && entry[1].trim().length > 0,
    ));
    writeModelRoles(roles);
    invalidateModelsCache();
    return Response.json({ success: true, roles });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 400 });
  }
}
