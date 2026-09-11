import { db, ensureDb } from "@/db";
import { automationRules } from "@/db/schema";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { startAction, patchAction } from "@/lib/agent/action-log";
import { createNotification } from "@/lib/notifications";
import { serializeRule } from "@/lib/automation/validate";
import { getChainByChainId } from "@/lib/chains/registry";
import type { AutomationActionConfig, AutomationTriggerConfig } from "@/lib/automation/types";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/automation/[id]/fire — the latch + ledger for a rule firing.
// Called by the client poller right before it executes the action:
//   • lastFiredAt = now (eligibility latch for schedule/balance re-arms),
//   • lastStatus  = what happened ("notified" / "fired" / client-reported),
//   • a row lands in the user-visible agent action log (same pattern as
//     src/lib/agent/action-log.ts: start → patch with result) recording the
//     rule, its trigger and the action it dispatched,
//   • for "notify" actions the notification itself is inserted here —
//     createNotification (lib/notifications.ts) is server-side (SQLite), so
//     the fire endpoint is the seam that delivers it,
//   • the action payload is returned so the poller can execute "transfer"
//     through the agent loop (wallet signature + action log for free).
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** Concurrent-tab / double-tick dedup: a second fire within this window is a
 *  race duplicate (React StrictMode double-mount, two open tabs) — it is
 *  skipped with no side effects, so a notify action notifies once and a
 *  transfer action dispatches exactly one agent run. */
const FIRE_DEDUP_MS = 5_000;

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function actionSummary(rule: { name: string; triggerType: string }, action: AutomationActionConfig): string {
  if (action.kind === "notify") {
    return `Automation rule "${rule.name}" fired — notification delivered.`;
  }
  const chainName = getChainByChainId(action.chainId)?.name ?? `chain ${action.chainId}`;
  return `Automation rule "${rule.name}" fired (${rule.triggerType}). Action: transfer ${action.amount} ${action.token} to ${shortAddr(action.recipient)} on ${chainName}.`;
}

export async function POST(req: Request, { params }: RouteParams) {
  ensureDb();
  const { id } = await params;

  const row = db.select().from(automationRules).where(eq(automationRules.id, id)).all()[0];
  if (!row) return new Response(JSON.stringify({ error: "Rule not found" }), { status: 404 });

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  } catch {
    body = {};
  }

  let action: AutomationActionConfig;
  let triggerConfig: AutomationTriggerConfig;
  try {
    action = JSON.parse(row.actionJson) as AutomationActionConfig;
    triggerConfig = JSON.parse(row.triggerConfigJson) as AutomationTriggerConfig;
  } catch {
    return new Response(JSON.stringify({ error: "Rule has a corrupt action/trigger config." }), { status: 500 });
  }

  const now = Date.now();

  // Dedup (see FIRE_DEDUP_MS) — an ATOMIC claim, not a read-then-check: the
  // update only lands when the row is outside the window, so two tabs racing
  // (both seeing lastFiredAt null on app open) still notify/dispatch exactly
  // once — the loser's update matches 0 rows and it gets a skip response.
  const isNotify = action.kind === "notify";
  const lastStatus = isNotify ? "notified" : (typeof body.status === "string" ? body.status.slice(0, 40) : "fired");

  const cutoff = now - FIRE_DEDUP_MS;
  const claim = db
    .update(automationRules)
    .set({ lastFiredAt: now, lastStatus })
    .where(
      and(
        eq(automationRules.id, id),
        or(isNull(automationRules.lastFiredAt), lt(automationRules.lastFiredAt, cutoff)),
      ),
    )
    .run();
  const claimCount = typeof claim.changes === "number" ? claim.changes : Number(claim.changes);
  if (claimCount !== 1) {
    const current = db.select().from(automationRules).where(eq(automationRules.id, id)).all()[0];
    return new Response(
      JSON.stringify({ ok: true, skipped: true, rule: serializeRule(current), firedAt: current?.lastFiredAt ?? null }),
      { headers: { "content-type": "application/json" } },
    );
  }

  // Notify actions are delivered HERE (server-side) — the notifications
  // surface picks them up on its next poll.
  let notificationId: string | null = null;
  if (action.kind === "notify") {
    notificationId = createNotification(`Automation: ${row.name}`, action.message, "system");
  }

  // The action-log record (same start→patch pattern as the agent loop).
  const chainId =
    action.kind === "transfer"
      ? action.chainId
      : "chainId" in triggerConfig
        ? triggerConfig.chainId
        : null;
  const actionId = startAction({
    runId: `automation-${row.id}-${now.toString(36)}`,
    tool: "automation_rule",
    params: {
      ruleId: row.id,
      ruleName: row.name,
      trigger: { type: row.triggerType, config: triggerConfig },
      action,
    },
    riskClass: action.kind === "transfer" ? "funds" : "read",
    chainId,
    // A dispatched transfer still goes through the wallet's signature gate
    // gate — that shows up on this row (and in full on the loop's own rows).
    confirmationRequired: action.kind === "transfer",
  });
  patchAction(actionId, {
    // P24 honesty: a notify action IS complete here (delivered server-side);
    // a transfer action is only DISPATCHED — its true outcome (signature,
    // broadcast, receipt) lands on the agent loop's own action row. Recording
    // "succeeded" here claimed a transfer completed before the wallet even
    // prompted.
    status: action.kind === "notify" ? "succeeded" : "dispatched",
    result: {
      ok: true,
      summary:
        action.kind === "notify"
          ? actionSummary(row, action)
          : `${actionSummary(row, action)} (dispatched to the agent loop — the wallet signature and on-chain outcome are recorded on the transfer's own action row.)`,
      action,
      notificationId,
    },
  });

  const updated = db.select().from(automationRules).where(eq(automationRules.id, id)).all()[0];

  return new Response(
    JSON.stringify({
      ok: true,
      rule: serializeRule(updated),
      action,
      firedAt: now,
      notificationId,
    }),
    { headers: { "content-type": "application/json" } },
  );
}
