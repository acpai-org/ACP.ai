import { and, asc, count, eq, gte, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { db, ensureDb } from "@/db";
import { payments } from "@/db/schema";
import { createPaymentNotification } from "@/lib/notifications";
import { getTxProof } from "./proof";
import { ensureSourceChainMapFresh, sourceChainByEvmId, SOURCE_CHAINS_FALLBACK_IDS } from "./chains";
import { fetchBatchProofs, type BatchProofEntry } from "./batch";
import { verifyProofOnChain, verifyProofsBatchOnChain } from "./verify";

// ─────────────────────────────────────────────────────────────────────────────
// Server-side Attestcoin attestation poller.
//
// Settled payments record their transfer tx on a source chain, but Creditcoin
// attests the block some time later. This poller watches settled payments that
// don't have an attestation yet; the first time the hosted Proof Builder
// serves a Merkle + continuity proof for the tx it:
//   1. persists `attested_at` + `attest_root` on the payment row,
//   2. asks the Block Prover Precompile (0x0FD2) to verify the proof on-chain
//      (read-only eth_call — no signer) and persists `onchain_verified_at`,
//   3. fires the "attested" payment notification (rendered in the active
//      locale via the translation-key scheme in lib/notifications.ts).
//
// The flip is a conditional UPDATE (... WHERE attested_at IS NULL) so the
// notification only fires when this poller actually changed the row — the
// read-only verify route never writes, and sqlite's single-writer model keeps
// concurrent ticks safe.
//
// Proof SUBMISSION (verifyAndEmitSingle, a signed Creditcoin tx) is a
// user-initiated action — see lib/attestcoin/submit.ts and
// POST /api/payments/[id]/attest.
// ─────────────────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 60_000;
/** How many candidate payments one tick may check (newest first). */
const BATCH_LIMIT = 20;
/** Payments older than this stop being polled (source chains prune history). */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

interface PollerState {
  timer: ReturnType<typeof setInterval> | null;
  busy: boolean;
  /** Liveness stats surfaced in the wallet AttestcoinPanel. */
  startedAt: number | null;
  lastTickAt: number | null;
  lastTickChecked: number | null;
  lastFlipAt: number | null;
  flippedTotal: number;
  lastError: string | null;
}

const globalForPoller = globalThis as unknown as {
  __acpAttestationPoller?: PollerState;
};

function pollerState(): PollerState {
  globalForPoller.__acpAttestationPoller ??= {
    timer: null,
    busy: false,
    startedAt: null,
    lastTickAt: null,
    lastTickChecked: null,
    lastFlipAt: null,
    flippedTotal: 0,
    lastError: null,
  };
  return globalForPoller.__acpAttestationPoller;
}

export interface PollerStats {
  running: boolean;
  startedAt: number | null;
  lastTickAt: number | null;
  /** Payments examined by the most recent completed tick. */
  lastTickChecked: number | null;
  lastFlipAt: number | null;
  flippedTotal: number;
  lastError: string | null;
  /** Payments currently eligible for polling (settled + tx + unattested). */
  watching: number | null;
}

/** Liveness snapshot for the wallet panel — one cheap local DB count. */
export function getPollerStats(): PollerStats {
  const state = pollerState();
  let watching: number | null = null;
  try {
    ensureDb();
    const row = db
      .select({ value: count() })
      .from(payments)
      .where(
        and(
          eq(payments.status, "settled"),
          isNotNull(payments.txHash),
          ne(payments.txHash, ""),
          ne(payments.txHash, "0x0"),
          isNull(payments.attestedAt),
          // P3: count only attestable rows — same filter the candidates query
          // uses, so the panel's number matches what the poller can act on.
          inArray(payments.chainId, SOURCE_CHAINS_FALLBACK_IDS()),
        ),
      )
      .get();
    watching = row?.value ?? 0;
  } catch {
    watching = null;
  }
  return {
    running: state.timer !== null,
    startedAt: state.startedAt,
    lastTickAt: state.lastTickAt,
    lastTickChecked: state.lastTickChecked,
    lastFlipAt: state.lastFlipAt,
    flippedTotal: state.flippedTotal,
    lastError: state.lastError,
    watching,
  };
}

/** Idempotent across dev hot reloads and multi-context bootstraps. */
export function startAttestationPoller(): void {
  const state = pollerState();
  if (state.timer) return;
  state.startedAt = Date.now();
  state.timer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  // Don't hold the event loop open during shutdown.
  state.timer.unref?.();
  console.log("[attestcoin-poller] started — interval", POLL_INTERVAL_MS, "ms");
}

export function stopAttestationPoller(): void {
  const state = pollerState();
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
    console.log("[attestcoin-poller] stopped");
  }
}

