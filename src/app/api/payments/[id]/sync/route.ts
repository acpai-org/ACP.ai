import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { createPublicClient, http, type Hash } from "viem";
import { db, ensureDb } from "@/db";
import { payments } from "@/db/schema";
import { getChainByChainId } from "@/lib/chains";

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
    const client = createPublicClient({ transport: http(chainConfig.rpcUrl) });
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
