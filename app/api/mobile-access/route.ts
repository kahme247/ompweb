import { networkInterfaces } from "node:os";
import {
  candidateAddresses,
  classifyExposure,
  DEFAULT_MOBILE_PORT,
  detectBindHostname,
  mobileAccessMethods,
  parseMobilePort,
  probeMagicDnsName,
} from "@/lib/mobile-access";
import { isWebPasswordEnabled, webPasswordConfigurationProblem } from "@/lib/web-auth";

/**
 * The port this server is actually listening on.
 *
 * `OMP_WEB_PORT` is written by `startProduction` from the bound listener, so it
 * is the authoritative value for a production launch (`npm start`, the binary
 * and the launcher all go through it). The request URL's port is only as good
 * as the `Host` header a proxy forwards, and `PORT` is the launcher's *intent*,
 * not what the socket ended up on. Order: bound port, then the URL, then PORT.
 */
function resolveServerPort(req: Request): number {
  return parseMobilePort(process.env.OMP_WEB_PORT)
    ?? parseMobilePort(new URL(req.url).port)
    ?? parseMobilePort(process.env.PORT)
    ?? DEFAULT_MOBILE_PORT;
}

/**
 * GET /api/mobile-access — read-only facts for Settings → Mobile app. The
 * endpoint cannot change the binding and never returns the password (only
 * whether one is configured).
 */
export async function GET(req: Request) {
  const hostname = detectBindHostname();
  const port = resolveServerPort(req);
  // Optional and time-boxed inside the helper: a missing tailscale binary
  // resolves without spawning, and a slow one is cut off by its timeout.
  const magicDnsName = await probeMagicDnsName();
  return Response.json({
    binding: {
      hostname,
      exposure: classifyExposure(hostname),
      port,
    },
    password: {
      configured: isWebPasswordEnabled(),
      problem: webPasswordConfigurationProblem() !== null,
    },
    addresses: candidateAddresses({ hostname, port, magicDnsName, interfaces: networkInterfaces() }),
    methods: mobileAccessMethods(),
  });
}
