import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db, ensureDb } from "@/db";
import { recurringSchedules, type RecurringRow } from "@/db/schema";
import { startAction, patchAction } from "@/lib/agent/action-log";
import { getChainByChainId } from "@/lib/chains/registry";
import { cadenceIntervalMs, cadenceLabelEn } from "@/lib/recurring/cadence";

// ─────────────────────────────────────────────────────────────────────────────
// Recurring payment firing (brief §5): the server-side ledger half of the
// recurring executor. The client poller (components/recurring-poller.tsx)
// calls POST /api/recurring/[id]/fire when a schedule is DUE and the app is
// open + a wallet is connected; this module:
//
//   • atomically CLAIMS the execution (lastFireAt latch — two tabs / double
//     ticks can never double-burn an execution),
//   • advances the schedule with CATCH-UP semantics: exactly ONE missed
//     payment executes now, then nextFireAt resumes on cadence (advanced to
//     the next slot strictly after now),
//   • completes the schedule when executions reaches maxExecutions,
//   • records a row in the user-visible agent action log ("recurring_payment")
//     — the transfer itself still routes through the agent loop client-side,
//     so the wallet signature gates apply.
//
// nextFireAt/lastFireAt are stored in epoch SECONDS (the fire-loop contract:
// every reader multiplies by 1000; createdAt is epoch MILLISECONDS like every
// other table — the P17.2 units split was fixed at the write sites + a
// user_version 2 migration). A ms-range value (>1e12) in the fire fields is
// normalized defensively.
// ─────────────────────────────────────────────────────────────────────────────

/** Concurrent-tab / double-tick dedup window (mirrors automation fire). */
export const FIRE_DEDUP_MS = 5_000;

export type RecurringFireOutcome =
  | {
      ok: true;
      skipped: false;
      schedule: RecurringRow;
      /** Pre-fire state so the client can requeue if the agent dispatch races a busy run. */
      previous: { executions: number; nextFireAt: number; active: boolean };
      firedAt: number;
    }
  | { ok: true; skipped: true; schedule: RecurringRow; reason: "dedup" | "inactive" | "complete" }
  | { ok: false; error: string };

// C37: all cadence math flows through the shared spec module (presets +
// "every-<n>h"/"every-<n>d" customs + legacy numeric dialects).
export { cadenceIntervalMs } from "@/lib/recurring/cadence";

