import { and, asc, count, eq, gte, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { db, ensureDb } from "@/db";
import { agentActions, payments, type AgentActionRow } from "@/db/schema";
import { createActionAttestedNotification, createPaymentNotification } from "@/lib/notifications";
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
// AC8 (action attestation tracking): the SAME flip now runs for agent ACTIONS
// (src/db/schema.ts `agent_actions`) — transfers, contract deployments, escrow
// locks, swaps — whose result JSON carries a source-chain tx hash. Before this,
// the poller watched only the `payments` table, so agent-executed actions were
// never attestation-tracked and never appeared in the "recent attestations"
// feed (worklog root cause #5). Payments keep their exact original behavior:
// same candidate query, same batch/per-tx paths, same notifications.
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
/** AC8: how many candidate agent actions one tick may check (oldest first). */
const ACTION_BATCH_LIMIT = 20;
/** Payments older than this stop being polled (source chains prune history). */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// ── AC8: pure action-eligibility helpers (exported for unit tests) ────────────
//
// Which agent_actions rows can the poller attest? Eligibility rules (commented
// where enforced):
//   • status must be "succeeded" — failed/declined/interrupted/unknown rows
//     never attest (an "unknown" tx may still land, but until the row says
//     succeeded there is nothing honest to certify).
//   • a SOURCE tx hash must be available: the top-level `txHash` of
//     result_json (written by the loop for every broadcast tool result), the
//     first SUCCESS entry of a batch_transfer's `results` array (a single row
//     can carry several txs — we track the first success and say so), or the
//     dedicated `source_tx_hash` column (set for attestcoin-flow tools).
//     Read-only tools (balances, status checks, decoders) record no txHash →
//     skipped.
//   • the row's chain_id must resolve to a tracked Attestcoin SOURCE chain
//     (Sepolia 11155111 / Ethereum 1 via SOURCE_CHAINS_FALLBACK_IDS).
//   • Creditcoin itself (102031 testnet / 102030 mainnet) is the DESTINATION
//     chain — proofs verify ON it, so it can never attest itself → excluded
//     even if a hash is present (e.g. execute_conditional_release rows whose
//     own tx lives on Creditcoin).
//   • `attested_at` must still be NULL (not yet flipped).

/** EVM chain ids of the Creditcoin chains themselves (destination, never a source). */
export const CREDITCOIN_DESTINATION_EVM_IDS: readonly number[] = [102031, 102030];

/** A tx hash is a 0x-prefixed 32-byte hex string — anything else isn't one. */
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** The subset of AgentActionRow the eligibility helpers need (test-friendly). */
export interface ActionAttestEligibility {
  status: string;
  chainId: number | null;
  sourceTxHash: string | null;
  resultJson: string | null;
  attestedAt: number | null;
}

/**
 * Extract the source-chain tx hash an agent action should be attested against,
 * or null when the action has none (read-only tools). Pure.
 *
 * Precedence:
 *   1. result_json `results[]` — batch_transfer carries one tx per entry; a
 *      single row attests the FIRST SUCCESS entry's hash (honest and simple:
 *      the row-level attestation then points at a tx that actually confirmed).
 *   2. result_json top-level `txHash` — the loop writes this for every
 *      broadcast client-tool result (transfer, deploy, escrow lock, swap).
 *   3. the dedicated `source_tx_hash` column — attestcoin-flow tools record
 *      the source tx they depend on there.
 */
export function actionSourceTxHash(
  resultJson: string | null,
  sourceTxHash: string | null,
): string | null {
  if (resultJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(resultJson);
    } catch {
      parsed = null; // malformed result JSON — fall through to the column
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      // batch_transfer: [{ recipient, ok, txHash?, summary }, …]
      if (Array.isArray(obj.results)) {
        for (const entry of obj.results) {
          if (!entry || typeof entry !== "object") continue;
          const e = entry as Record<string, unknown>;
          if (e.ok !== true) continue; // only confirmed entries count
          const hash = e.txHash;
          if (typeof hash === "string" && TX_HASH_RE.test(hash)) return hash;
        }
      }
      const top = obj.txHash;
      if (typeof top === "string" && TX_HASH_RE.test(top)) return top;
    }
  }
  if (typeof sourceTxHash === "string" && TX_HASH_RE.test(sourceTxHash)) return sourceTxHash;
  return null;
}

/**
 * Whether an agent_actions row is eligible for attestation tracking. Pure —
 * `trackedSourceEvmIds` is SOURCE_CHAINS_FALLBACK_IDS() at runtime and a
 * literal in tests. See the AC8 block comment above for the rules.
 */
