import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, ensureDb } from "@/db";
import { agentActions, payments, type AgentActionRow, type PaymentRow } from "@/db/schema";
import { getTxProof } from "@/lib/attestcoin/proof";
import { ensureSourceChainMapFresh, sourceChainByEvmId } from "@/lib/attestcoin/chains";
import { verifyProofOnChain } from "@/lib/attestcoin/verify";
import { getAttestcoinStatus } from "@/lib/attestcoin/status";

// ─────────────────────────────────────────────────────────────────────────────
// AC6 — attestation CERTIFICATE export.
//
// The owner's gap: the Actions tab can *verify* on the spot that a tx got
// attested (R24's read-only proof lookup), but the result lived only in the
// UI — there was no way to hand the attestation to anyone else. This route
// mints the portable artifact: a JSON download in EXACTLY the schema the
// existing verifier consumes (schema "acp.attestation-certificate/v1", the
// same field names the payments-page "Export proof" button emits), so a
// third party can drop the file into the verifier and re-check it live
// (builder + Block Prover Precompile + decoded receipt) without trusting us.
//
//   GET /api/attestcoin/certificate?type=payment&id=<paymentId>
//   GET /api/attestcoin/certificate?type=action&id=<actionId>
//
// Gates:
//   payment → row must carry attestedAt (the poller's proof-seen stamp).
//   action  → attestation evidence must exist: EITHER the row's persisted
//             attestRoot, OR a live proof served by the builder right now
//             (covers rows the R24 check just proved but the poller hasn't
//             stamped yet — defensive against Task 6's agent_actions poller
//             still landing; reads only columns that exist TODAY).
//   Anything else → 409 "not attested yet — no certificate exists": an
//   unattested tx has nothing to certify, and minting a placeholder file
//   would be a lie the verifier would expose anyway.
//
// The live proof (getTxProof) enriches the certificate with the fresh
// merkleRoot/headerNumber/txIndex AND the replayable raw proof (txBytes +
// Merkle siblings + continuity roots) — that raw payload is what lets the
// verifier run its onchain + receipt checks. If the builder is unreachable
// but the row has persisted attestation refs (attestRoot), the certificate
// is still emitted from the persisted data: it is a RECORD of what was
// attested and when; the verifier re-derives everything live regardless.
// ─────────────────────────────────────────────────────────────────────────────

export const revalidate = 0;
export const dynamic = "force-dynamic";

const NOT_ATTESTED = "Not attested yet — no certificate exists.";
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;

/** Parse a JSON object column without ever throwing (null on garbage). */
function safeParseObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The tx/chain refs an agent action's result JSON carries, if any. */
function actionResultRefs(row: AgentActionRow): { txHash?: string; chainId?: number } {
  const parsed = row.resultJson ? safeParseObject(row.resultJson) : null;
  if (!parsed) return {};
  return {
    ...(typeof parsed.txHash === "string" && parsed.txHash ? { txHash: parsed.txHash } : {}),
    ...(typeof parsed.chainId === "number" ? { chainId: parsed.chainId } : {}),
  };
}

/** `attachment; filename="…"` download disposition (ids are sanitized). */
function downloadResponse(certificate: unknown, type: string, id: string): NextResponse {
  const res = NextResponse.json(certificate);
  const safeId = id.replace(/[^A-Za-z0-9._-]/g, "_");
  res.headers.set("content-disposition", `attachment; filename="acp-certificate-${type}-${safeId}.json"`);
  return res;
}

