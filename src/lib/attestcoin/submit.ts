import {
  Wallet,
  computeAddress,
  JsonRpcProvider,
  type TransactionReceipt,
} from "ethers";
import { blockProver, proofProvider, utils } from "@gluwa/usc-sdk";
import { attestcoinEndpoints, attestcoinEnv } from "./config";
import { chunkByProtocolLimits, tryMergeProofs } from "./batch";

// ─────────────────────────────────────────────────────────────────────────────
// WRITE half of the Attestcoin integration: submitting proofs to the
// Block Prover Precompile (0x0FD2) as signed Creditcoin transactions.
//
// `verifyAndEmitSingle/Batch` sign with a Creditcoin account
// (CREDITCOIN_SIGNER_KEY — a funded testnet/mainnet private key) and emit
// `TransactionVerified(chainKey, height, transactionIndex)` events on success.
//
// C2 fixes in this module:
//   G2 — batch groups are chunked to ≤10 proofs and <1000-block span before
//        each verifyAndEmitBatch call (the protocol's hard limits; the old
//        12-item batches could revert the whole Creditcoin tx).
//   G3 — the shared continuity proof comes from the builder's getBatchProof
//        when available, else mergeProofs (contiguity-validated); when proofs
//        can't be merged the group degrades to per-tx submissions instead of
//        building a proof that reverts after gas.
//   G8 — gas handling uses the SDK's utils.gas.computeGasLimit (the same
//        estimate→buffer→size-fallback formula, now kept in sync upstream).
// ─────────────────────────────────────────────────────────────────────────────

type RawProof = NonNullable<import("./proof").ProofOutcome["raw"]>;

export interface SubmitConfigured {
  configured: true;
  signerAddress: string;
}
export interface SubmitNotConfigured {
  configured: false;
  /** Env var that must be set to enable submissions. */
  requiredEnv: "CREDITCOIN_SIGNER_KEY";
}
export type SubmitAvailability = SubmitConfigured | SubmitNotConfigured;

/** Whether proof submission is possible in this deployment (key present). */
export function submissionAvailability(): SubmitAvailability {
  const keyHex = process.env.CREDITCOIN_SIGNER_KEY?.replace(/^0x/, "");
  if (keyHex && /^[0-9a-fA-F]{64}$/.test(keyHex)) {
    // Deriving the address is pure math — no network call.
    const address = deriveAddress(keyHex);
    return { configured: true, signerAddress: address };
  }
  return { configured: false, requiredEnv: "CREDITCOIN_SIGNER_KEY" };
}

function deriveAddress(keyHex: string): string {
  // Keccak-256 of the uncompressed public key, last 20 bytes — pure math, no network call.
  return computeAddress(`0x${keyHex}`);
}

// ── Gas handling (G8) ────────────────────────────────────────────────────────
// The SDK's computeGasLimit does exactly what our hand-rolled fallback did —
// estimate → ×1.35 buffer → size-based fallback (21_000 + 5_000×continuity +
// 20_000) — "ported from gluwa/usc-testnet-bridge-examples#77". Consolidating
// keeps the formula in sync with upstream.

const VERIFY_AND_EMIT_SINGLE =
  "verifyAndEmit(uint64,uint64,bytes,(bytes32,(bytes32,bool)[]),(bytes32,bytes32[]))";
const VERIFY_AND_EMIT_BATCH =
  "verifyAndEmit(uint64,uint64[],bytes[],(bytes32,(bytes32,bool)[])[],(bytes32,bytes32[]))";

function continuityLength(proof: unknown): number {
  const roots = (proof as { roots?: unknown[] } | null | undefined)?.roots;
  return Array.isArray(roots) ? roots.length : 0;
}

interface SendCtx {
  provider: JsonRpcProvider;
  prover: blockProver.PrecompileBlockProver;
  wallet: Wallet;
}

/**
 * SDK-driven gas limit for a verifyAndEmit call (G8). Encodes the calldata
 * with the prover contract's own interface, then runs
 * utils.gas.computeGasLimit (estimate → buffer → size fallback).
 */