async function tick(): Promise<void> {
  const state = pollerState();
  if (state.busy) return; // previous tick still in flight — skip this one
  state.busy = true;
  try {
    ensureDb();
    // G1 — resolve chain keys from the live ChainInfo map (stale-safe).
    await ensureSourceChainMapFresh();
    // ── P3 fix (candidate starvation — the auto-attest root cause) ───────────
    // The old query was `orderBy(desc(createdAt)).limit(20)` with NO chain
    // filter: the NEWEST 20 unattested rows (least likely to be attested
    // yet, lag is 8-10 min) permanently occupied the window while payments
    // settled on UNTRACKED chains (Base/Polygon/BSC — skipped only in JS)
    // crowded out attestable rows entirely. Once 20 such rows existed,
    // `groups` was empty on every tick and auto-attestation was dead.
    // Fix: filter to tracked chains IN SQL, oldest-first (the window DRAINS —
    // attestable rows leave the set), and apply the age cutoff in SQL too.
    const candidates = db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.status, "settled"),
          isNotNull(payments.txHash),
          ne(payments.txHash, ""),
          ne(payments.txHash, "0x0"),
          isNull(payments.attestedAt),
          inArray(payments.chainId, SOURCE_CHAINS_FALLBACK_IDS()),
          gte(payments.createdAt, Date.now() - MAX_AGE_MS),
        ),
      )
      .orderBy(asc(payments.createdAt))
      .limit(BATCH_LIMIT)
      .all();
    const fresh = candidates;

    // G3 — group candidates by chainKey and try ONE getBatchProof call per
    // group (≤10 hashes): the builder returns a shared continuity proof that
    // covers every block, plus each tx's merkle proof. When the batch call
    // can't serve (any tx unattested → whole call fails), fall back to the
    // per-tx path so partially-attested groups still flip.
    const groups = new Map<number, typeof fresh>();
    for (const row of fresh) {
      const chain = row.chainId ? sourceChainByEvmId(row.chainId) : undefined;
      if (!chain || !row.txHash) continue; // untracked chain — nothing to attest
      const bucket = groups.get(chain.chainKey);
      if (bucket) bucket.push(row);
      else groups.set(chain.chainKey, [row]);
    }

    let checked = 0;
    for (const [chainKey, rows] of groups) {
      checked += rows.length;
      // ≤10 hashes per builder call (protocol batch size; also keeps the
      // REST payload sane).
      for (let i = 0; i < rows.length; i += 10) {
        const slice = rows.slice(i, i + 10);
        const batch = await pollBatch(chainKey, slice);
        if (batch) {
          await afterBatchFlips(chainKey, batch);
        } else {
          // Batch unavailable — per-tx fallback (the original path).
          for (const row of slice) await pollOne(row);
        }
      }
    }
    state.lastTickAt = Date.now();
    state.lastTickChecked = checked;
    state.lastError = null;
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    console.error("[attestcoin-poller] tick failed:", err);
  } finally {
    state.busy = false;
  }
}

/** One immediate poll pass — used by instrumentation at boot so the first
 * attestations don't wait for the first 60s interval (P3 warm-up). */
export async function pollOnce(): Promise<void> {
  await tick();
}

interface BatchFlip {
  entries: BatchProofEntry[];
  sharedContinuity: unknown;
  rows: (typeof payments.$inferSelect)[];
}

/**
 * Try the batch path for one ≤10 slice: ONE getBatchProof call. Returns null
 * when the builder can't serve the whole slice (caller falls back per-tx).
 */
