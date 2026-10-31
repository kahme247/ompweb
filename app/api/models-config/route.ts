import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { invalidateModelsCache } from "@/lib/models-cache";
import { disposeUtilityRpc } from "@/lib/omp/rpc-utility";
import {
  ModelsConfigParseError,
  maskModelsConfigApiKeys,
  readModelsConfigFile,
  restoreModelsConfigApiKeys,
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
    return NextResponse.json({
      providers: {},
      parseError: file.parseError,
      path: file.path,
      code: "models_config_unparseable",
    });
  }
  // Never emit a real key: the file API denies models.yml outright, and
  // this route is the scoped alternative to that denial.
  return NextResponse.json(maskModelsConfigApiKeys(file.config));
}

// PUT /api/models-config[?overwrite=true]
// Refuses to write while models.yml is unparseable unless ?overwrite=true.
export async function PUT(req: Request) {
  try {
    const overwriteUnparseable = new URL(req.url).searchParams.get("overwrite") === "true";
    const body = await req.json() as ModelsFileConfig;
    // The editor echoes masked keys back on every save; restore the stored
    // key for those, so an unrelated edit never wipes (or leaks, then
    // re-saves) a credential, and a placeholder is never written to disk.
    const stored = readModelsConfigFile();
    const restored = restoreModelsConfigApiKeys(body, stored.parseError ? { providers: {} } : stored.config);
    try {
      validateModelsConfig(restored);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
    try {
      writeModelsConfig(restored, { overwriteUnparseable });
    } catch (error) {
      if (error instanceof ModelsConfigParseError) {
        return NextResponse.json(
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
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
