import { invalidateModelsCache } from "@/lib/models-cache";
import { runUtilityCommand } from "@/lib/omp/rpc-utility";

export const dynamic = "force-dynamic";

/** Entry of omp's `get_logout_accounts` response. Labels never carry a raw key. */
interface OmpProviderAccount {
  credentialId: number;
  label: string;
  detail: string;
  type: "api_key" | "oauth";
}

// omp releases older than the get_logout_accounts/logout RPC answer "Unknown command".
const UNSUPPORTED = "Unknown command";

function isAccount(value: unknown): value is OmpProviderAccount {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Record<string, unknown>;
  return Number.isInteger(a.credentialId) && typeof a.label === "string" && typeof a.detail === "string"
    && (a.type === "api_key" || a.type === "oauth");
}

// omp's `active` flag is relative to the utility process's own throwaway
// session, not to any chat, so it is deliberately not passed on.
/** Stored credentials omp holds for one provider. */
export async function GET(_req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  try {
    const { accounts } = await runUtilityCommand<{ accounts?: unknown }>(
      { type: "get_logout_accounts", providerId: provider },
      30_000,
    );
    const list = Array.isArray(accounts) ? accounts.filter(isAccount) : [];
    return Response.json({
      supported: true,
      accounts: list.map(({ credentialId, label, detail, type }) => ({ credentialId, label, detail, type })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(UNSUPPORTED)) return Response.json({ supported: false, accounts: [] });
    return Response.json({ error: message }, { status: 500 });
  }
}

/** Remove one stored credential (`?credentialId=`); omp picks the next account. */
export async function DELETE(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const raw = new URL(req.url).searchParams.get("credentialId") ?? "";
  const credentialId = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(credentialId)) {
    return Response.json({ error: "credentialId must be an integer" }, { status: 400 });
  }
  const { provider } = await params;
  try {
    await runUtilityCommand({ type: "logout", providerId: provider, credentialId }, 60_000);
    invalidateModelsCache();
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(UNSUPPORTED)) {
      return Response.json(
        {
          error: "omp-web cannot disconnect accounts with this omp version. Update omp, or run `omp` in a terminal and use /logout.",
          code: "logout_unsupported",
        },
        { status: 501 },
      );
    }
    return Response.json({ error: message }, { status: 500 });
  }
}
