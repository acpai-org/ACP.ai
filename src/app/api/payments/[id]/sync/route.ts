import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { createPublicClient, http, type Hash } from "viem";
import { db, ensureDb } from "@/db";
import { payments } from "@/db/schema";
// N8 fix: the REAL chain registry (the legacy @/lib/chains module only knew
// Sepolia + Ethereum mainnet, so the recovery sync — "re-check after the
// receipt wasn't available" — refused to run for 7 of the 9 registry chains
// and those payments stayed stuck in signing/settling forever).
import { getChainByChainId } from "@/lib/chains/registry";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Re-checks a payment's on-chain state directly from an RPC node and updates
 * the DB row. Use this when the app returned before the transaction receipt
 * was available (DB still says "signing"/"settling") — the tx may have since
 * been mined.
 *
 * TODO(phase-2): wire to Attestcoin Protocol verification. A coordinator
 * status poll used to live here; Phase 2 replaces the raw receipt check with
 * an Attestcoin Protocol attestation lookup so "settled" means "verifiably
 * settled", not just "transaction mined".
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;
export async function POST(_request: Request, { params }: RouteParams) {
  ensureDb();
  const { id } = await params;

  const row = db.select().from(payments).where(eq(payments.id, id)).get();
  if (!row) {
    return NextResponse.json({ error: "Payment not found." }, { status: 404 });
  }

  if (!row.txHash) {
    return NextResponse.json({ error: "Payment has no transaction hash — nothing to sync." }, { status: 400 });
  }

  if (row.status === "settled" || row.status === "failed") {
    return NextResponse.json({ payment: row, synced: false, reason: "already terminal" });
  }

  const chainConfig = getChainByChainId(row.chainId);
  if (!chainConfig) {
    return NextResponse.json({
      payment: row,
      synced: false,
      reason: `no RPC configured for chain ${row.chainId}`,
    });
  }

  try {
    // N8: snappy transport — bounded timeout, no retries (the caller polls).
    const client = createPublicClient({
      transport: http(chainConfig.rpcUrls[0], { timeout: 8_000, retryCount: 1 }),
    });
    const receipt = await client.getTransactionReceipt({ hash: row.txHash as Hash });

    const finalStatus = receipt.status === "success" ? "settled" : "failed";

    db.update(payments)
      .set({
        status: finalStatus,
        settledAt: finalStatus === "settled" ? Date.now() : row.settledAt,
      })
      .where(eq(payments.id, id))
      .run();

    const updated = db.select().from(payments).where(eq(payments.id, id)).get();
    return NextResponse.json({
      payment: updated,
      synced: true,
    });
  } catch {
    // Transaction not yet mined or RPC unreachable
    return NextResponse.json({
      payment: row,
      synced: false,
      reason: "transaction not yet mined or RPC unreachable",
    });
  }
}
