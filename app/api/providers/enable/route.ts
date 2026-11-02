import { invalidateModelsCache } from "@/lib/models-cache";
import { enableProvider } from "@/lib/omp/model-roles";
import { disposeUtilityRpc } from "@/lib/omp/rpc-utility";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { provider?: unknown };
    if (typeof body.provider !== "string" || !body.provider.trim()) {
      return Response.json({ error: "provider is required" }, { status: 400 });
    }
    enableProvider(body.provider);
    invalidateModelsCache();
    disposeUtilityRpc();
    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 400 });
  }
}
