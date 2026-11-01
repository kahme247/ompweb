import { handleLinkBlob } from "@/lib/hosts/hub";

export const dynamic = "force-dynamic";

// POST /api/hosts/link/blob/<reqId> — the bytes of one large host op result,
// uploaded by the daemon before its `res` line (lib/hosts/hub.ts).
export async function POST(req: Request, { params }: { params: Promise<{ reqId: string }> }) {
  return handleLinkBlob(req, (await params).reqId);
}
