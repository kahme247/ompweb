import { handleMaintenanceUpgrade, type MaintenanceSocketData } from "@/lib/hosts/maintenance-hub";
import { LINK_PROTOCOL_VERSION } from "@/lib/hosts/link-protocol";
import packageJson from "@/package.json";

/** API v1 discovery and its independent host-token-authenticated WebSocket. */
export function GET(request: Request, { upgrade }: { upgrade: (data: MaintenanceSocketData) => boolean }) {
  return handleMaintenanceUpgrade(request, upgrade, { protocolVersion: LINK_PROTOCOL_VERSION, ompwebVersion: packageJson.version });
}