async function sdkGasLimit(
  ctx: SendCtx,
  fnSignature: string,
  args: unknown[],
  roots: number,
): Promise<bigint> {
  const data = ctx.prover.blockProverContract.interface.encodeFunctionData(fnSignature, args);
  return utils.gas.computeGasLimit(
    ctx.provider,
    ctx.prover.blockProverContract,
    data,
    ctx.wallet.address,
    Math.max(roots, 1),
  );
}

function makeSendCtx(): SendCtx {
  const keyHex = process.env.CREDITCOIN_SIGNER_KEY?.replace(/^0x/, "");
  if (!keyHex || keyHex.length !== 64) {
    throw new Error("CREDITCOIN_SIGNER_KEY is not configured");
  }
  const { rpcUrl, blockProverPrecompile } = attestcoinEndpoints();
  const provider = new JsonRpcProvider(rpcUrl, undefined, {
    staticNetwork: true,
    batchStallTime: 200,
  });
  const wallet = new Wallet(`0x${keyHex}`, provider);
  const prover = new blockProver.PrecompileBlockProver(provider, blockProverPrecompile);
  return { provider, prover, wallet };
}

/** Gas used → share of the Creditcoin block gas cap (75M) — G7 surfacing. */
function gasPctOfBlock(gasUsed: number | null): number | null {
  if (gasUsed == null || gasUsed <= 0) return null;
  return utils.gas.gasAsPercentageOfMax(BigInt(gasUsed));
}

export interface SubmitResult {
  ok: boolean;
  /** Creditcoin tx hash of the submission. */
  cc3TxHash: string | null;
  /** Parsed TransactionVerified(chainKey, height, transactionIndex) event, when present. */
  event: { chainKey: number; height: number; transactionIndex: number } | null;
  /** Gas used by the Creditcoin tx. */
  gasUsed: number | null;
  /** Gas used as % of the Creditcoin block gas cap (G7). */
  gasPctOfBlock: number | null;
  detail?: string;
}

/**
 * Submit a proof on-chain via verifyAndEmitSingle. Requires CREDITCOIN_SIGNER_KEY.
 * Throws when the signer is not configured — callers must check availability first.
 */
export async function submitProofOnChain(raw: RawProof): Promise<SubmitResult> {
  const ctx = makeSendCtx();
  const roots = continuityLength(raw.continuityProof);
  try {
    const args = [
      raw.chainKey,
      raw.headerNumber,
      raw.txBytes,
      raw.merkleProof as proofProvider.merkle.TransactionMerkleProof,
      raw.continuityProof as proofProvider.ContinuityProof,
    ];
    const gasLimit = await sdkGasLimit(ctx, VERIFY_AND_EMIT_SINGLE, args, roots);
    const tx = await ctx.prover.verifyAndEmitSingle(
      ctx.wallet,
      raw.chainKey,
      raw.headerNumber,
      raw.txBytes,
      raw.merkleProof as proofProvider.merkle.TransactionMerkleProof,
      raw.continuityProof as proofProvider.ContinuityProof,
      { gasLimit },
    );
    const receipt = await tx.wait();
    const cc3TxHash = typeof receipt?.hash === "string" ? receipt.hash : null;
    const gasUsed = receipt?.gasUsed != null ? Number(receipt.gasUsed) : null;

    // Parse the TransactionVerified event from the receipt logs.
    let event: SubmitResult["event"] = null;
    try {
      for (const log of receipt?.logs ?? []) {
        const parsed = ctx.prover.blockProverContract.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed && parsed.name === "TransactionVerified") {
          event = {
            chainKey: Number(parsed.args.chainKey),
            height: Number(parsed.args.height),
            transactionIndex: Number(parsed.args.transactionIndex),
          };
          break;
        }
      }
    } catch {
      // event parsing is best-effort — the receipt itself is the receipt
    }

    return { ok: true, cc3TxHash, event, gasUsed, gasPctOfBlock: gasPctOfBlock(gasUsed) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, cc3TxHash: null, event: null, gasUsed: null, gasPctOfBlock: null, detail: message };
  }
}

/** Which network submissions would land on (for UI copy). */
export function submissionEnv(): "testnet" | "mainnet" {
  return attestcoinEnv();
}

// ── Batch submission (verifyAndEmitBatch) ────────────────────────────────────

export interface BatchSubmitItem {
  /** Caller's row id (the API route maps results back to payments by this). */
  paymentId: string;
  raw: RawProof;
}

