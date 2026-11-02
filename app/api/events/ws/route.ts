import { handleBrowserSocketUpgrade, type BrowserSocketData } from "@/lib/browser-socket";

// GET /api/events/ws — the browser's WebSocket transport (lib/browser-socket.ts); undefined once upgraded
// (server/app.ts). Gated like every API route: the password gate and origin check run before the upgrade.
export function GET(_req: Request, { upgrade }: { upgrade: (data: BrowserSocketData) => boolean }) {
  return handleBrowserSocketUpgrade(upgrade);
}
