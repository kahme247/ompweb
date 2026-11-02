import { handleLinkGet, handleLinkPost } from "@/lib/hosts/hub";

// The `ompweb host` daemon's link (lib/hosts/hub.ts). proxy.ts does not run
// for this path: the hub checks the host's bearer token before reading a body,
// and only then lifts Bun's idle timeout (disableIdleTimeout, server/app.ts).
type Context = { disableIdleTimeout: () => void };

// GET /api/hosts/link — downlink: a long-lived NDJSON stream, server → daemon.
export function GET(req: Request, { disableIdleTimeout }: Context) {
  return handleLinkGet(req, disableIdleTimeout);
}

// POST /api/hosts/link — uplink: a batch of NDJSON messages, daemon → server.
export function POST(req: Request, { disableIdleTimeout }: Context) {
  return handleLinkPost(req, disableIdleTimeout);
}
