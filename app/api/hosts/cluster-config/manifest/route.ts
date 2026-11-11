import { admitClusterMember, configErrorResponse, currentClusterConfig } from "@/lib/hosts/cluster-config-server";

// The master's mirrored configuration for a cluster member: bearer-authenticated, outside the password gate (proxy.ts `UNGATED`).
export async function GET(request: Request) {
  const host = admitClusterMember(request);
  if (host instanceof Response) return host;
  try {
    return Response.json((await currentClusterConfig()).manifest, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return configErrorResponse(host.id, error);
  }
}
