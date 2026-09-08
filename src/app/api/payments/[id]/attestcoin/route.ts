import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { createPublicClient, http } from "viem";
import { db, ensureDb } from "@/db";
import { payments } from "@/db/schema";
import { getTxProof, proofCostContext } from "@/lib/attestcoin/proof";
import { ensureSourceChainMapFresh, sourceChainByEvmId } from "@/lib/attestcoin/chains";
import { getAttestcoinStatus, getAttestationBounds } from "@/lib/attestcoin/status";
import { verifyProofOnChain } from "@/lib/attestcoin/verify";
import { decodeTxBytes } from "@/lib/attestcoin/decode";
import { submissionAvailability } from "@/lib/attestcoin/submit";
import { VIEM_CHAINS, getChainByChainId } from "@/lib/chains/registry";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Attestcoin Protocol attestation lookup for a payment's transfer transaction:
 * resolves the payment's chainId to a Creditcoin chain key, then asks the
 * hosted Proof Builder for a Merkle + continuity proof of the tx. When a
 * proof exists it is additionally verified against the Block Prover
 * Precompile (0x0FD2) via a read-only eth_call — the `onchain` field reports
 * the chain's own verdict (no signer needed).
 *
 * The response also advertises whether on-chain proof SUBMISSION is possible
 * (`submission`) — a signed Creditcoin tx via POST /api/payments/[id]/attest,
 * gated by the CREDITCOIN_SIGNER_KEY env var.
 *
 * `?include=raw` additionally returns the full Merkle + continuity proof
 * objects (txBytes, siblings, roots) so the exported certificate carries the
 * REPLAYABLE proof — enough for a third party to re-run verification against
 * the Block Prover Precompile themselves.
 */
export async function GET(request: Request, { params }: RouteParams) {
  ensureDb();
  const { id } = await params;

  const row = db.select().from(payments).where(eq(payments.id, id)).get();
  if (!row) {
    return NextResponse.json({ error: "Payment not found." }, { status: 404 });
  }

  const txHash = row.txHash;
  if (!txHash || txHash === "0x0" || txHash === "") {
    return NextResponse.json(
      { error: "Payment has no transaction hash — nothing to attest." },
      { status: 400 },
    );
  }

  // G1 — live chain-key resolution (never a wrong-chain answer on mainnet).
  await ensureSourceChainMapFresh();
  const chain = sourceChainByEvmId(row.chainId);
  if (!chain) {
    return NextResponse.json(
      { error: `Chain ${row.chainId} is not tracked by the Attestcoin integration yet.` },
      { status: 404 },
    );
  }

  const [outcome, status] = await Promise.all([
    getTxProof(chain.chainKey, txHash),
    getAttestcoinStatus().catch(() => null),
  ]);

  // Read-only on-chain verification via the Block Prover Precompile — the
  // Creditcoin chain itself re-checks the proof. Persist the first success.
  const { raw, ...serializable } = outcome;
  let onchain = null;
  if (raw && outcome.state === "proof") {
    onchain = await verifyProofOnChain(raw);
    if (onchain?.verified) {
      db.update(payments)
        .set({ onchainVerifiedAt: onchain.verifiedAt })
        .where(and(eq(payments.id, row.id), isNull(payments.onchainVerifiedAt)))
        .run();
    }
  }

  const chainRow = status?.chains.find((c) => c.chainKey === chain.chainKey) ?? null;
  const includeRaw = new URL(request.url).searchParams.get("include") === "raw";

  // ── C2 enrichment ────────────────────────────────────────────────────────
  // G4 — decoded tx (protocol-native source of truth, straight from the
  //       proof's txBytes; includes the receipt-status verdict).
  // G7 — cost/freshness context for the proof.
  // G6 — attestation bounds while pending (which bracket the tx sits in).
  let decoded: Awaited<ReturnType<typeof decodeTxBytes>> = null;
  let cost: ReturnType<typeof proofCostContext> | null = null;
  let bounds: Awaited<ReturnType<typeof getAttestationBounds>> = null;

  if (outcome.state === "proof" && outcome.proof) {
    cost = proofCostContext(outcome.proof, chainRow?.attestedHeight ?? null);
    if (raw?.txBytes) {
      decoded = await decodeTxBytes(raw.txBytes, txHash);
    }
  } else if (outcome.state === "pending") {
    // Bounds need the tx's block height — one cheap source-chain lookup.
    try {
      const viemChain = VIEM_CHAINS[chain.evmChainId];
      const registryChain = getChainByChainId(chain.evmChainId);
      if (viemChain) {
        const client = createPublicClient({
          chain: viemChain,
          transport: http(registryChain?.rpcUrls?.[0], { timeout: 6_000, retryCount: 0 }),
        });
        const tx = await client.getTransaction({ hash: txHash as `0x${string}` });
        if (tx?.blockNumber != null) {
          bounds = await getAttestationBounds(chain.chainKey, Number(tx.blockNumber));
        }
      }
    } catch {
      bounds = null; // source RPC hiccup — bounds are optional context
    }
  }

  return NextResponse.json({
    paymentId: row.id,
    txHash,
    chain: { chainKey: chain.chainKey, evmChainId: chain.evmChainId, name: chain.name },
    ...serializable,
    ...(onchain ? { onchain } : {}),
    // G4 — what the verified tx actually was, decoded from the proof itself.
    ...(decoded ? { decoded } : {}),
    // G7 — verification cost estimate + freshness verdict.
    ...(cost ? { cost } : {}),
    // G6 — attestation bracket while the tx waits (null when already proven).
    ...(bounds ? { bounds } : {}),
    // Replayable proof payload — only when explicitly requested (the full
    // Merkle siblings + continuity roots make the response large).
    ...(includeRaw && raw && outcome.state === "proof"
      ? {
          rawProof: {
            chainKey: raw.chainKey,
            headerNumber: raw.headerNumber,
            txBytes: raw.txBytes,
            merkleProof: raw.merkleProof,
            continuityProof: raw.continuityProof,
          },
        }
      : {}),
    submission: submissionAvailability(),
    network: status
      ? {
          env: status.env,
          cc3Block: status.cc3Block,
          attestedHeight: chainRow?.attestedHeight ?? null,
          sourceHead: chainRow?.sourceHead ?? null,
          lag: chainRow?.lag ?? null,
        }
      : null,
  });
}
