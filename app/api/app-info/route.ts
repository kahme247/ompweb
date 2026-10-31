import { NextResponse } from "next/server";
import packageJson from "../../../package.json";

export const dynamic = "force-dynamic";

/**
 * Capability handshake for native clients. Rides the normal /api auth gate; it
 * carries the package version and which server-side features exist, never any
 * credential or configuration value.
 */
export function GET() {
  return NextResponse.json({
    name: "ompweb",
    version: packageJson.version,
    api: 1,
    capabilities: {
      notificationDialogs: true,
      notificationAnswer: true,
      notificationDismiss: true,
      heartbeatParam: true,
    },
  });
}
