// ─────────────────────────────────────────────────────────────────────────────
// Recurring payment executor tests (brief §5 + §11): drive the REAL fire
// logic (lib/recurring/fire.ts) against an isolated SQLite DB — no browser,
// no wallet — and assert the ledger invariants that guard fund safety:
//
//   1. a due schedule fires: +1 execution, nextFireAt advances to the next
//      future slot, an action-log row lands (recurring_payment, risk funds)
//   2. CATCH-UP: 3 missed weekly slots burn exactly ONE execution and land
//      the next slot in the future (never double-charges a gap)
//   3. completion: reaching maxExecutions deactivates the schedule; further
//      fires skip cleanly
//   4. dedup latch: two fires within the window → exactly one execution
//      (the loser gets a skip response with no side effects)
//   5. requeue: restoring pre-fire state rolls executions/nextFireAt/active
//      back and clears the latch (lastFireAt) for a clean retry
//   6. cadence dialects: "weekly"/"biweekly"/"monthly" strings AND legacy
//      numeric 1/2/3 both resolve to 7/14/30-day intervals
// ─────────────────────────────────────────────────────────────────────────────

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ── DB isolation: env-var DB path BEFORE any app-module import ──────────────
process.env.ACP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "acp-recurring-test-")), "test.db");

const {
  fireRecurringSchedule,
  requeueRecurringSchedule,
  cadenceIntervalMs,
  insertTestSchedule,
} = await import("@/lib/recurring/fire");
const { validateCustomCadence, cadenceStorage } = await import("@/lib/recurring/cadence");
const { listActions } = await import("@/lib/agent/action-log");
const { db, ensureDb } = await import("@/db");
const { recurringSchedules } = await import("@/db/schema");
const { eq } = await import("drizzle-orm");

const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);

function row(id: string) {
  return db.select().from(recurringSchedules).where(eq(recurringSchedules.id, id)).all()[0];
}

before(() => {
  ensureDb();
});