/** Seconds if the stored value is seconds; ms values (>1e12) are normalized. */
function toSeconds(v: number): number {
  return v > 1e12 ? Math.floor(v / 1000) : v;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Fire one execution of a due schedule.
 *
 * @param id schedule row id
 * @param bodyStatus client-reported status label ("fired" | "dispatched" | …)
 */
export function fireRecurringSchedule(id: string, bodyStatus = "fired"): RecurringFireOutcome {
  ensureDb();
  const row = db.select().from(recurringSchedules).where(eq(recurringSchedules.id, id)).all()[0];
  if (!row) return { ok: false, error: "Schedule not found." };
  if (!row.active) return { ok: true, skipped: true, schedule: row, reason: "inactive" };
  if (row.executions >= row.maxExecutions) {
    return { ok: true, skipped: true, schedule: row, reason: "complete" };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const previous = {
    executions: row.executions,
    nextFireAt: toSeconds(row.nextFireAt),
    active: row.active,
  };

  // Atomic claim (dedup window) — the loser's UPDATE matches 0 rows and it
  // receives a skip response with no side effects.
  const cutoffSec = Math.floor((Date.now() - FIRE_DEDUP_MS) / 1000);
  const claim = db
    .update(recurringSchedules)
    .set({ lastFireAt: nowSec, lastStatus: bodyStatus.slice(0, 40) })
    .where(
      and(
        eq(recurringSchedules.id, id),
        eq(recurringSchedules.active, true),
        or(
          isNull(recurringSchedules.lastFireAt),
          lt(recurringSchedules.lastFireAt, cutoffSec),
        ),
      ),
    )
    .run();
  const claimCount = typeof claim.changes === "number" ? claim.changes : Number(claim.changes);
  if (claimCount !== 1) {
    const current = db.select().from(recurringSchedules).where(eq(recurringSchedules.id, id)).all()[0];
    return { ok: true, skipped: true, schedule: current ?? row, reason: "dedup" };
  }

  // ── Advance the schedule (catch-up: ONE missed execution now, then the
  // next slot strictly after now — cadence resumes, no double-charging gaps).
  const intervalSec = Math.floor(cadenceIntervalMs(row.cadence) / 1000);
  let nextSec = toSeconds(row.nextFireAt);
  // Guard: if the schedule was never due (manual "Run now"), the next slot
  // simply steps one interval from the OLD slot (or now, whichever is later).
  const baseSec = Math.max(nextSec, nowSec);
  while (nextSec <= nowSec) nextSec += intervalSec;
  if (nextSec < baseSec) nextSec = baseSec;

  const executions = row.executions + 1;
  const complete = executions >= row.maxExecutions;
  db.update(recurringSchedules)
    .set({
      executions,
      nextFireAt: nextSec,
      active: complete ? false : true,
      lastFireAt: nowSec,
      lastStatus: complete ? "complete" : bodyStatus.slice(0, 40),
    })
    .where(eq(recurringSchedules.id, id))
    .run();

  // ── Action-log row (user-visible on /wallet, same start→patch pattern).
  const chainName = row.chainId != null ? getChainByChainId(row.chainId)?.name ?? `chain ${row.chainId}` : null;
  const label = row.recipientLabel ? ` "${row.recipientLabel}"` : "";
  const summary = `Recurring payment${label} executed (${cadenceLabelEn(row.cadence)}): transfer ${row.amountHuman} ${row.token} to ${shortAddr(row.recipientAddress)}${chainName ? ` on ${chainName}` : ""}. Execution ${executions}/${row.maxExecutions}.${complete ? " Schedule complete." : ""}`;
  const actionId = startAction({
    runId: `recurring-${row.id}-${Date.now().toString(36)}`,
    tool: "recurring_payment",
    params: {
      scheduleId: row.id,
      recipient: row.recipientAddress,
      amount: row.amountHuman,
      token: row.token,
      chainId: row.chainId,
      cadence: String(row.cadence),
      execution: executions,
      maxExecutions: row.maxExecutions,
    },
    riskClass: "funds",
    chainId: row.chainId ?? null,
    // The dispatched transfer still passes through the wallet signature
    // gate — that shows up on this row (and in full on the loop's own rows).
    confirmationRequired: true,
  });
  // P24 honesty: the transfer is DISPATCHED to the agent loop here — its true
  // outcome (wallet signature, broadcast, receipt) lands on the loop's own
  // action row. Recording "succeeded" claimed completion before the wallet
  // even prompted.
  patchAction(actionId, { status: "dispatched", result: { ok: true, summary: `${summary} (dispatched to the agent loop — the wallet signature and on-chain outcome are recorded on the transfer's own action row.)` } });

  const updated = db.select().from(recurringSchedules).where(eq(recurringSchedules.id, id)).all()[0];
  return { ok: true, skipped: false, schedule: updated ?? row, previous, firedAt: nowSec };
}

/** Requeue after a lost race with a busy agent run: restore pre-fire state. */
export function requeueRecurringSchedule(id: string, previous: { executions: number; nextFireAt: number; active: boolean }): boolean {
  ensureDb();
  const res = db
    .update(recurringSchedules)
    .set({
      executions: Math.max(0, previous.executions),
      nextFireAt: toSeconds(previous.nextFireAt),
      active: previous.active ? true : false,
      lastFireAt: null,
      lastStatus: "deferred",
    })
    .where(eq(recurringSchedules.id, id))
    .run();
  const count = typeof res.changes === "number" ? res.changes : Number(res.changes);
  return count === 1;
}

/** Test seam: insert a schedule row directly (unit tests use ACP_DB_PATH isolation). */
export function insertTestSchedule(row: Partial<RecurringRow> & { id: string }): void {
  ensureDb();
  db.insert(recurringSchedules)
    .values({
      id: row.id,
      recipientLabel: row.recipientLabel ?? null,
      recipientAddress: row.recipientAddress ?? "0x9f8a7B6c5D4e3F2a1B0c9D8e7F6a5B4c3D2e1F0a",
      token: row.token ?? "USDC",
      tokenAddress: row.tokenAddress ?? null,
      amountHuman: row.amountHuman ?? "5",
      amountBaseUnits: row.amountBaseUnits ?? "5000000",
      cadence: row.cadence ?? "weekly",
      chainId: row.chainId ?? 11155111,
      nextFireAt: row.nextFireAt ?? Math.floor(Date.now() / 1000),
      lastFireAt: row.lastFireAt ?? null,
      executions: row.executions ?? 0,
      maxExecutions: row.maxExecutions ?? 3,
      active: row.active ?? true,
      lastStatus: row.lastStatus ?? null,
      scheduleIdHash: row.scheduleIdHash ?? randomUUID(),
      senderAddress: row.senderAddress ?? null,
      createdAt: row.createdAt ?? Math.floor(Date.now() / 1000),
      userId: row.userId ?? null,
    })
    .onConflictDoNothing()
    .run();
}