export function isAttestableAction(
  row: ActionAttestEligibility,
  trackedSourceEvmIds: readonly number[],
): boolean {
  if (row.status !== "succeeded") return false;
  if (row.attestedAt != null) return false; // already flipped — nothing to do
  if (row.chainId == null) return false;
  // Creditcoin is the DESTINATION chain — never attest itself.
  if (CREDITCOIN_DESTINATION_EVM_IDS.includes(row.chainId)) return false;
  // Only tracked Attestcoin source chains (Sepolia/Ethereum) have proofs.
  if (!trackedSourceEvmIds.includes(row.chainId)) return false;
  // And only rows with a real source tx hash (read-only tools skip).
  return actionSourceTxHash(row.resultJson, row.sourceTxHash) != null;
}

/**
 * AC8: SQL-side "this action row carries a source tx hash" predicate —
 * the dedicated `source_tx_hash` column, or a top-level `txHash` inside
 * `result_json` (every broadcast client-tool result writes one; batch rows
 * carry the first hash at the top level too). Read-only tools (balances,
 * status checks…) record neither → excluded IN SQL, so they can never occupy
 * the candidate window (the P3 starvation lesson applied to actions: they
 * would sit in the oldest-first LIMIT window forever, since they never flip
 * and only age out after MAX_AGE_MS). The JS-side isAttestableAction() check
 * stays authoritative per row (it also understands batch `results[]` and
 * validates the hash shape); this predicate is the cheap SQL pre-filter that
 * keeps the window and the `watching` stat honest.
 */
const ACTION_HAS_SOURCE_TX_SQL = sql`(
  source_tx_hash IS NOT NULL
  OR (
    result_json IS NOT NULL
    AND json_valid(result_json)
    AND json_extract(result_json, '$.txHash') IS NOT NULL
  )
)`;

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
  /** Rows examined by the most recent completed tick (payments + agent actions). */
  lastTickChecked: number | null;
  lastFlipAt: number | null;
  flippedTotal: number;
  lastError: string | null;
  /**
   * Rows currently eligible for polling. AC8: this is now the SUM of unattested
   * payments and unattested eligible agent actions — the watcher line must
   * reflect everything the poller can act on, not just payments. (Previously
   * payments only; additive consumers that only care about payments can
   * subtract `watchingActions`.)
   */
  watching: number | null;
  /** AC8: the agent-action share of `watching` (null when the count failed). */
  watchingActions: number | null;
}

/** Liveness snapshot for the wallet panel — cheap local DB counts. */
export function getPollerStats(): PollerStats {
  const state = pollerState();
  let watching: number | null = null;
  let watchingActions: number | null = null;
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
    // AC8: the same shape of count for agent actions — including the SQL-side
    // tx-hash predicate, so read-only rows can't inflate the number (they
    // never flip and would pin "watching" up for the whole age window).
    const actionRow = db
      .select({ value: count() })
      .from(agentActions)
      .where(
        and(
          eq(agentActions.status, "succeeded"),
          isNull(agentActions.attestedAt),
          inArray(agentActions.chainId, SOURCE_CHAINS_FALLBACK_IDS()),
          gte(agentActions.createdAt, Date.now() - MAX_AGE_MS),
          ACTION_HAS_SOURCE_TX_SQL,
        ),
      )
      .get();
    watchingActions = actionRow?.value ?? 0;
    watching = (row?.value ?? 0) + watchingActions;
  } catch {
    watching = null;
    watchingActions = null;
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
    watchingActions,
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

    // ── AC8: agent-action candidates (same shape of window as payments) ──────
    // Succeeded, unattested, on a tracked source chain, inside the age window,
    // and carrying a source tx hash IN SQL (see ACTION_HAS_SOURCE_TX_SQL —
    // without that predicate, read-only rows would permanently occupy the
    // oldest-first window and starve attestable actions, the exact P3
    // starvation class the payments query fixed). The JS-side eligibility
    // helper re-checks each row authoritatively (batch results[], hash shape,
    // destination-chain exclusion) before any network call.
    const trackedIds = SOURCE_CHAINS_FALLBACK_IDS();
    const actionCandidates = db
      .select()
      .from(agentActions)
      .where(
        and(
          eq(agentActions.status, "succeeded"),
          isNull(agentActions.attestedAt),
          inArray(agentActions.chainId, trackedIds),
          gte(agentActions.createdAt, Date.now() - MAX_AGE_MS),
          ACTION_HAS_SOURCE_TX_SQL,
        ),
      )
      .orderBy(asc(agentActions.createdAt))
      .limit(ACTION_BATCH_LIMIT)
      .all();
    let actionChecked = 0;
    for (const row of actionCandidates) {
      if (!isAttestableAction(row, trackedIds)) continue; // no source tx / destination chain — skip
      actionChecked += 1;
      await pollActionOne(row);
    }

    state.lastTickAt = Date.now();
    // AC8: `checked` now includes eligible agent actions examined this tick
    // (payments + actions), matching what `watching` counts.
    state.lastTickChecked = checked + actionChecked;
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

// ── AC8: shared per-tx flip ───────────────────────────────────────────────────
// The proof → conditional flip → on-chain verify sequence is identical for
// payments and agent actions; only the table-specific UPDATEs (and the label
// for logs) differ. This helper carries the common part so the two paths can't
// drift; the payments path keeps its exact original behavior (same UPDATE
// predicates, same log lines, same notification trigger).

/** Table-specific writes for one watched row. */
interface AttestTableAdapter {
  /** Log label ("payment" | "agent action"). */
  label: string;
  /** Conditional flip: SET attested_at + attest_root WHERE id AND attested_at IS NULL.
   * Returns true only when THIS call changed the row (the notification gate). */
  markAttested(id: string, attestedAt: number, attestRoot: string): boolean;
  /** Best-effort: SET onchain_verified_at WHERE id AND onchain_verified_at IS NULL. */
  markVerified(id: string, verifiedAt: number): void;
}

/**
 * Fetch the proof for one candidate's tx; on success flip the row and run the
 * read-only on-chain verification. Returns whether THIS call flipped the row
 * (the caller then fires its table-specific notification).
 */
async function attestCandidate(
  row: { id: string; txHash: string; chainId: number },
  table: AttestTableAdapter,
): Promise<boolean> {
  const chain = sourceChainByEvmId(row.chainId);
  if (!chain || !row.txHash) return false; // untracked chain — nothing to attest

  const outcome = await getTxProof(chain.chainKey, row.txHash);
  if (outcome.state !== "proof" || !outcome.proof) return false; // pending/error — next tick retries

  const flipped = table.markAttested(row.id, Date.now(), outcome.proof.merkleRoot);
  if (!flipped) return false; // another writer got there first

  console.log(
    `[attestcoin-poller] ${table.label} ${row.id} attested — block ${outcome.proof.headerNumber}, root ${outcome.proof.merkleRoot.slice(0, 18)}…`,
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
        table.markVerified(row.id, onchain.verifiedAt);
        console.log(
          `[attestcoin-poller] ${table.label} ${row.id} on-chain verification PASSED (Block Prover precompile)`,
        );
      }
    } catch (err) {
      console.error("[attestcoin-poller] on-chain verification failed:", err);
    }
  }

  return true;
}

