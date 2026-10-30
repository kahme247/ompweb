import { invalidateModelsCache } from "@/lib/models-cache";
import { disposeUtilityRpc, runUtilityCommand, type OmpModel } from "@/lib/omp/rpc-utility";
import { readNativeSettings, writeNativeSettings, type NativeSettings } from "@/lib/omp/settings-config";
import { assertNoAmbiguousModelScopes } from "@/lib/model-scope";

export const dynamic = "force-dynamic";

export function GET() {
  try {
    return Response.json(readNativeSettings());
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 400 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json() as { settings?: NativeSettings };
    if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)) {
      return Response.json({ error: "settings must be an object" }, { status: 400 });
    }
    if (body.settings.enabledModels !== undefined) {
      // The utility process is best-effort here: settings remain editable when
      // omp is unavailable, but an available catalog rejects ambiguous bare IDs.
      try {
        const response = await runUtilityCommand<{ models?: unknown }>({ type: "get_available_models" }, 120_000);
        if (Array.isArray(response.models)) {
          const models = response.models.filter((model): model is OmpModel => (
            typeof model === "object" && model !== null
            && typeof (model as OmpModel).id === "string"
            && typeof (model as OmpModel).provider === "string"
          ));
          assertNoAmbiguousModelScopes(body.settings.enabledModels, models);
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Ambiguous enabledModels entry")) throw error;
      }
    }
    writeNativeSettings(body.settings);
    if (body.settings.enabledModels !== undefined || body.settings.disabledProviders !== undefined || body.settings.modelProviderOrder !== undefined) {
      invalidateModelsCache();
      disposeUtilityRpc();
    }
    return Response.json({ success: true, settings: readNativeSettings().settings });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 400 });
  }
}
