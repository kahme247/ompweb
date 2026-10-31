import { NextResponse } from "next/server";
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

export const dynamic = "force-dynamic";

/**
 * GET /api/mobile-access — read-only facts for Settings → Mobile app. The
 * endpoint cannot change the binding and never returns the password (only
 * whether one is configured).
 */
export async function GET(req: Request) {
  const hostname = detectBindHostname();
  const port = parseMobilePort(new URL(req.url).port) ?? parseMobilePort(process.env.PORT) ?? DEFAULT_MOBILE_PORT;
  // Optional and time-boxed inside the helper: a missing tailscale binary
  // resolves without spawning, and a slow one is cut off by its timeout.
  const magicDnsName = await probeMagicDnsName();
  return NextResponse.json({
    binding: {
      hostname,
      exposure: classifyExposure(hostname),
      port,
    },
    password: {
      configured: isWebPasswordEnabled(),
      problem: webPasswordConfigurationProblem() !== null,
    },
    addresses: candidateAddresses({ interfaces: networkInterfaces(), port, magicDnsName }),
    methods: mobileAccessMethods(),
  });
}