async function pollOne(row: typeof payments.$inferSelect): Promise<void> {
  if (!row.txHash) return;
  const flipped = await attestCandidate(
    { id: row.id, txHash: row.txHash, chainId: row.chainId },
    {
      label: "payment",
      markAttested: (id, attestedAt, attestRoot) =>
        db
          .update(payments)
          .set({ attestedAt, attestRoot })
          .where(and(eq(payments.id, id), isNull(payments.attestedAt)))
          .run().changes !== 0,
      markVerified: (id, verifiedAt) => {
        db.update(payments)
          .set({ onchainVerifiedAt: verifiedAt })
          .where(and(eq(payments.id, id), isNull(payments.onchainVerifiedAt)))
          .run();
      },
    },
  );
  if (!flipped) return;

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

/** AC8: per-tx flip for one eligible agent action row (see attestCandidate). */
async function pollActionOne(row: AgentActionRow): Promise<void> {
  const txHash = actionSourceTxHash(row.resultJson, row.sourceTxHash);
  if (!txHash || row.chainId == null) return;
  const flipped = await attestCandidate(
    { id: row.id, txHash, chainId: row.chainId },
    {
      label: "agent action",
      markAttested: (id, attestedAt, attestRoot) =>
        db
          .update(agentActions)
          .set({ attestedAt, attestRoot })
          .where(and(eq(agentActions.id, id), isNull(agentActions.attestedAt)))
          .run().changes !== 0,
      markVerified: (id, verifiedAt) => {
        db.update(agentActions)
          .set({ onchainVerifiedAt: verifiedAt })
          .where(and(eq(agentActions.id, id), isNull(agentActions.onchainVerifiedAt)))
          .run();
      },
    },
  );
  if (!flipped) return;

  // AC10 (notification dedupe): agent-initiated transfers are ALSO recorded
  // as payment rows (AC5) — the payments half of this poller flips those and
  // fires their notification. When a payment row exists for the same tx, IT
  // owns the notification; this action row still flips (the Actions view shows
  // its attestation state) but stays silent, so the user gets exactly ONE
  // "attested" notification per transaction, not two.
  try {
    const backing = db
      .select({ id: payments.id })
      .from(payments)
      .where(eq(payments.txHash, txHash))
      .limit(1)
      .get();
    if (backing) return;
  } catch {
    // best-effort — a failed lookup must not suppress the notification
  }

  try {
    createActionAttestedNotification(row.tool, txHash, row.id);
  } catch (err) {
    console.error("[attestcoin-poller] notification insert failed:", err);
  }
}
