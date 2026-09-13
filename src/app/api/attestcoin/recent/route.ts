import { NextResponse } from "next/server";
import { desc, isNotNull } from "drizzle-orm";
import { db, ensureDb } from "@/db";
import { agentActions, payments } from "@/db/schema";
import { ensureSourceChainMapFresh, sourceChainByEvmId } from "@/lib/attestcoin/chains";
import { actionSourceTxHash } from "@/lib/attestcoin/poller";

export const revalidate = 0;
export const dynamic = "force-dynamic";

/** How many recent attestations the wallet feed shows. */
const FEED_LIMIT = 6;

export interface RecentAttestation {
  id: string;
  /** AC8: row provenance — "payment" (settled payment row) or "action"
   * (attested agent action row). Added to existing payment rows too; the
   * field is additive, so older consumers keep working unchanged. */
  type: "payment" | "action";
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

/** AC8: an attested agent action row (transfer, deploy, escrow lock, swap…). */
export interface RecentActionAttestation {
  id: string;
  type: "action";
  /** Raw tool id — the panel humanizes it for display. */
  tool: string;
  /** Source-chain tx hash the attestation proves (from result_json/source_tx_hash). */
  txHash: string | null;
  chainId: number | null;
  /** Source-chain display name (resolved server-side from the tracked chains). */
  chainName: string;
  /** Epoch ms when the server-side poller first saw the proof. */
  attestedAt: number;
  /** Merkle root of the attested block's tx tree. */
  attestRoot: string | null;
  onchainVerified: boolean;
  /** Creditcoin tx hash when a proof was submitted on-chain for this action. */
  cc3TxHash: string | null;
}

/** The merged feed: payment rows and action rows, newest attestation first. */
export type RecentFeedRow = RecentAttestation | RecentActionAttestation;

/**
 * GET /api/attestcoin/recent — the attestation feed: the most recent rows the
 * server-side poller flipped to attested. AC8: this now merges SETTLED
 * PAYMENTS (unchanged shape, plus `type: "payment"`) with ATTESTED AGENT
 * ACTIONS (`type: "action"` rows: transfers, contract deployments, escrow
 * locks — anything the agent executed on a tracked source chain). Local DB
 * only, no network. Powers the wallet panel's "Recent attestations" list.
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

  // AC8: attested agent actions — same window, same ordering key, so the two
  // lists merge by attestedAt below. The tx hash for each row is recovered
  // from result_json / source_tx_hash by the poller's shared helper.
  const actionRows = db
    .select({
      id: agentActions.id,
      tool: agentActions.tool,
      sourceTxHash: agentActions.sourceTxHash,
      resultJson: agentActions.resultJson,
      chainId: agentActions.chainId,
      attestedAt: agentActions.attestedAt,
      attestRoot: agentActions.attestRoot,
      onchainVerifiedAt: agentActions.onchainVerifiedAt,
      cc3TxHash: agentActions.cc3TxHash,
    })
    .from(agentActions)
    .where(isNotNull(agentActions.attestedAt))
    .orderBy(desc(agentActions.attestedAt))
    .limit(FEED_LIMIT)
    .all();

  const paymentFeed: RecentAttestation[] = rows.map((row) => ({
    id: row.id,
    type: "payment" as const,
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

  const actionFeed: RecentActionAttestation[] = actionRows.map((row) => ({
    id: row.id,
    type: "action" as const,
    tool: row.tool,
    txHash: actionSourceTxHash(row.resultJson, row.sourceTxHash),
    chainId: row.chainId,
    chainName:
      row.chainId != null
        ? sourceChainByEvmId(row.chainId)?.name ?? `chain ${row.chainId}`
        : "unknown chain",
    attestedAt: row.attestedAt ?? 0,
    attestRoot: row.attestRoot,
    onchainVerified: row.onchainVerifiedAt != null,
    cc3TxHash: row.cc3TxHash,
  }));

  // Merge by attestedAt desc (ties: payments first — stable, deterministic)
  // and keep the original feed limit.
  const recent: RecentFeedRow[] = [...paymentFeed, ...actionFeed]
    .sort((a, b) => b.attestedAt - a.attestedAt || (a.type === "payment" ? -1 : 1))
    .slice(0, FEED_LIMIT);

  return NextResponse.json({ recent, env: process.env.ATTESTCOIN_NETWORK === "mainnet" ? "mainnet" : "testnet" });
}
