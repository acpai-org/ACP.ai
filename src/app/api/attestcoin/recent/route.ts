import { NextResponse } from "next/server";
import { desc, isNotNull } from "drizzle-orm";
import { db, ensureDb } from "@/db";
import { payments } from "@/db/schema";
import { ensureSourceChainMapFresh, sourceChainByEvmId } from "@/lib/attestcoin/chains";

export const dynamic = "force-dynamic";

/** How many recent attestations the wallet feed shows. */
const FEED_LIMIT = 6;

export interface RecentAttestation {
  id: string;
  recipientLabel: string | null;
  recipientAddress: string;
  token: string;
  amountHuman: string;
  chainId: number;
  /** Source-chain display name (resolved server-side from the tracked chains). */
  chainName: string;
  /** Epoch ms when the server-side poller first saw the proof. */
  attestedAt: number;
  /** Merkle root of the attested block's tx tree. */
  attestRoot: string | null;
  onchainVerified: boolean;
  submitted: boolean;
}

/**
 * GET /api/attestcoin/recent — the payment-side of the attestation feed:
 * the most recent payments the poller flipped to attested (local DB only,
 * no network). Powers the wallet panel's "Recent attestations" list.
 */
export async function GET() {
  ensureDb();
  // G1 — live chain-key resolution for the display names.
  await ensureSourceChainMapFresh();
  const rows = db
    .select({
      id: payments.id,
      recipientLabel: payments.recipientLabel,
      recipientAddress: payments.recipientAddress,
      token: payments.token,
      amountHuman: payments.amountHuman,
      chainId: payments.chainId,
      attestedAt: payments.attestedAt,
      attestRoot: payments.attestRoot,
      onchainVerifiedAt: payments.onchainVerifiedAt,
      cc3TxHash: payments.cc3TxHash,
    })
    .from(payments)
    .where(isNotNull(payments.attestedAt))
    .orderBy(desc(payments.attestedAt))
    .limit(FEED_LIMIT)
    .all();

  const recent: RecentAttestation[] = rows.map((row) => ({
    id: row.id,
    recipientLabel: row.recipientLabel,
    recipientAddress: row.recipientAddress,
    token: row.token,
    amountHuman: row.amountHuman,
    chainId: row.chainId,
    chainName: sourceChainByEvmId(row.chainId)?.name ?? `chain ${row.chainId}`,
    attestedAt: row.attestedAt ?? 0,
    attestRoot: row.attestRoot,
    onchainVerified: row.onchainVerifiedAt != null,
    submitted: row.cc3TxHash != null,
  }));

  return NextResponse.json({ recent, env: process.env.ATTESTCOIN_NETWORK === "mainnet" ? "mainnet" : "testnet" });
}
