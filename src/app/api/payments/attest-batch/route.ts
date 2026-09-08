import { NextResponse } from "next/server";
import { logAppAction } from "@/lib/agent/action-log";
import { and, desc, eq, isNull, isNotNull, ne } from "drizzle-orm";
import { db, ensureDb } from "@/db";
import { payments } from "@/db/schema";
import { getTxProof } from "@/lib/attestcoin/proof";
import { ensureSourceChainMapFresh, sourceChainByEvmId } from "@/lib/attestcoin/chains";
import { fetchBatchProofs } from "@/lib/attestcoin/batch";
import {
  submissionAvailability,
  submissionEnv,
  submitProofGroupsOnChain,
  type BatchSubmitGroup,
} from "@/lib/attestcoin/submit";

export const dynamic = "force-dynamic";

/**
 * How many candidate payments one request may consider. The protocol caps a
 * batch verification at 10 proofs (MAX_BATCH_SIZE) — the submit layer chunks
 * by that and the 1000-block range (MAX_BATCH_RANGE) automatically; this is
 * just the candidate budget per request.
 */
const CANDIDATE_LIMIT = 30;

interface SkippedItem {
  id: string;
  reason: "pending" | "unsupported_chain";
}

/**
 * WRITE half, batch flavor — POST /api/payments/attest-batch.
 *
 * G3: proofs are fetched with ONE getBatchProof REST call per chainKey group
 * (≤10 hashes) — the builder constructs the shared continuity proof, which is
 * exactly what verifyAndEmitBatch expects (no more "longest proof wins"
 * heuristic). Per-tx fallback covers payments whose group couldn't be served
 * batch-wise.
 *
 * G2: the submit layer chunks every group to ≤10 proofs and <1000-block span
 * (the protocol's hard batch limits) before each Creditcoin transaction.
 *
 * Persists cc3TxHash + onchain_verified_at per payment and returns a
 * structured summary. Requires CREDITCOIN_SIGNER_KEY; 501 otherwise.
 */
