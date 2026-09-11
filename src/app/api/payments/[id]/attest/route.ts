import { NextResponse } from "next/server";
import { logAppAction } from "@/lib/agent/action-log";
import { and, eq } from "drizzle-orm";
import { db, ensureDb } from "@/db";
import { payments } from "@/db/schema";
import { getTxProof } from "@/lib/attestcoin/proof";
import { ensureSourceChainMapFresh, sourceChainByEvmId } from "@/lib/attestcoin/chains";
import { submissionAvailability, submissionEnv, submitProofOnChain } from "@/lib/attestcoin/submit";

export const revalidate = 0;
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * WRITE half of the Phase-2 Attestcoin integration — submit the payment's
 * transfer proof to the Block Prover Precompile (0x0FD2) on Creditcoin as a
 * signed transaction (verifyAndEmitSingle). Success emits a
 * TransactionVerified(chainKey, height, transactionIndex) event and this
 * route persists the Creditcoin tx hash on the payment row.
 *
 * Requires a funded Creditcoin signer (env CREDITCOIN_SIGNER_KEY). When the
 * key is absent the route answers 501 with a structured hint so the UI can
 * explain how to enable submissions instead of failing opaquely.
 */
export async function POST(_request: Request, { params }: RouteParams) {
  ensureDb();
  const { id } = await params;

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

  const row = db.select().from(payments).where(eq(payments.id, id)).get();
  if (!row) {
    return NextResponse.json({ ok: false, error: "Payment not found." }, { status: 404 });
  }

  const txHash = row.txHash;
  if (!txHash || txHash === "0x0" || txHash === "") {
    return NextResponse.json(
      { ok: false, error: "Payment has no transaction hash — nothing to submit." },
      { status: 400 },
    );
  }

  // G1 — live chain-key resolution (never a wrong-chain answer on mainnet).
  await ensureSourceChainMapFresh();
  const chain = sourceChainByEvmId(row.chainId);
  if (!chain) {
    return NextResponse.json(
      { ok: false, error: `Chain ${row.chainId} is not tracked by the Attestcoin integration yet.` },
      { status: 404 },
    );
  }

  // Already submitted? Idempotent answer with the existing receipt.
  if (row.cc3TxHash) {
    return NextResponse.json({
      ok: true,
      already: true,
      cc3TxHash: row.cc3TxHash,
      env: submissionEnv(),
    });
  }

  const outcome = await getTxProof(chain.chainKey, txHash);
  if (outcome.state !== "proof" || !outcome.proof) {
    return NextResponse.json(
      {
        ok: false,
        error: "No proof available yet — the block must be attested on Creditcoin first.",
        state: outcome.state,
      },
      { status: 409 },
    );
  }
  if (!outcome.raw) {
    return NextResponse.json(
      { ok: false, error: "Proof builder served no verifiable proof payload." },
      { status: 502 },
    );
  }

  const result = await submitProofOnChain(outcome.raw);
  if (!result.ok || !result.cc3TxHash) {
    return NextResponse.json(
      { ok: false, error: "On-chain submission failed.", detail: result.detail },
      { status: 502 },
    );
  }

  db.update(payments)
    .set({ cc3TxHash: result.cc3TxHash, onchainVerifiedAt: Date.now() })
    .where(and(eq(payments.id, row.id), eq(payments.status, "settled")))
    .run();
  // P24: an on-chain Creditcoin submission (real gas, public verification
  // record) from the Payments page must be in the action log with its CC3 tx.
  logAppAction({
    tool: "submit_proof_onchain",
    params: { paymentId: row.id, sourceTxHash: row.txHash ?? null },
    status: "succeeded",
    summary: `Proof submitted on-chain for payment ${row.id.slice(0, 8)}… (verifyAndEmit via the app submission account, ${result.gasUsed ?? "?"} gas).`,
    riskClass: "deploy",
    chainId: 102031,
    cc3TxHash: result.cc3TxHash ?? null,
    sourceTxHash: row.txHash ?? null,
  });

  return NextResponse.json({
    ok: true,
    already: false,
    cc3TxHash: result.cc3TxHash,
    event: result.event,
    gasUsed: result.gasUsed,
    signerAddress: availability.signerAddress,
    env: submissionEnv(),
  });
}