export interface VerifiedEvent {
  chainKey: number;
  height: number;
  transactionIndex: number;
}

export interface BatchSubmitOutcome {
  ok: boolean;
  /** Per-payment Creditcoin tx hash — payments in the same batch tx share one. */
  perPayment: { paymentId: string; cc3TxHash: string }[];
  events: VerifiedEvent[];
  gasUsed: number | null;
  gasPctOfBlock: number | null;
  /** How the shared continuity proof was obtained, per batch tx (G3 audit trail). */
  proofSource: ("builder-batch" | "merged" | "per-tx")[];
  detail?: string;
}

/** Parse every TransactionVerified event from a receipt (best-effort). */
function parseVerifiedEvents(
  prover: blockProver.PrecompileBlockProver,
  logs: readonly { topics: readonly string[]; data: string }[],
): VerifiedEvent[] {
  const events: VerifiedEvent[] = [];
  try {
    for (const log of logs) {
      const parsed = prover.blockProverContract.interface.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      if (parsed && parsed.name === "TransactionVerified") {
        events.push({
          chainKey: Number(parsed.args.chainKey),
          height: Number(parsed.args.height),
          transactionIndex: Number(parsed.args.transactionIndex),
        });
      }
    }
  } catch {
    // event parsing is best-effort — the receipt itself is the receipt
  }
  return events;
}

export interface BatchSubmitGroup {
  chainKey: number;
  items: BatchSubmitItem[];
  /**
   * Builder-constructed shared continuity proof (from getBatchProof — G3).
   * When absent, per-tx proofs are merged (contiguity-validated), and when
   * merging is impossible the group degrades to per-tx submissions.
   */
  sharedContinuity?: proofProvider.ContinuityProof | null;
}

/**
 * Submit proofs on-chain via verifyAndEmitBatch (G2 + G3).
 *
 * Groups (one per chainKey) are FIRST chunked by the protocol limits
 * (≤10 proofs, <1000-block span — G2). For each chunk:
 *   1. shared continuity = group.sharedContinuity (builder-constructed) if
 *      present;
 *   2. else tryMergeProofs of the chunk's per-tx proofs (throws on gaps);
 *   3. else per-tx verifyAndEmitSingle fallback — correctness over batching.
 *
 * Requires CREDITCOIN_SIGNER_KEY — throws when absent (callers check first).
 */
