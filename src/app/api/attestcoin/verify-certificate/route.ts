import { NextResponse } from "next/server";
import { attestcoinEnv } from "@/lib/attestcoin/config";
import { ensureSourceChainMapFresh, sourceChainByKey } from "@/lib/attestcoin/chains";
import { getTxProof, proofCostContext } from "@/lib/attestcoin/proof";
import { verifyProofOnChain } from "@/lib/attestcoin/verify";
import { decodeTxBytes } from "@/lib/attestcoin/decode";
import { getAttestcoinStatus } from "@/lib/attestcoin/status";

export const revalidate = 0;
export const dynamic = "force-dynamic";

// ─────────────────────────────────────────────────────────────────────────────
// Attestcoin attestation-certificate verifier.
//
// POST body: an exported certificate JSON (schema acp.attestation-certificate/v1,
// as produced by the payments page "Export proof" button — including the
// replayable raw proof when it was exported with ?include=raw), OR a compact
// attestation reference (schema acp.attestation-ref/v1, as carried by the
// "Share QR" code — chain/tx/root/height only).
//
// Re-runs the verification pipeline against LIVE data:
//   1. schema        — the certificate is structurally the artifact we mint
//   2. consistency   — the embedded raw proof matches the claimed summary
//                      (merkle root, header number, sibling/root counts)
//   3. builder       — the hosted proof builder still serves a proof for the
//                      same tx with the same merkle root + block height
//   4. onchain       — the Creditcoin Block Prover Precompile (0x0FD2) accepts
//                      the embedded proof (read-only eth_call, no signer)
//   5. receipt       — C2/G4: the EvmV1Decoder decodes the embedded txBytes
//                      and the receipt status must be SUCCESS. The precompile
//                      proves the tx WAS in an attested block but never checks
//                      that it succeeded — this check closes that hole.
//
// A third party holding a certificate can therefore confirm the proof without
// trusting the exporter — the checks only pass if today's chain + builder agree.
// ─────────────────────────────────────────────────────────────────────────────

type CheckStatus = "pass" | "fail" | "skip";

interface CheckResult {
  id: "schema" | "consistency" | "builder" | "onchain" | "receipt";
  status: CheckStatus;
  /** English technical detail (the UI localizes labels itself). */
  detail: string;
  data?: Record<string, unknown>;
}

/** Shape of the raw proof payload embedded in certificates (proof.raw). */
interface CertificateRawProof {
  chainKey: number;
  headerNumber: number;
  txBytes: string;
  merkleProof: { root?: string; siblings?: unknown[] };
  continuityProof: { lowerEndpointDigest?: string; roots?: unknown[] };
}

