import { admitClusterMember, configErrorResponse, configFail, currentClusterConfig } from "@/lib/hosts/cluster-config-server";

// One file of the current manifest by content hash; a hash of an older configuration is 404.
export async function GET(request: Request, { params }: { params: Promise<{ hash: string }> }) {
  const host = admitClusterMember(request);
  if (host instanceof Response) return host;
  const { hash } = await params;
  if (!/^[0-9a-f]{64}$/.test(hash)) return configFail("Not found", 404);
  try {
    const bytes = (await currentClusterConfig()).content(hash);
    if (!bytes) return configFail("Not found", 404);
    // buildManifest's bytes are Buffers (never SharedArrayBuffer-backed), which BodyInit accepts.
    return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
  } catch (error) {
    return configErrorResponse(host.id, error);
  }
}