export async function POST() {
  ensureDb();

  const availability = submissionAvailability();
  if (!availability.configured) {
    return NextResponse.json(
      {
        ok: false,
        configured: false,
        requiredEnv: availability.requiredEnv,
        env: submissionEnv(),
        hint:
          "Set CREDITCOIN_SIGNER_KEY to the private key of a funded Creditcoin account to enable on-chain proof submission.",
      },
      { status: 501 },
    );
  }

  // G1 — live chain-key resolution before grouping.
  await ensureSourceChainMapFresh();

  const candidates = db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.status, "settled"),
        isNotNull(payments.txHash),
        ne(payments.txHash, ""),
        ne(payments.txHash, "0x0"),
        isNull(payments.cc3TxHash),
      ),
    )
    .orderBy(desc(payments.createdAt))
    .limit(CANDIDATE_LIMIT)
    .all();

  if (candidates.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No payments are eligible for batch submission.", env: submissionEnv() },
      { status: 409 },
    );
  }

  // Group by chainKey (one builder batch call + one set of Creditcoin txs per
  // source chain); unsupported chains skip with a reason.
  const groups = new Map<number, { row: (typeof candidates)[number] }[]>();
  const skipped: SkippedItem[] = [];
  for (const row of candidates) {
    const chain = row.chainId ? sourceChainByEvmId(row.chainId) : undefined;
    if (!chain || !row.txHash) {
      skipped.push({ id: row.id, reason: "unsupported_chain" });
      continue;
    }
    const bucket = groups.get(chain.chainKey);
    if (bucket) bucket.push({ row });
    else groups.set(chain.chainKey, [{ row }]);
  }

  const submitGroups: BatchSubmitGroup[] = [];

  for (const [chainKey, members] of groups) {
    // One builder call per ≤10 hashes (protocol batch size).
    for (let i = 0; i < members.length; i += 10) {
      const slice = members.slice(i, i + 10);
      const batch = await fetchBatchProofs(
        chainKey,
        slice.map((m) => m.row.txHash!),
      ).catch(() => null);

      if (batch && batch.state === "proof" && batch.sharedContinuity) {
        // Batch path: shared continuity proof from the builder (G3).
        const byHash = new Map(batch.entries.map((e) => [e.txHash.toLowerCase(), e]));
        const items = slice.flatMap((m) => {
          const entry = byHash.get(m.row.txHash!.toLowerCase());
          if (!entry) return [];
          return [
            {
              paymentId: m.row.id,
              raw: {
                chainKey,
                headerNumber: entry.headerNumber,
                txBytes: entry.txBytes,
                merkleProof: entry.merkleProof,
                continuityProof: entry.continuityProof,
              },
            },
          ];
        });
        if (items.length > 0) {
          submitGroups.push({ chainKey, items, sharedContinuity: batch.sharedContinuity });
          continue;
        }
      }

      // Per-tx fallback — a batch-unservable group may still contain
      // individually-attested payments (fetch each, keep pending skips).
      for (const m of slice) {
        const outcome = await getTxProof(chainKey, m.row.txHash!).catch(() => null);
        if (outcome && outcome.state === "proof" && outcome.raw) {
          const group = submitGroups.find((g) => g.chainKey === chainKey && !g.sharedContinuity);
          const item = { paymentId: m.row.id, raw: outcome.raw };
          if (group) group.items.push(item);
          else submitGroups.push({ chainKey, items: [item] });
        } else {
          skipped.push({ id: m.row.id, reason: "pending" });
        }
      }
    }
  }

  if (submitGroups.length === 0 || submitGroups.every((g) => g.items.length === 0)) {
    return NextResponse.json(
      {
        ok: false,
        error: "No proofs are available yet — blocks must be attested on Creditcoin first.",
        skipped,
        env: submissionEnv(),
      },
      { status: 409 },
    );
  }

  const result = await submitProofGroupsOnChain(submitGroups);
  if (!result.ok || result.perPayment.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: "On-chain batch submission failed.",
        detail: result.detail,
        skipped,
        env: submissionEnv(),
      },
      { status: 502 },
    );
  }

  // Persist per payment — conditional UPDATE so a concurrent single-payment
  // submission that got there first wins without double-writing.
  let persisted = 0;
  for (const entry of result.perPayment) {
    const update = db
      .update(payments)
      .set({ cc3TxHash: entry.cc3TxHash, onchainVerifiedAt: Date.now() })
      .where(and(eq(payments.id, entry.paymentId), isNull(payments.cc3TxHash)))
      .run();
    persisted += update.changes;
  }

  // P24: batch on-chain submission logging (same as the single attest route).
  logAppAction({
    tool: "submit_proof_onchain",
    params: { batch: true, paymentIds: result.perPayment.map((e: { paymentId: string }) => e.paymentId) },
    status: "succeeded",
    summary: `Batch proof submission: ${result.perPayment.length} payment proof(s) submitted on-chain (verifyAndEmit, ${result.gasUsed ?? "?"} gas).`,
    riskClass: "deploy",
    chainId: 102031,
    cc3TxHash: result.perPayment[0].cc3TxHash ?? null,
  });
  return NextResponse.json({
    ok: true,
    submittedCount: result.perPayment.length,
    persistedCount: persisted,
    skipped,
    cc3TxHash: result.perPayment[0].cc3TxHash,
    events: result.events,
    gasUsed: result.gasUsed,
    /** G7 — submission gas as a share of the Creditcoin block cap (75M). */
    gasPctOfBlock: result.gasPctOfBlock,
    /** G3 audit trail — how each batch tx obtained its shared continuity proof. */
    proofSource: result.proofSource,
    signerAddress: availability.signerAddress,
    env: submissionEnv(),
  });
}
