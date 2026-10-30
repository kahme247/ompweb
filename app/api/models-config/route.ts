import { apiErrorResponse } from "@/lib/api-utils";
import { invalidateModelsCache } from "@/lib/models-cache";
import { disposeUtilityRpc } from "@/lib/omp/rpc-utility";
import {
  ModelsConfigParseError,
  readModelsConfigFile,
  validateModelsConfig,
  writeModelsConfig,
  type ModelsFileConfig,
} from "@/lib/omp/models-config";

export const dynamic = "force-dynamic";

export async function GET() {
  const file = readModelsConfigFile();
  if (file.parseError) {
    // The editor must show the failure instead of an empty form — an empty
    // form invites a Save that would wipe the user's real providers.
    return Response.json({
      providers: {},
      parseError: file.parseError,
      path: file.path,
      code: "models_config_unparseable",
    });
  }
  return Response.json(file.config);
}

// PUT /api/models-config[?overwrite=true]
// Refuses to write while models.yml is unparseable unless ?overwrite=true.
export async function PUT(req: Request) {
  try {
    const overwriteUnparseable = new URL(req.url).searchParams.get("overwrite") === "true";
    const body = await req.json() as ModelsFileConfig;
    try {
      validateModelsConfig(body);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
    try {
      writeModelsConfig(body, { overwriteUnparseable });
    } catch (error) {
      if (error instanceof ModelsConfigParseError) {
        return Response.json(
          { error: `${error.message} — fix it by hand; omp-web will not overwrite it`, code: "models_config_unparseable" },
          { status: 409 },
        );
      }
      throw error;
    }
    invalidateModelsCache();
    // The utility process loads models.yml once at startup. A cache flush alone
    // would still query that stale registry after a provider was added.
    disposeUtilityRpc();
    return Response.json({ success: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
