import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { getHostSoftwareUpdates, updateHostSoftware } from "@/lib/hosts/hub";
import { HostOpError } from "@/lib/hosts/link-protocol";
import { isApiRequestOriginAllowed, shouldCheckApiRequestOrigin } from "@/lib/request-security";
import { isRecord } from "@/lib/type-guards";

type Context = { params: Promise<{ id: string }> };
const noStore = { "cache-control": "no-store" };
const fail = (error: string, code: string, status: number) => Response.json({ error, code }, { status, headers: noStore });
function errorResponse(error: unknown): Response {
  if (error instanceof HostOpError) return fail(error.message, error.code, error.status);
  if (error instanceof RequestBodyTooLargeError) return fail(error.message, "body_too_large", 413);
  if (error instanceof SyntaxError) return fail("Request body must be valid JSON", "invalid_json", 400);
  return fail("The host update request failed", "host_update_failed", 500);
}

export async function GET(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    return Response.json(await getHostSoftwareUpdates(id, new URL(request.url).searchParams.get("force") === "1"), { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, { params }: Context) {
  if (shouldCheckApiRequestOrigin(request) && !isApiRequestOriginAllowed(request)) return fail("Cross-origin API requests are not allowed", "cross_origin_forbidden", 403);
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return fail("Content-Type must be application/json", "unsupported_media_type", 415);
  try {
    const body = await parseJsonWithinLimit<unknown>(request, 4096);
    if (!isRecord(body) || Object.keys(body).length !== 2 || !(body.target === "ompweb" || body.target === "omp")
      || typeof body.version !== "string" || body.version.length > 100 || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(body.version)) {
      return fail("target and a release version are required", "invalid_host_update", 400);
    }
    return Response.json(await updateHostSoftware((await params).id, body.target, body.version), { status: 202, headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}