export async function GET(request: Request) {
  ensureDb();
  const url = new URL(request.url);
  const type = url.searchParams.get("type");
  const id = url.searchParams.get("id") ?? "";

  if (!id) {
    return NextResponse.json({ error: "Missing id query parameter." }, { status: 400 });
  }
  if (type !== "payment" && type !== "action") {
    return NextResponse.json({ error: 'type must be "payment" or "action".' }, { status: 400 });
  }

  // ── Subject row + per-type gates ──────────────────────────────────────────
  let txHash: string;
  let chainId: number;
  let persistedRoot: string | null;
  let cc3TxHash: string | null;
  let contextBlock: Record<string, unknown>;

  if (type === "payment") {
    const row: PaymentRow | undefined = db.select().from(payments).where(eq(payments.id, id)).get();
    if (!row) {
      return NextResponse.json({ error: "Payment not found." }, { status: 404 });
    }
    if (!row.attestedAt) {
      return NextResponse.json({ error: `Payment ${NOT_ATTESTED}` }, { status: 409 });
    }
    if (!row.txHash || row.txHash === "0x0" || row.txHash === "") {
      // Defensive: attestedAt is only ever stamped on rows with a tx — but a
      // certificate without a txHash is unverifiable, so refuse honestly.
      return NextResponse.json({ error: "Payment has no transaction hash — no certificate exists." }, { status: 409 });
    }
    txHash = row.txHash;
    chainId = row.chainId;
    persistedRoot = row.attestRoot;
    cc3TxHash = row.cc3TxHash;
    // Same field names as the payments-page "Export proof" certificate, so a
    // verifier render of either export looks identical.
    contextBlock = {
      id: row.id,
      recipient: row.recipientAddress,
      recipientLabel: row.recipientLabel ?? null,
      sender: row.senderAddress ?? null,
      token: row.token,
      amountHuman: row.amountHuman,
      memo: row.memo ?? null,
      chainId: row.chainId,
      status: row.status,
      createdAt: row.createdAt,
      settledAt: row.settledAt ?? null,
      attestedAt: row.attestedAt,
      attestRoot: row.attestRoot ?? null,
    };
  } else {
    const row: AgentActionRow | undefined = db.select().from(agentActions).where(eq(agentActions.id, id)).get();
    if (!row) {
      return NextResponse.json({ error: "Action not found." }, { status: 404 });
    }
    const refs = actionResultRefs(row);
    const actionTx = row.sourceTxHash ?? refs.txHash;
    if (!actionTx) {
      return NextResponse.json({ error: `Action ${NOT_ATTESTED}` }, { status: 409 });
    }
    const actionChain = row.chainId ?? refs.chainId ?? null;
    if (actionChain == null) {
      return NextResponse.json({ error: `Action ${NOT_ATTESTED}` }, { status: 409 });
    }
    txHash = actionTx;
    chainId = actionChain;
    persistedRoot = row.attestRoot;
    cc3TxHash = row.cc3TxHash;
    contextBlock = {
      id: row.id,
      tool: row.tool,
      status: row.status,
      riskClass: row.riskClass,
      chainId: row.chainId,
      createdAt: row.createdAt,
      completedAt: row.completedAt ?? null,
      sourceTxHash: row.sourceTxHash ?? null,
      attestRoot: row.attestRoot ?? null,
      result: row.resultJson ? safeParseObject(row.resultJson) : null,
    };
  }

  // G1 — live chain-key resolution (same rule as every other attestcoin
  // route: never a wrong-chain answer on mainnet).
  await ensureSourceChainMapFresh();
  const chain = sourceChainByEvmId(chainId);
  if (!chain) {
    return NextResponse.json(
      { error: `Chain ${chainId} is not tracked by the Attestcoin integration — no certificate can reference it.` },
      { status: 409 },
    );
  }

  // ── Live proof (enrichment + the attestation evidence for unstamped rows) ──
  const outcome = await getTxProof(chain.chainKey, txHash);
  const live = outcome.state === "proof" ? outcome.proof : undefined;
  const raw = outcome.state === "proof" ? outcome.raw : undefined;

  // A usable merkle root is the one field the verifier hard-requires — take
  // the live one (freshest; an EMPTY root from a degraded builder response
  // counts as absent), else the persisted attestRoot.
  const liveRoot = live?.merkleRoot ? live.merkleRoot : undefined;
  const merkleRoot = liveRoot ?? persistedRoot ?? undefined;
  if (!merkleRoot || !HEX_32.test(merkleRoot)) {
    return NextResponse.json(
      {
        error: `${type === "payment" ? "Payment" : "Action"} ${NOT_ATTESTED}`,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      },
      { status: 409 },
    );
  }

  // ── Optional live context (read-only, best-effort — matches what the
  // payments-page export embeds so both certificates carry the same shape) ──
  const onchain = raw ? await verifyProofOnChain(raw) : null;
  const status = await getAttestcoinStatus().catch(() => null);
  const chainRow = status?.chains.find((c) => c.chainKey === chain.chainKey) ?? null;

  const certificate = {
    schema: "acp.attestation-certificate/v1",
    exportedAt: new Date().toISOString(),
    // The verifier passes this block through untouched — it exists so a human
    // (or the payments page) can see WHAT was attested, not just the proof.
    ...(type === "payment" ? { payment: contextBlock } : { action: contextBlock }),
    source: {
      chain: chain.name,
      chainKey: chain.chainKey,
      evmChainId: chain.evmChainId,
      txHash,
    },
    proof: {
      // From the live proof when the builder served one; the persisted-only
      // fallback certificate omits headerNumber/txIndex (the verifier then
      // reports exactly which claim it cannot re-check — honest degradation).
      ...(live ? { headerNumber: live.headerNumber } : {}),
      ...(live ? { transactionIndex: live.txIndex } : {}),
      merkleRoot,
      ...(live ? { merkleSiblings: live.merkleSiblings } : {}),
      ...(live ? { continuityRoots: live.continuityRoots } : {}),
      ...(live ? { continuityLowerEndpoint: live.continuityLowerEndpoint } : {}),
      generatedAt: live?.generatedAt ?? null,
      servedFromCache: live?.cached ?? null,
      // Replayable proof objects — what the verifier re-submits to the Block
      // Prover Precompile and the EvmV1Decoder. Same shape the payment
      // attestcoin route serves under ?include=raw.
      ...(raw
        ? {
            raw: {
              chainKey: raw.chainKey,
              headerNumber: raw.headerNumber,
              txBytes: raw.txBytes,
              merkleProof: raw.merkleProof,
              continuityProof: raw.continuityProof,
            },
          }
        : {}),
    },
    onchain: onchain
      ? {
          verified: onchain.verified,
          transactionIndex: onchain.txIndex,
          precompile: onchain.precompile,
          verifiedAt: new Date(onchain.verifiedAt).toISOString(),
        }
      : null,
    network: status
      ? {
          env: status.env,
          cc3Block: status.cc3Block,
          attestedHeight: chainRow?.attestedHeight ?? null,
          sourceHead: chainRow?.sourceHead ?? null,
          lag: chainRow?.lag ?? null,
        }
      : null,
    creditcoinSubmission: cc3TxHash ? { cc3TxHash } : null,
  };

  return downloadResponse(certificate, type, id);
}
