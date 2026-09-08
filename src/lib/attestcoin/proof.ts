import { proofProvider } from "@gluwa/usc-sdk";
import { attestcoinEndpoints } from "./config";

// ─────────────────────────────────────────────────────────────────────────────
// Transaction inclusion proofs via the hosted Attestcoin Proof Builder
// (REST: GET {proofBuilderUrl}/api/v1/n/{chainKey}/{txHash}).
//
// A proof = Merkle proof (tx ∈ block) + continuity proof (block ∈ attested
// source chain). This module READS proofs only; submitting them to the
// Block Prover Precompile on Creditcoin is Phase 2 (needs a funded signer).
// ─────────────────────────────────────────────────────────────────────────────

export interface TxProof {
  chainKey: number;
  /** Source-chain block that contains the transaction. */
  headerNumber: number;
  /** Index of the tx inside the block. */
  txIndex: number;
  txHash: string;
  /** Raw transaction bytes (hex) — what the Block Prover verifies. */
  txBytes: string;
  /** Merkle root of the block's transaction tree. */
  merkleRoot: string;
  /** Number of sibling hashes in the Merkle proof. */
  merkleSiblings: number;
  /** Digest of the lower continuity endpoint (an attestation point on Creditcoin). */
  continuityLowerEndpoint: string;
  /** Number of continuity roots linking the endpoints. */
  continuityRoots: number;
  /** True when the proof builder served a cached (pre-generated) proof. */
  cached: boolean;
  generatedAt: string | null;
}

export interface ProofOutcome {
  ok: boolean;
  /** "proof" — a proof exists; "pending" — tx not attested yet; "unknown_tx" — not found on source chain. */
  state: "proof" | "pending" | "unknown_tx" | "error";
  proof?: TxProof;
  /**
   * Full proof objects (Merkle + continuity) exactly as the SDK serves them —
   * required by the Block Prover Precompile for on-chain verification and
   * submission. Server-side only: API routes MUST strip this before responding.
   */
  raw?: {
    chainKey: number;
    headerNumber: number;
    txBytes: string;
    merkleProof: proofProvider.merkle.TransactionMerkleProof;
    continuityProof: proofProvider.ContinuityProof;
  };
  /** Human-oriented detail (English; the UI localizes status labels itself). */
  detail?: string;
}

interface RawProofData {
  chainKey?: number;
  headerNumber?: number | string;
  txIndex?: number | string;
  txHash?: string;
  txBytes?: string;
  continuityProof?: { lowerEndpointDigest?: string; roots?: unknown[] };
  merkleProof?: { root?: string; siblings?: unknown[] };
  cached?: boolean;
  generatedAt?: string | Date;
}

function toNumber(v: number | string | undefined): number | null {
  if (v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Fetch a proof for a source-chain transaction hash. Never throws. */
export async function getTxProof(chainKey: number, txHash: string): Promise<ProofOutcome> {
  const { proofBuilderUrl } = attestcoinEndpoints();
  const builder = new proofProvider.service.ProofBuilder(chainKey, proofBuilderUrl);
  try {
    const result = await builder.getProof(txHash);
    if (!result.success || !result.data) {
      return { ok: false, state: "pending", detail: result.error ?? "proof not available yet" };
    }
    const d = result.data as unknown as RawProofData;
    const generatedAt =
      d.generatedAt instanceof Date
        ? d.generatedAt.toISOString()
        : typeof d.generatedAt === "string"
          ? d.generatedAt
          : null;
    return {
      ok: true,
      state: "proof",
      proof: {
        chainKey,
        headerNumber: toNumber(d.headerNumber) ?? 0,
        txIndex: toNumber(d.txIndex) ?? 0,
        txHash: d.txHash ?? txHash,
        txBytes: d.txBytes ?? "",
        merkleRoot: d.merkleProof?.root ?? "",
        merkleSiblings: d.merkleProof?.siblings?.length ?? 0,
        continuityLowerEndpoint: d.continuityProof?.lowerEndpointDigest ?? "",
        continuityRoots: d.continuityProof?.roots?.length ?? 0,
        cached: d.cached ?? false,
        generatedAt,
      },
      raw: {
        chainKey,
        headerNumber: toNumber(d.headerNumber) ?? 0,
        txBytes: d.txBytes ?? "",
        merkleProof: d.merkleProof as unknown as proofProvider.merkle.TransactionMerkleProof,
        continuityProof: d.continuityProof as unknown as proofProvider.ContinuityProof,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The builder 404s before the tx is attested — surface that as pending,
    // not as a hard error, so the UI can suggest "try again later".
    const notFound = /404|not found|unknown|no proof/i.test(message);
    return {
      ok: false,
      state: notFound ? "pending" : "error",
      detail: message,
    };
  }
}

// ── Cost / freshness context (C2 / G7) ──────────────────────────────────────
// Protocol docs give the verification gas shape:
//   CTC ≈ 2.3e-5 + 2.9e-7 × continuity hashes
// and a 10–100x cost penalty when proofs are STALE (the continuity chain has
// grown since the tx was attested). These helpers turn the numbers the app
// already fetches (roots count, attested height) into user-facing context.

/** Estimated verification cost in CTC for a continuity proof of N roots. */
export function estimateVerificationCtc(continuityRoots: number): number {
  return 2.3e-5 + 2.9e-7 * Math.max(continuityRoots, 0);
}

/** When the tx sits this many blocks behind the attested head, call it stale. */
export const STALE_GAP_BLOCKS = 5000;

export interface ProofCostContext {
  continuityRoots: number;
  /** CTC estimate, e.g. 0.000031. */
  estimatedCtc: number;
  /** Label with 6 decimals — ready for display. */
  ctcLabel: string;
  /** True when the proof's block is far behind the attested head (pricier). */
  stale: boolean;
  /** Blocks between the proof's block and the attested head (null unknown). */
  staleGapBlocks: number | null;
}

/**
 * Cost/freshness summary for a proof (G7). `attestedHeight` is the chain's
 * current attested head (from the status module); null → unknown, not stale.
 */
export function proofCostContext(
  proof: Pick<TxProof, "headerNumber" | "continuityRoots">,
  attestedHeight: number | null,
): ProofCostContext {
  const estimatedCtc = estimateVerificationCtc(proof.continuityRoots);
  const gap =
    attestedHeight != null && attestedHeight >= proof.headerNumber
      ? attestedHeight - proof.headerNumber
      : null;
  return {
    continuityRoots: proof.continuityRoots,
    estimatedCtc,
    ctcLabel: `≈${estimatedCtc.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")} CTC`,
    stale: gap != null && gap >= STALE_GAP_BLOCKS,
    staleGapBlocks: gap,
  };
}
