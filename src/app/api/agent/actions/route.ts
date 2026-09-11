import { listActions } from "@/lib/agent/action-log";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/agent/actions — the persistent, user-visible action log (brief §5).
// Every action the agent took or attempted, with proof/tx references.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 200);
  const rows = listActions(limit);
  return new Response(
    JSON.stringify({
      // N27.1: server-side Attestcoin environment (same source of truth as
      // /api/attestcoin/recent) — the client uses it to deep-link CC3 txs to
      // the correct environment's Blockscout explorer.
      cc3Env: process.env.ATTESTCOIN_NETWORK === "mainnet" ? "mainnet" : "testnet",
      actions: rows.map((r) => ({
        id: r.id,
        runId: r.runId,
      callId: r.callId,
        tool: r.tool,
        status: r.status,
        chainId: r.chainId,
        riskClass: r.riskClass,
        confirmationRequired: r.confirmationRequired,
        params: safeJson(r.paramsJson),
        result: safeJson(r.resultJson),
        sourceTxHash: r.sourceTxHash,
        cc3TxHash: r.cc3TxHash,
        attestRoot: r.attestRoot,
        createdAt: r.createdAt,
        completedAt: r.completedAt,
      })),
    }),
    { headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );
}

function safeJson(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
