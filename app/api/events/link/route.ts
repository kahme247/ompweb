import { handleBrowserLinkUpgrade, type BrowserLinkData } from "@/lib/browser-link";

// GET /api/events/link — the browser link (lib/browser-link.ts); undefined once upgraded (server/app.ts). Gated like
// every API route: the password gate and origin check run before the upgrade, which binds the socket to its web session.
export function GET(req: Request, { upgrade }: { upgrade: (data: BrowserLinkData) => boolean }) {
  return handleBrowserLinkUpgrade(req, upgrade);
}
