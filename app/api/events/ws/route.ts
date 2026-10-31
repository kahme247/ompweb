import { handleBrowserSocketUpgrade, type BrowserSocketData } from "@/lib/browser-socket";

// GET /api/events/ws[?session=<id>] — the browser's WebSocket transport (lib/browser-socket.ts); undefined once upgraded
// (server/app.ts). Gated like every API route: the password gate and origin check run before the upgrade.
export function GET(req: Request, { upgrade }: { upgrade: (data: BrowserSocketData) => boolean }) {
  return handleBrowserSocketUpgrade(req, upgrade);
}
