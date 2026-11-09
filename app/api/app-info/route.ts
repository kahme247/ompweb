import packageJson from "../../../package.json";

/**
 * Capability handshake for native clients. Rides the normal /api auth gate; it
 * carries the package version and which server-side features exist, never any
 * credential or configuration value.
 *
 * Every flag names a route or shape this server actually serves: a client that
 * reads one and finds the feature missing would break, so a capability is added
 * only together with its implementation.
 */
export function GET(): Response {
  return Response.json({
    name: "ompweb",
    version: packageJson.version,
    api: 1,
    capabilities: {
      /** `GET /api/events?heartbeat=<15..110>` chooses this connection's keep-alive. */
      heartbeatParam: true,
    },
  }, { headers: { "Cache-Control": "no-store" } });
}
