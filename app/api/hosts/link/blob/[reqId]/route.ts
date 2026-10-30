import { handleLinkBlob } from "@/lib/hosts/hub";

// POST /api/hosts/link/blob/<reqId> — the bytes of one large host op result,
// uploaded by the daemon before its `res` line (lib/hosts/hub.ts).
export async function POST(req: Request, { params, disableIdleTimeout }: { params: Promise<{ reqId: string }>; disableIdleTimeout: () => void }) {
  return handleLinkBlob(req, (await params).reqId, disableIdleTimeout);
}
