import { handleLinkGet, handleLinkPost } from "@/lib/hosts/hub";

export const dynamic = "force-dynamic";

// The `ompweb host` daemon's link (lib/hosts/hub.ts). proxy.ts does not run
// for this path: the hub checks the host's bearer token before reading a body.

// GET /api/hosts/link — downlink: a long-lived NDJSON stream, server → daemon.
export function GET(req: Request) {
  return handleLinkGet(req);
}

// POST /api/hosts/link — uplink: a batch of NDJSON messages, daemon → server.
export function POST(req: Request) {
  return handleLinkPost(req);
}