async function pollBatch(
  chainKey: number,
  rows: (typeof payments.$inferSelect)[],
): Promise<BatchFlip | null> {
  const hashes = rows.map((r) => r.txHash!);
  const outcome = await fetchBatchProofs(chainKey, hashes).catch(() => null);
  if (!outcome || outcome.state !== "proof" || !outcome.sharedContinuity) {
    return null; // pending/error — per-tx fallback decides per payment
  }
  const byHash = new Map(outcome.entries.map((e) => [e.txHash.toLowerCase(), e]));
  const entries: BatchFlip["entries"] = [];
  const matched: (typeof payments.$inferSelect)[] = [];
  for (const row of rows) {
    const entry = byHash.get(row.txHash!.toLowerCase());
    if (!entry) continue; // builder omitted it — next tick retries
    // Same conditional flip as pollOne: only the writer that changes the row
    // emits the notification (sqlite single-writer keeps ticks safe).
    const flipped = db
      .update(payments)
      .set({ attestedAt: Date.now(), attestRoot: entry.merkleProof?.root ?? "" })
      .where(and(eq(payments.id, row.id), isNull(payments.attestedAt)))
      .run();
    if (flipped.changes === 0) continue; // another writer got there first
    entries.push(entry);
    matched.push(row);
    console.log(
      `[attestcoin-poller] payment ${row.id} attested (batch) — block ${entry.headerNumber}`,
    );
  }
  if (entries.length === 0) return null;
  return { entries, sharedContinuity: outcome.sharedContinuity, rows: matched };
}

/** Post-flip work for a batch: ONE read-only verifyBatch eth_call (G9). */
async function afterBatchFlips(chainKey: number, batch: BatchFlip): Promise<void> {
  const state = pollerState();
  state.lastFlipAt = Date.now();
  state.flippedTotal += batch.entries.length;

  // Best-effort on-chain verification — the Creditcoin chain itself re-checks
  // the whole batch with ONE precompile eth_call (verifyBatch is read-only).
  try {
    const result = await verifyProofsBatchOnChain(
      chainKey,
      batch.entries.map((e) => ({
        headerNumber: e.headerNumber,
        txBytes: e.txBytes,
        merkleProof: e.merkleProof as never,
      })),
      batch.sharedContinuity as never,
    );
    if (result?.verified) {
      for (const row of batch.rows) {
        db.update(payments)
          .set({ onchainVerifiedAt: result.verifiedAt })
          .where(and(eq(payments.id, row.id), isNull(payments.onchainVerifiedAt)))
          .run();
      }
      console.log(
        `[attestcoin-poller] batch on-chain verification PASSED — ${result.count} proof(s) in ${result.calls} eth_call(s)`,
      );
    }
  } catch (err) {
    console.error("[attestcoin-poller] batch on-chain verification failed:", err);
  }

  for (const row of batch.rows) {
    try {
      createPaymentNotification(
        "attested",
        row.token,
        row.amountHuman,
        row.recipientLabel ?? row.recipientAddress,
        row.id,
      );
    } catch (err) {
      console.error("[attestcoin-poller] notification insert failed:", err);
    }
  }
}

async function pollOne(row: typeof payments.$inferSelect): Promise<void> {
  const chain = sourceChainByEvmId(row.chainId);
  if (!chain || !row.txHash) return; // untracked chain — nothing to attest

  const outcome = await getTxProof(chain.chainKey, row.txHash);
  if (outcome.state !== "proof" || !outcome.proof) return; // pending/error — next tick retries

  const flipped = db
    .update(payments)
    .set({ attestedAt: Date.now(), attestRoot: outcome.proof.merkleRoot })
    .where(and(eq(payments.id, row.id), isNull(payments.attestedAt)))
    .run();

  if (flipped.changes === 0) return; // another writer got there first

  console.log(
    `[attestcoin-poller] payment ${row.id} attested — block ${outcome.proof.headerNumber}, root ${outcome.proof.merkleRoot.slice(0, 18)}…`,
  );

  const state = pollerState();
  state.lastFlipAt = Date.now();
  state.flippedTotal += 1;

  // Best-effort on-chain verification (read-only precompile call, no signer):
  // the Creditcoin chain itself re-checks the Merkle + continuity proof.
  if (outcome.raw) {
    try {
      const onchain = await verifyProofOnChain(outcome.raw);
      if (onchain?.verified) {
        db.update(payments)
          .set({ onchainVerifiedAt: onchain.verifiedAt })
          .where(and(eq(payments.id, row.id), isNull(payments.onchainVerifiedAt)))
          .run();
        console.log(
          `[attestcoin-poller] payment ${row.id} on-chain verification PASSED (Block Prover precompile)`,
        );
      }
    } catch (err) {
      console.error("[attestcoin-poller] on-chain verification failed:", err);
    }
  }

  try {
    createPaymentNotification(
      "attested",
      row.token,
      row.amountHuman,
      row.recipientLabel ?? row.recipientAddress,
      row.id,
    );
  } catch (err) {
    console.error("[attestcoin-poller] notification insert failed:", err);
  }
}
