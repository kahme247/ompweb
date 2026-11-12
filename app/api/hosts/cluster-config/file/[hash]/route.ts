import { admitClusterMember, configErrorResponse, configFail, currentClusterConfig } from "@/lib/hosts/cluster-config-server";

// One file of the current manifest by content hash; a hash of an older configuration is 404.
export async function GET(request: Request, { params }: { params: Promise<{ hash: string }> }) {
  const host = admitClusterMember(request);
  if (host instanceof Response) return host;
  const { hash } = await params;
  if (!/^[0-9a-f]{64}$/.test(hash)) return configFail("Not found", 404);
  try {
    const current = await currentClusterConfig();
    // Admitted again: the host may have been revoked or left the cluster while the configuration was built.
    const again = admitClusterMember(request);
    if (again instanceof Response) return again;
    const bytes = current.content(hash);
    if (!bytes) return configFail("Not found", 404);
    // buildManifest's bytes are Buffers (never SharedArrayBuffer-backed), which BodyInit accepts.
    return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
  } catch (error) {
    return configErrorResponse(host.id, error);
  }
}