export async function submitProofGroupsOnChain(
  groups: BatchSubmitGroup[],
): Promise<BatchSubmitOutcome> {
  const ctx = makeSendCtx();
  if (groups.length === 0 || groups.every((g) => g.items.length === 0)) {
    return {
      ok: false,
      perPayment: [],
      events: [],
      gasUsed: null,
      gasPctOfBlock: null,
      proofSource: [],
      detail: "empty batch",
    };
  }

  const perPayment: { paymentId: string; cc3TxHash: string }[] = [];
  const events: VerifiedEvent[] = [];
  const proofSource: ("builder-batch" | "merged" | "per-tx")[] = [];
  let gasUsedTotal = 0;
  let failure: string | undefined;

  for (const group of groups) {
    // G2 — chunk by protocol limits (≤10 proofs, <1000-block span).
    const chunks = chunkByProtocolLimits(group.items, (i) => i.raw.headerNumber);

    for (const chunk of chunks) {
      // G3 — shared continuity proof: builder's, else merged per-tx proofs.
      let shared: proofProvider.ContinuityProof | null = group.sharedContinuity ?? null;
      let source: "builder-batch" | "merged" | "per-tx" = "builder-batch";
      if (!shared) {
        const merge = tryMergeProofs(
          chunk.map((i) => ({ headerNumber: i.raw.headerNumber, continuityProof: i.raw.continuityProof as proofProvider.ContinuityProof })),
        );
        if (merge.ok && merge.merged) {
          shared = merge.merged;
          source = "merged";
        } else {
          source = "per-tx";
        }
      }

      if (!shared) {
        // Per-tx fallback — proofs can't share a continuity chain, so submit
        // each singly (its own continuity proof). Correctness over batching.
        for (const item of chunk) {
          try {
            const single = await submitWithCtx(ctx, item);
            proofSource.push(source);
            if (single.receipt) {
              gasUsedTotal += Number(single.receipt.gasUsed ?? 0);
              events.push(...parseVerifiedEvents(ctx.prover, single.receipt.logs ?? []));
              if (typeof single.receipt.hash === "string") {
                perPayment.push({ paymentId: item.paymentId, cc3TxHash: single.receipt.hash });
              }
            }
          } catch (err) {
            failure = err instanceof Error ? err.message : String(err);
          }
        }
        continue;
      }

      const roots = continuityLength(shared);
      try {
        const args = [
          group.chainKey,
          chunk.map((i) => i.raw.headerNumber),
          chunk.map((i) => i.raw.txBytes),
          chunk.map((i) => i.raw.merkleProof as proofProvider.merkle.TransactionMerkleProof),
          shared,
        ];
        const gasLimit = await sdkGasLimit(ctx, VERIFY_AND_EMIT_BATCH, args, roots);
        const tx = await ctx.prover.verifyAndEmitBatch(
          ctx.wallet,
          group.chainKey,
          args[1] as number[],
          args[2] as string[],
          args[3] as proofProvider.merkle.TransactionMerkleProof[],
          shared,
          { gasLimit },
        );
        const receipt = await tx.wait();
        proofSource.push(source);
        if (receipt?.gasUsed != null) gasUsedTotal += Number(receipt.gasUsed);
        events.push(...parseVerifiedEvents(ctx.prover, receipt?.logs ?? []));
        const cc3TxHash = typeof receipt?.hash === "string" ? receipt.hash : null;
        if (cc3TxHash) {
          for (const item of chunk) perPayment.push({ paymentId: item.paymentId, cc3TxHash });
        }
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
        // The batch tx reverted (e.g. the shared proof's range exceeded what
        // verifyAndEmitBatch accepts for this chunk). Degrade to per-tx
        // submissions — the same correctness-over-batching fallback the
        // merge path uses — instead of dropping the whole chunk's payments.
        // Safe: the batch call REVERTED, so nothing from this chunk landed
        // on-chain (a reverted tx has no effects); per-tx is a fresh start.
        for (const item of chunk) {
          try {
            const single = await submitWithCtx(ctx, item);
            proofSource.push("per-tx");
            if (single.receipt) {
              gasUsedTotal += Number(single.receipt.gasUsed ?? 0);
              events.push(...parseVerifiedEvents(ctx.prover, single.receipt.logs ?? []));
              if (typeof single.receipt.hash === "string") {
                perPayment.push({ paymentId: item.paymentId, cc3TxHash: single.receipt.hash });
              }
            }
          } catch (inner) {
            failure = inner instanceof Error ? inner.message : String(inner);
          }
        }
      }
    }
  }

  return {
    ok: perPayment.length > 0,
    perPayment,
    events,
    gasUsed: gasUsedTotal > 0 ? gasUsedTotal : null,
    gasPctOfBlock: gasPctOfBlock(gasUsedTotal > 0 ? gasUsedTotal : null),
    proofSource,
    ...(failure && perPayment.length === 0 ? { detail: failure } : {}),
  };
}

/** Single submission using a pre-built context (internal, per-tx fallback). */
async function submitWithCtx(
  ctx: SendCtx,
  item: BatchSubmitItem,
): Promise<{ receipt: TransactionReceipt | null }> {
  const roots = continuityLength(item.raw.continuityProof);
  const args = [
    item.raw.chainKey,
    item.raw.headerNumber,
    item.raw.txBytes,
    item.raw.merkleProof as proofProvider.merkle.TransactionMerkleProof,
    item.raw.continuityProof as proofProvider.ContinuityProof,
  ];
  const gasLimit = await sdkGasLimit(ctx, VERIFY_AND_EMIT_SINGLE, args, roots);
  const tx = await ctx.prover.verifyAndEmitSingle(
    ctx.wallet,
    item.raw.chainKey,
    item.raw.headerNumber,
    item.raw.txBytes,
    item.raw.merkleProof as proofProvider.merkle.TransactionMerkleProof,
    item.raw.continuityProof as proofProvider.ContinuityProof,
    { gasLimit },
  );
  const receipt = await tx.wait();
  return { receipt: (receipt ?? null) as TransactionReceipt | null };
}