describe("recurring payment fire logic", () => {
  test("a due schedule fires: +1 execution, next slot in the future, action-log row", () => {
    insertTestSchedule({
      id: "rec-basic",
      cadence: "weekly",
      nextFireAt: nowSec() - 60, // due a minute ago
      executions: 0,
      maxExecutions: 4,
      chainId: 11155111,
      amountHuman: "12.5",
    });

    const before = row("rec-basic");
    const out = fireRecurringSchedule("rec-basic", "dispatched");

    assert.equal(out.ok, true);
    assert.ok(!out.skipped);
    if (out.ok && !out.skipped) {
      assert.equal(out.previous.executions, 0);
      assert.equal(out.previous.nextFireAt, before.nextFireAt);
    }

    const after = row("rec-basic");
    assert.equal(after.executions, 1);
    assert.equal(after.active, true);
    assert.ok(after.nextFireAt > nowSec(), "next slot must be strictly in the future");
    assert.ok(after.nextFireAt <= nowSec() + 7 * DAY + 60, "weekly cadence stays ~7d out");
    assert.equal(after.lastStatus, "dispatched");
    assert.ok(after.lastFireAt != null);

    const actions = listActions(50).filter((a) => a.runId?.startsWith("recurring-rec-basic"));
    assert.equal(actions.length, 1);
    assert.equal(actions[0].tool, "recurring_payment");
    assert.equal(actions[0].riskClass, "funds");
    assert.equal(actions[0].chainId, 11155111);
    assert.ok(actions[0].resultJson?.includes("12.5"));
  });

  test("catch-up: 3 missed weekly slots burn exactly ONE execution", () => {
    insertTestSchedule({
      id: "rec-catchup",
      cadence: "weekly",
      nextFireAt: nowSec() - 3 * 7 * DAY, // 3 weeks overdue
      executions: 2,
      maxExecutions: 10,
    });

    const out = fireRecurringSchedule("rec-catchup", "dispatched");
    assert.equal(out.ok, true);

    const after = row("rec-catchup");
    assert.equal(after.executions, 3, "exactly one missed execution burns");
    assert.ok(after.nextFireAt > nowSec(), "resumes at the next future slot");
    assert.ok(after.nextFireAt <= nowSec() + 7 * DAY + 60);
  });

  test("completion: reaching maxExecutions deactivates; further fires skip", () => {
    insertTestSchedule({
      id: "rec-complete",
      cadence: "monthly",
      nextFireAt: nowSec() - 30,
      executions: 2,
      maxExecutions: 3,
    });

    const out = fireRecurringSchedule("rec-complete", "dispatched");
    assert.equal(out.ok, true);

    const after = row("rec-complete");
    assert.equal(after.executions, 3);
    assert.equal(after.active, false, "schedule completes at maxExecutions");
    assert.equal(after.lastStatus, "complete");

    const again = fireRecurringSchedule("rec-complete", "dispatched");
    assert.equal(again.ok, true);
    if (again.ok) {
      assert.equal(again.skipped, true);
      if (again.skipped) assert.equal(again.reason, "inactive");
    }
    assert.equal(row("rec-complete").executions, 3, "no further executions after completion");
  });

  test("dedup latch: two fires inside the window → exactly one execution", () => {
    insertTestSchedule({
      id: "rec-dedup",
      cadence: "weekly",
      nextFireAt: nowSec() - 60,
      executions: 0,
      maxExecutions: 5,
    });

    const first = fireRecurringSchedule("rec-dedup", "dispatched");
    const second = fireRecurringSchedule("rec-dedup", "dispatched");

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (second.ok) {
      assert.equal(second.skipped, true);
      if (second.skipped) assert.equal(second.reason, "dedup");
    }
    assert.equal(row("rec-dedup").executions, 1, "the loser must not burn an execution");
  });

  test("requeue: rolls back pre-fire state and clears the latch", () => {
    insertTestSchedule({
      id: "rec-requeue",
      cadence: "weekly",
      nextFireAt: nowSec() - 60,
      executions: 1,
      maxExecutions: 5,
    });

    const out = fireRecurringSchedule("rec-requeue", "dispatched");
    assert.ok(out.ok && !out.skipped);
    if (!out.ok || out.skipped) return;
    assert.equal(row("rec-requeue").executions, 2);

    const ok = requeueRecurringSchedule("rec-requeue", out.previous);
    assert.equal(ok, true);

    const after = row("rec-requeue");
    assert.equal(after.executions, 1, "execution count restored");
    assert.equal(after.nextFireAt, out.previous.nextFireAt, "next slot restored");
    assert.equal(after.active, true);
    assert.equal(after.lastFireAt, null, "latch cleared — next tick retries");
    assert.equal(after.lastStatus, "deferred");
  });

  test("cadence dialects: strings and legacy numbers map to 7/14/30 days", () => {
    assert.equal(cadenceIntervalMs("weekly"), 7 * 86400_000);
    assert.equal(cadenceIntervalMs("biweekly"), 14 * 86400_000);
    assert.equal(cadenceIntervalMs("monthly"), 30 * 86400_000);
    assert.equal(cadenceIntervalMs(1), 7 * 86400_000);
    assert.equal(cadenceIntervalMs("2"), 14 * 86400_000);
    assert.equal(cadenceIntervalMs(3), 30 * 86400_000);
  });

  // ── C37: fully-custom schedules ──────────────────────────────────────────

  test("C37 cadence specs: daily preset + every-<n>h / every-<n>d customs + clamping", () => {
    assert.equal(cadenceIntervalMs("daily"), 1 * 86400_000, "daily preset");
    assert.equal(cadenceIntervalMs("every-6h"), 6 * 3_600_000, "6 hours");
    assert.equal(cadenceIntervalMs("every-10d"), 10 * 86400_000, "10 days");
    assert.equal(cadenceIntervalMs("every-1h"), 3_600_000, "minimum hour interval");
    assert.equal(cadenceIntervalMs("every-1d"), 86400_000, "minimum day interval");
    // Out-of-bounds customs pull IN to the protocol bound (never explode).
    assert.equal(cadenceIntervalMs("every-9999h"), 2160 * 3_600_000, "hours clamp to 2160 (90d)");
    assert.equal(cadenceIntervalMs("every-999d"), 365 * 86400_000, "days clamp to 365");
    // Legacy defensive N-day branch is now the formal custom-days path.
    assert.equal(cadenceIntervalMs(10), 10 * 86400_000, "legacy numeric 10 → every 10 days");
    assert.equal(cadenceIntervalMs("21"), 21 * 86400_000, "legacy numeric string 21 → every 21 days");
    // Unknown junk degrades to monthly (the historical fallback).
    assert.equal(cadenceIntervalMs("banana"), 30 * 86400_000, "unknown → monthly fallback");
    assert.equal(cadenceIntervalMs(null), 30 * 86400_000, "null → monthly fallback");
  });

  test("C37 validation: honest bounds, no silent widening", () => {
    assert.deepEqual(validateCustomCadence("hours", 6), { ok: true, n: 6 });
    assert.deepEqual(validateCustomCadence("days", 365), { ok: true, n: 365 });
    assert.equal(validateCustomCadence("hours", 0).ok, false, "0 hours rejected");
    assert.equal(validateCustomCadence("hours", 2161).ok, false, "2161 hours rejected");
    assert.equal(validateCustomCadence("days", 366).ok, false, "366 days rejected");
    assert.equal(validateCustomCadence("days", 2.5).ok, false, "fractional rejected");
    assert.equal(validateCustomCadence("days", NaN).ok, false, "NaN rejected");
    // Storage round-trip: spec → storage string → same interval.
    assert.equal(cadenceStorage({ kind: "custom", unit: "hours", n: 6, intervalMs: 0 }), "every-6h");
    assert.equal(cadenceStorage({ kind: "custom", unit: "days", n: 10, intervalMs: 0 }), "every-10d");
    assert.equal(cadenceIntervalMs(cadenceStorage({ kind: "custom", unit: "days", n: 10, intervalMs: 0 })), 10 * 86400_000);
  });

  test("C37 fire: a custom every-6h schedule advances by 6h slots", () => {
    insertTestSchedule({
      id: "rec-custom-6h",
      cadence: "every-6h",
      nextFireAt: nowSec() - 3600, // due 1h ago
      executions: 0,
      maxExecutions: 5,
    });
    const out = fireRecurringSchedule("rec-custom-6h", "fired");
    assert.ok(out.ok && !out.skipped, "custom cadence fires");
    if (!out.ok || out.skipped) return;
    const after = row("rec-custom-6h");
    assert.equal(after.executions, 1);
    const advanced = after.nextFireAt - out.firedAt;
    assert.ok(advanced > 0 && advanced <= 6 * 3600, `next slot within one 6h interval (got ${advanced}s)`);
    assert.ok(after.nextFireAt > nowSec(), "next slot is in the future");
    // The action-log row carries the human-readable custom label.
    const actions = listActions(50);
    const ours = actions.find((a) => {
      if (a.tool !== "recurring_payment") return false;
      try {
        return (JSON.parse(a.paramsJson ?? "{}") as Record<string, unknown>)?.scheduleId === "rec-custom-6h";
      } catch {
        return false;
      }
    });
    assert.ok(ours, "action row exists for the custom schedule");
    const summary = (() => {
      try {
        return String((JSON.parse(ours?.resultJson ?? "{}") as Record<string, unknown>)?.summary ?? "");
      } catch {
        return "";
      }
    })();
    assert.match(summary, /every 6 hours/, "summary uses the human custom label");
  });

  test("C37 fire: a legacy N-day numeric cadence (e.g. 21) advances by 21d", () => {
    insertTestSchedule({
      id: "rec-legacy-21d",
      cadence: "21",
      nextFireAt: nowSec() - 60,
      executions: 0,
      maxExecutions: 3,
    });
    const out = fireRecurringSchedule("rec-legacy-21d", "fired");
    assert.ok(out.ok && !out.skipped);
    if (!out.ok || out.skipped) return;
    const after = row("rec-legacy-21d");
    const advanced = after.nextFireAt - out.firedAt;
    assert.ok(advanced > 20 * 86400 && advanced <= 21 * 86400, `next slot within one 21d interval (got ${advanced}s)`);
  });

  test("unknown schedule id → clean error", () => {
    const out = fireRecurringSchedule("rec-does-not-exist");
    assert.equal(out.ok, false);
    if (!out.ok) assert.ok(out.error.length > 0);
  });
});
