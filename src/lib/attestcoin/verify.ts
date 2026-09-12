import { blockProver, proofProvider } from "@gluwa/usc-sdk";
import { attestcoinEndpoints, attestcoinEnv, ATTESTCOIN_TIMEOUT_MS } from "./config";
import { chunkByProtocolLimits } from "./batch";

// ─────────────────────────────────────────────────────────────────────────────
// On-chain proof verification via the Block Prover Precompile (0x0FD2) on
// Creditcoin.
//
// `verifySingle` is a read-only eth_call: it submits the Merkle + continuity
// proof to the precompile and the CHAIN itself checks it. No signer and no
// funds are required — this strengthens the read layer from "the hosted proof
// builder says a proof exists" to "the Creditcoin chain confirms the proof".
//
// Results are cached per (chainKey, headerNumber, txHash) for VERIFY_TTL_MS
// because the precompile's answer is deterministic for an attested block.
// ─────────────────────────────────────────────────────────────────────────────

export interface OnchainVerifyResult {
  /** True when the precompile accepted the proof (tx ∈ attested block). */
  verified: boolean;
  /** Transaction index inside the block, computed from the Merkle proof. */
  txIndex: number | null;
  /** Precompile address used (0x…0FD2). */
  precompile: string;
  /** Epoch ms of the verification. */
  verifiedAt: number;
}

type RawProof = NonNullable<import("./proof").ProofOutcome["raw"]>;

const VERIFY_TTL_MS = 5 * 60_000;

const globalForVerifier = globalThis as unknown as {
  __acpBlockProver?: {
    env: string;
    prover: blockProver.PrecompileBlockProver;
  };
  __acpVerifyCache?: Map<string, OnchainVerifyResult>;
};

function cacheKey(raw: RawProof): string {
  // L3 fix: the key must identify the TRANSACTION, not just the block. The old
  // key (chainKey:headerNumber:merkleRoot) collided for two payments whose
  // txs landed in the SAME block — the second payment reused the first's
  // cached verdict AND its per-tx txIndex. txBytes (unique per tx) disambiguates.
  return `${raw.chainKey}:${raw.headerNumber}:${raw.merkleProof.root}:${raw.txBytes.slice(0, 74)}`;
}

/**
 * Verify a proof against the Block Prover Precompile on Creditcoin.
 * Never throws — failures return verified=false so the UI can render a
 * graceful "not yet verifiable" state instead of an error.
 */
export async function verifyProofOnChain(raw: RawProof): Promise<OnchainVerifyResult | null> {
  const key = cacheKey(raw);
  const cache = (globalForVerifier.__acpVerifyCache ??= new Map());
  const hit = cache.get(key);
  if (hit && Date.now() - hit.verifiedAt < VERIFY_TTL_MS) return hit;

  const env = attestcoinEnv();
  const { rpcUrl, blockProverPrecompile } = attestcoinEndpoints();
  const cachedProver = globalForVerifier.__acpBlockProver;
  let prover: blockProver.PrecompileBlockProver;
  if (cachedProver && cachedProver.env === env) {
    prover = cachedProver.prover;
  } else {
    const { JsonRpcProvider } = await import("ethers");
    const provider = new JsonRpcProvider(rpcUrl, undefined, {
      staticNetwork: true,
      batchStallTime: 200,
    });
    prover = new blockProver.PrecompileBlockProver(provider, blockProverPrecompile);
    globalForVerifier.__acpBlockProver = { env, prover };
  }

  const deadline = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), ATTESTCOIN_TIMEOUT_MS).unref?.(),
  );

  try {
    const race = await Promise.race([
      (async () => {
        const verified = await prover.verifySingle(
          raw.chainKey,
          raw.headerNumber,
          raw.txBytes,
          raw.merkleProof as proofProvider.merkle.TransactionMerkleProof,
          raw.continuityProof as proofProvider.ContinuityProof,
        );
        let txIndex: number | null = null;
        try {
          const idx = await prover.computeTransactionIndex(
            raw.merkleProof as proofProvider.merkle.TransactionMerkleProof,
          );
          txIndex = Number(idx);
        } catch {
          txIndex = null;
        }
        const result: OnchainVerifyResult = {
          verified: verified === true,
          txIndex,
          precompile: blockProverPrecompile,
          verifiedAt: Date.now(),
        };
        cache.set(key, result);
        return result;
      })(),
      deadline,
    ]);
    return race;
  } catch {
    return null;
  }
}

// ── Batch verification (C2 / G9) ──────────────────────────────────────────────
// One read-only verifyBatch eth_call checks a whole chainKey group (≤10
// proofs, <1000-block span — the same limits as submission) using the shared
// continuity proof. Used by the poller when several payments flip in the same
// tick and by any multi-proof surface.

export interface BatchVerifyItem {
  headerNumber: number;
  txBytes: string;
  merkleProof: proofProvider.merkle.TransactionMerkleProof;
}

export interface BatchVerifyResult {
  verified: boolean;
  /** Number of proofs covered by the batch calls. */
  count: number;
  /** How many eth_calls were needed (protocol limits chunking). */
  calls: number;
  precompile: string;
  verifiedAt: number;
}

/**
 * Verify several proofs of ONE chainKey against the Block Prover Precompile
 * in as few read-only eth_calls as the protocol allows (G9). Never throws —
 * null means the calls could not be completed (timeout / RPC failure).
 */
export async function verifyProofsBatchOnChain(
  chainKey: number,
  items: BatchVerifyItem[],
  sharedContinuity: proofProvider.ContinuityProof,
): Promise<BatchVerifyResult | null> {
  if (items.length === 0) return null;

  const env = attestcoinEnv();
  const { rpcUrl, blockProverPrecompile } = attestcoinEndpoints();
  const cachedProver = globalForVerifier.__acpBlockProver;
  let prover: blockProver.PrecompileBlockProver;
  if (cachedProver && cachedProver.env === env) {
    prover = cachedProver.prover;
  } else {
    const { JsonRpcProvider } = await import("ethers");
    const provider = new JsonRpcProvider(rpcUrl, undefined, {
      staticNetwork: true,
      batchStallTime: 200,
    });
    prover = new blockProver.PrecompileBlockProver(provider, blockProverPrecompile);
    globalForVerifier.__acpBlockProver = { env, prover };
  }

  const chunks = chunkByProtocolLimits(items);
  let verifiedAll = true;
  try {
    for (const chunk of chunks) {
      const deadline = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), ATTESTCOIN_TIMEOUT_MS).unref?.(),
      );
      const outcome = await Promise.race([
        (async () => {
          const ok = await prover.verifyBatch(
            chainKey,
            chunk.map((i) => i.headerNumber),
            chunk.map((i) => i.txBytes),
            chunk.map((i) => i.merkleProof),
            sharedContinuity,
          );
          return ok === true;
        })(),
        deadline,
      ]);
      if (outcome === null) return null; // timeout / failure — indeterminate
      if (!outcome) verifiedAll = false;
    }
    return {
      verified: verifiedAll,
      count: items.length,
      calls: chunks.length,
      precompile: blockProverPrecompile,
      verifiedAt: Date.now(),
    };
  } catch {
    return null;
  }
}
