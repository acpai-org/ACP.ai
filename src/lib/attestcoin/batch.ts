import { proofProvider } from "@gluwa/usc-sdk";
import { attestcoinEndpoints } from "./config";

// ─────────────────────────────────────────────────────────────────────────────
// Batch-proof helpers (C2 / G2 + G3).
//
// G2 — the protocol caps batch verification at MAX_BATCH_SIZE=10 proofs per
// batch tx and MAX_BATCH_RANGE=1000 blocks of height span. The app's old
// BATCH_PROOF_LIMIT of 12 could build a 12-entry batch call that reverts the
// whole Creditcoin tx.
//
// G3 — batch proof construction must use the builder's `getBatchProof`
// (ONE REST call returning a builder-constructed shared continuity proof),
// not the "longest proof wins" heuristic. When a shared proof isn't available
// (per-tx fetches), `mergeProofs` merges single proofs — it throws on
// non-contiguous coverage, which we treat as a signal to degrade to per-tx
// submissions instead of building a proof that reverts after gas.
// ─────────────────────────────────────────────────────────────────────────────

/** Protocol MAX_BATCH_SIZE — proofs per verify(AndEmit)Batch call. */
export const MAX_BATCH_SIZE = 10;
/** Protocol MAX_BATCH_RANGE — max height span covered by one batch. */
export const MAX_BATCH_RANGE = 1000;

export interface HasHeight {
  headerNumber: number;
}

/**
 * Chunk proofs by the protocol's batch limits. Pure.
 * Sorts by height ascending and greedily cuts chunks that keep BOTH the
 * size cap (≤10) and the range cap (height span < 1000 blocks — the shared
 * continuity proof must cover every block in the batch). `heightOf` defaults
 * to reading `item.headerNumber` but any item shape works.
 */
export function chunkByProtocolLimits<T>(
  items: T[],
  heightOf: (item: T) => number = (i) => (i as HasHeight).headerNumber,
): T[][] {
  const sorted = [...items].sort((a, b) => heightOf(a) - heightOf(b));
  const chunks: T[][] = [];
  let current: T[] = [];
  let spanStart = 0;
  for (const item of sorted) {
    const height = heightOf(item);
    if (current.length === 0) {
      current = [item];
      spanStart = height;
      continue;
    }
    const spansTooFar = height - spanStart >= MAX_BATCH_RANGE;
    if (current.length >= MAX_BATCH_SIZE || spansTooFar) {
      chunks.push(current);
      current = [item];
      spanStart = height;
    } else {
      current.push(item);
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** How many verify(AndEmit)Batch calls this item set will need. */
export function batchCallCount<T>(
  items: T[],
  heightOf: (item: T) => number = (i) => (i as HasHeight).headerNumber,
): number {
  return chunkByProtocolLimits(items, heightOf).length;
}

// ── Builder batch fetch (one REST call per ≤10 hashes) ───────────────────────

export interface BatchProofEntry {
  txHash: string;
  headerNumber: number;
  txIndex: number;
  txBytes: string;
  merkleProof: proofProvider.merkle.TransactionMerkleProof;
  /**
   * The shared continuity proof — covers every block in the batch, so it is
   * valid for BOTH batch verification and each entry's single verification.
   */
  continuityProof: proofProvider.ContinuityProof;
}

export interface BatchFetchOutcome {
  state: "proof" | "pending" | "error";
  chainKey: number;
  /** Builder-constructed shared continuity proof (state==="proof" only). */
  sharedContinuity: proofProvider.ContinuityProof | null;
  fromHeader: number | null;
  toHeader: number | null;
  entries: BatchProofEntry[];
  cached: boolean;
  detail?: string;
}

/**
 * Fetch proofs for many tx hashes in ONE builder call (G3). The response's
 * `merkleProofs` is a nested Map<blockHeight, Map<txIndex, entry>> — flattened
 * here into a flat list. Caller should cap the input to ≤10 hashes per call
 * (the protocol batch limits apply to verification, and the builder's shared
 * proof only covers what it was asked for).
 */
export async function fetchBatchProofs(
  chainKey: number,
  txHashes: string[],
): Promise<BatchFetchOutcome> {
  const { proofBuilderUrl } = attestcoinEndpoints();
  const builder = new proofProvider.service.ProofBuilder(chainKey, proofBuilderUrl);
  const empty: BatchFetchOutcome = {
    state: "error",
    chainKey,
    sharedContinuity: null,
    fromHeader: null,
    toHeader: null,
    entries: [],
    cached: false,
  };
  try {
    const result = await builder.getBatchProof(txHashes);
    if (!result.success || !result.data) {
      return {
        ...empty,
        state: "pending",
        detail: result.error ?? "proof not available yet",
      };
    }
    const data = result.data;
    const shared = data.continuityProof;
    const entries: BatchProofEntry[] = [];
    // Map<number, Map<number, BatchMerkleProofEntry>> — iterate both levels.
    const blocks = data.merkleProofs as unknown as
      | Map<number, Map<number, { txHash: string; txBytes: string; merkleProof: proofProvider.merkle.TransactionMerkleProof }>>
      | undefined;
    if (blocks && typeof (blocks as Map<number, unknown>).forEach === "function") {
      for (const [height, byIndex] of blocks) {
        for (const [index, entry] of byIndex) {
          if (!entry || typeof entry.txHash !== "string") continue;
          entries.push({
            txHash: entry.txHash,
            headerNumber: Number(height),
            txIndex: Number(index),
            txBytes: entry.txBytes ?? "",
            merkleProof: entry.merkleProof,
            continuityProof: shared,
          });
        }
      }
    }
    if (entries.length === 0) {
      return { ...empty, state: "pending", detail: "builder returned no merkle entries" };
    }
    return {
      state: "proof",
      chainKey,
      sharedContinuity: shared,
      fromHeader: data.fromHeader ?? null,
      toHeader: data.toHeader ?? null,
      entries,
      cached: data.cached ?? false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const notFound = /404|not found|unknown|no proof/i.test(message);
    return { ...empty, state: notFound ? "pending" : "error", detail: message };
  }
}

// ── merge fallback (per-tx proofs → one shared proof) ─────────────────────────

export interface MergeOutcome {
  ok: boolean;
  merged?: proofProvider.ContinuityProof;
  /** Present when mergeProofs refused (non-contiguous coverage). */
  reason?: string;
}

/**
 * Try to merge per-tx continuity proofs into one shared proof (G3 fallback).
 * `mergeProofs` requires ordered & contiguous coverage — each proof covers
 * [headerNumber, headerNumber + roots.length − 1]; the next proof must start
 * at or before the previous end + 1. On any gap we report ok=false and the
 * caller degrades to per-tx submissions (correctness over batching).
 */
export function tryMergeProofs(
  items: { headerNumber: number; continuityProof: proofProvider.ContinuityProof }[],
): MergeOutcome {
  if (items.length === 0) return { ok: false, reason: "empty" };
  const sorted = [...items].sort((a, b) => a.headerNumber - b.headerNumber);
  try {
    const merged = proofProvider.mergeProofs(
      sorted.map((i) => [i.headerNumber, i.continuityProof] as [number, proofProvider.ContinuityProof]),
    );
    return { ok: true, merged };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