const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_TX = /^0x[0-9a-fA-F]{40,128}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function POST(request: Request) {
  let raw: unknown;
  try {
    const text = await request.text();
    // Hard cap — raw proofs run a few tens of KB; anything larger is abuse.
    if (text.length > 512_000) {
      return NextResponse.json({ error: "Certificate too large." }, { status: 413 });
    }
    raw = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Body is not valid JSON." }, { status: 400 });
  }

  if (!isObject(raw)) {
    return NextResponse.json({ error: "Certificate must be a JSON object." }, { status: 400 });
  }

  // ── Compact reference normalization (acp.attestation-ref/v1) ──────────────
  // QR codes can't carry the full certificate — the "Share QR" flow emits a
  // compact reference instead. Remap it onto the certificate shape so the
  // SAME pipeline verifies it (builder lookup + summary checks run; the raw
  // consistency + onchain checks skip — there is no embedded proof).
  const body: Record<string, unknown> =
    raw.schema === "acp.attestation-ref/v1"
      ? ({
          schema: "acp.attestation-certificate/v1",
          exportedAt: null,
          source: {
            chainKey: raw.chainKey,
            chain: raw.chain,
            txHash: raw.txHash,
          },
          proof: {
            merkleRoot: raw.merkleRoot,
            headerNumber: raw.headerNumber,
            transactionIndex: raw.txIndex,
          },
          ...(typeof raw.network === "string" ? { network: { env: raw.network } } : {}),
        } as Record<string, unknown>)
      : raw;

  const env = attestcoinEnv();
  const checks: CheckResult[] = [];

  // G1 — live chain-key resolution before the tracked-chain validation.
  await ensureSourceChainMapFresh();

  // ── 1. Schema / structural validation ────────────────────────────────────
  let chainKey: number | null = null;
  let txHash: string | null = null;
  {
    const problems: string[] = [];
    if (body.schema !== "acp.attestation-certificate/v1") {
      problems.push(`schema "${String(body.schema)}" is not acp.attestation-certificate/v1`);
    }
    const source = isObject(body.source) ? body.source : null;
    const proof = isObject(body.proof) ? body.proof : null;
    const sourceChainKey = source?.chainKey;
    const sourceTxHash = source?.txHash;
    const merkleRoot = proof?.merkleRoot;

    if (typeof sourceChainKey !== "number" || !sourceChainByKey(sourceChainKey)) {
      problems.push(`source.chainKey ${String(sourceChainKey)} is not a tracked chain`);
    }
    if (typeof sourceTxHash !== "string" || !HEX_TX.test(sourceTxHash)) {
      problems.push("source.txHash is not a transaction hash");
    }
    if (typeof merkleRoot !== "string" || !HEX_32.test(merkleRoot)) {
      problems.push("proof.merkleRoot is not a 32-byte hash");
    }
    if (proof && typeof proof.headerNumber !== "number") {
      problems.push("proof.headerNumber is missing");
    }

    const certEnv = isObject(body.network) ? body.network.env : undefined;
    const networkNote =
      typeof certEnv === "string" && certEnv !== env
        ? `certificate was exported on ${certEnv}; this server verifies against ${env}`
        : undefined;

    checks.push({
      id: "schema",
      status: problems.length === 0 ? "pass" : "fail",
      detail:
        problems.length === 0
          ? (networkNote ?? "schema acp.attestation-certificate/v1 with all required fields")
          : problems.join("; "),
      ...(networkNote && problems.length === 0 ? { data: { networkNote } } : {}),
    });

    // Without a valid chainKey + txHash the remaining checks cannot run.
    if (problems.length > 0 || typeof sourceChainKey !== "number" || typeof sourceTxHash !== "string") {
      return NextResponse.json({
        ok: false,
        network: env,
        checks,
        payment: isObject(body.payment) ? body.payment : null,
        certificateExportedAt: typeof body.exportedAt === "string" ? body.exportedAt : null,
      });
    }
    chainKey = sourceChainKey;
    txHash = sourceTxHash;
  }

  const chain = sourceChainByKey(chainKey)!;
  const proofBody = isObject(body.proof) ? body.proof : {};
  const rawProof = isObject(proofBody.raw) ? (proofBody.raw as unknown as CertificateRawProof) : null;

  // ── 2. Internal consistency (raw payload vs claimed summary) ─────────────
  if (rawProof && typeof rawProof.headerNumber === "number") {
    const problems: string[] = [];
    const rawRoot = rawProof.merkleProof?.root;
    const rawSiblings = rawProof.merkleProof?.siblings?.length;
    const rawRoots = rawProof.continuityProof?.roots?.length;
    const rawEndpoint = rawProof.continuityProof?.lowerEndpointDigest;

    if (rawRoot !== proofBody.merkleRoot) {
      problems.push("raw merkle root differs from the claimed proof.merkleRoot");
    }
    if (rawProof.headerNumber !== proofBody.headerNumber) {
      problems.push("raw header number differs from the claimed proof.headerNumber");
    }
    if (rawProof.chainKey !== chainKey) {
      problems.push("raw chain key differs from source.chainKey");
    }
    if (typeof rawSiblings === "number" && typeof proofBody.merkleSiblings === "number" && rawSiblings !== proofBody.merkleSiblings) {
      problems.push("raw sibling count differs from proof.merkleSiblings");
    }
    if (typeof rawRoots === "number" && typeof proofBody.continuityRoots === "number" && rawRoots !== proofBody.continuityRoots) {
      problems.push("raw continuity root count differs from proof.continuityRoots");
    }
    if (typeof rawEndpoint === "string" && typeof proofBody.continuityLowerEndpoint === "string" && rawEndpoint !== proofBody.continuityLowerEndpoint) {
      problems.push("raw continuity endpoint differs from proof.continuityLowerEndpoint");
    }
    if (!rawProof.txBytes || typeof rawProof.txBytes !== "string") {
      problems.push("raw txBytes is missing — the proof is not replayable");
    }

    checks.push({
      id: "consistency",
      status: problems.length === 0 ? "pass" : "fail",
      detail:
        problems.length === 0
          ? "embedded raw proof matches every claimed summary field"
          : problems.join("; "),
    });
  } else {
    checks.push({
      id: "consistency",
      status: "skip",
      detail: "certificate carries no raw proof payload (summary-only export)",
    });
  }

  // ── 3. Live proof-builder lookup ─────────────────────────────────────────
  const outcome = await getTxProof(chainKey, txHash);
  const claimedRoot = typeof proofBody.merkleRoot === "string" ? proofBody.merkleRoot : "";
  const claimedHeight = typeof proofBody.headerNumber === "number" ? proofBody.headerNumber : null;
  if (outcome.state === "proof" && outcome.proof) {
    const fresh = outcome.proof;
    const rootMatch = fresh.merkleRoot === claimedRoot;
    const heightMatch = claimedHeight === null || fresh.headerNumber === claimedHeight;
    // G7 — verification cost estimate for the proof the builder serves now.
    const attestedHeight = await getAttestcoinStatus()
      .then((s) => s.chains.find((c) => c.chainKey === chainKey)?.attestedHeight ?? null)
      .catch(() => null);
    const cost = proofCostContext(fresh, attestedHeight);
    checks.push({
      id: "builder",
      status: rootMatch && heightMatch ? "pass" : "fail",
      detail:
        rootMatch && heightMatch
          ? `builder serves the same proof (block ${fresh.headerNumber}, ${fresh.continuityRoots} continuity roots, verification ${cost.ctcLabel}${cost.stale ? " — STALE, pricier" : ""})`
          : rootMatch
            ? `builder block height ${fresh.headerNumber} differs from claimed ${claimedHeight}`
            : "builder serves a DIFFERENT merkle root than the certificate claims",
      data: {
        freshMerkleRoot: fresh.merkleRoot,
        freshHeaderNumber: fresh.headerNumber,
        freshContinuityRoots: fresh.continuityRoots,
        state: outcome.state,
        estimatedCtc: cost.estimatedCtc,
        stale: cost.stale,
      },
    });
  } else if (outcome.state === "pending") {
    checks.push({
      id: "builder",
      status: "skip",
      detail: "the builder does not currently serve a proof for this tx",
      data: { state: outcome.state, detail: outcome.detail ?? null },
    });
  } else {
    checks.push({
      id: "builder",
      status: "fail",
      detail: outcome.detail ?? `builder lookup failed (${outcome.state})`,
      data: { state: outcome.state },
    });
  }

  // ── 4. On-chain verdict (Block Prover Precompile, read-only) ─────────────
  if (rawProof && rawProof.merkleProof && rawProof.continuityProof && rawProof.txBytes) {
    const onchain = await verifyProofOnChain({
      chainKey: typeof rawProof.chainKey === "number" ? rawProof.chainKey : chainKey,
      headerNumber:
        typeof rawProof.headerNumber === "number" ? rawProof.headerNumber : (claimedHeight ?? 0),
      txBytes: rawProof.txBytes,
      merkleProof: rawProof.merkleProof as never,
      continuityProof: rawProof.continuityProof as never,
    });
    if (onchain) {
      checks.push({
        id: "onchain",
        status: onchain.verified ? "pass" : "fail",
        detail: onchain.verified
          ? `Block Prover precompile accepted the embedded proof (tx index ${onchain.txIndex ?? "?"})`
          : "the Creditcoin precompile REJECTED the embedded proof",
        data: {
          verified: onchain.verified,
          txIndex: onchain.txIndex,
          precompile: onchain.precompile,
          verifiedAt: onchain.verifiedAt,
        },
      });
    } else {
      checks.push({
        id: "onchain",
        status: "skip",
        detail: "precompile call timed out or failed — try again",
      });
    }
  } else {
    checks.push({
      id: "onchain",
      status: "skip",
      detail: "no replayable proof in the certificate — export with the raw payload to enable this check",
    });
  }

  // ── 5. Receipt verdict (EvmV1Decoder, read-only — C2/G4) ─────────────────
  // The precompile proves the tx was in an attested block; the DECODER
  // decodes the embedded txBytes and tells us whether the tx SUCCEEDED.
  // Without this, a reverted-but-attested tx would verify clean.
  if (rawProof && rawProof.merkleProof && rawProof.continuityProof && rawProof.txBytes) {
    const decoded = await decodeTxBytes(rawProof.txBytes, txHash);
    if (decoded) {
      checks.push({
        id: "receipt",
        status: decoded.receiptStatus === "success" ? "pass" : "fail",
        detail:
          decoded.receiptStatus === "success"
            ? `decoder: type-${decoded.type} tx ${decoded.from.slice(0, 10)}… → ${decoded.to ? decoded.to.slice(0, 10) + "…" : "contract creation"}, receipt SUCCESS (gas ${decoded.receiptGasUsed ?? "?"})`
            : "decoder: the attested transaction REVERTED — inclusion proof is valid but the transfer failed",
        data: {
          from: decoded.from,
          to: decoded.to,
          value: decoded.valueEther,
          type: decoded.type,
          receiptStatus: decoded.receiptStatus,
        },
      });
    } else {
      checks.push({
        id: "receipt",
        status: "skip",
        detail: "decoder call failed — receipt status unknown",
      });
    }
  } else {
    checks.push({
      id: "receipt",
      status: "skip",
      detail: "no replayable proof in the certificate — export with the raw payload to enable this check",
    });
  }

  // ── Overall verdict ──────────────────────────────────────────────────────
  const failed = checks.some((c) => c.status === "fail");
  const strongPass = checks.some(
    (c) => (c.id === "builder" || c.id === "onchain") && c.status === "pass",
  );
  const ok = !failed && strongPass;

  return NextResponse.json({
    ok,
    network: env,
    chain: { chainKey: chain.chainKey, evmChainId: chain.evmChainId, name: chain.name },
    txHash,
    checks,
    payment: isObject(body.payment) ? body.payment : null,
    certificateExportedAt: typeof body.exportedAt === "string" ? body.exportedAt : null,
  });
}
