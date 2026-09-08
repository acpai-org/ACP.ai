import { db, ensureDb } from "@/db";
import { logAppAction } from "@/lib/agent/action-log";
import { automationRules, payments } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  isTriggerType,
  serializeRule,
  validateAction,
  validateTriggerConfig,
} from "@/lib/automation/validate";

// ─────────────────────────────────────────────────────────────────────────────
// /api/automation/[id] — update (arm/disarm, edit) and delete.
//   PATCH  { active?, name?, triggerType?, triggerConfig?, actionJson?,
//            lastStatus?, resetLastFired? }
//     — trigger configs are re-validated when triggerType/triggerConfig change;
//       actionJson is re-validated when provided.
//     — resetLastFired clears lastFiredAt (the poller uses this to re-queue a
//       transfer rule whose agent run was busy: "leave rule eligible, retry
//       next tick").
//   DELETE — remove the rule.
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: Request, { params }: RouteParams) {
  ensureDb();
  const { id } = await params;

  const row = db.select().from(automationRules).where(eq(automationRules.id, id)).all()[0];
  if (!row) return new Response(JSON.stringify({ error: "Rule not found" }), { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
  }

  const set: Record<string, unknown> = {};

  if (typeof body.active === "boolean") set.active = body.active;

  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (name.length < 2 || name.length > 60) {
      return new Response(JSON.stringify({ error: "Name must be 2-60 characters." }), { status: 400 });
    }
    set.name = name;
  }

  // Trigger edit: validate the (possibly new) type against the (possibly new)
  // config — fall back to the stored values for whichever half is absent.
  if (body.triggerType !== undefined || body.triggerConfig !== undefined) {
    const nextTypeRaw = body.triggerType ?? row.triggerType;
    if (!isTriggerType(nextTypeRaw)) {
      return new Response(
        JSON.stringify({ error: "triggerType must be one of balance_above | balance_below | attestation_ready | schedule." }),
        { status: 400 },
      );
    }
    const nextTriggerRaw =
      body.triggerConfig !== undefined ? body.triggerConfig : JSON.parse(row.triggerConfigJson);
    const trigger = validateTriggerConfig(nextTypeRaw, nextTriggerRaw);
    if (!trigger.ok) {
      return new Response(JSON.stringify({ error: trigger.error }), { status: 400 });
    }
    if (nextTypeRaw === "attestation_ready") {
      const payment = trigger.value as { paymentId: string };
      const exists = db.select().from(payments).where(eq(payments.id, payment.paymentId)).get();
      if (!exists) {
        return new Response(JSON.stringify({ error: "Payment not found for triggerConfig.paymentId." }), { status: 400 });
      }
    }
    set.triggerType = nextTypeRaw;
    set.triggerConfigJson = JSON.stringify(trigger.value);
    // A changed trigger re-arms the rule from scratch.
    set.lastFiredAt = null;
    set.lastStatus = null;
  }

  if (body.actionJson !== undefined) {
    const action = validateAction(body.actionJson);
    if (!action.ok) {
      return new Response(JSON.stringify({ error: action.error }), { status: 400 });
    }
    set.actionJson = JSON.stringify(action.value);
  }

  if (typeof body.lastStatus === "string") set.lastStatus = body.lastStatus.slice(0, 40);
  if (body.resetLastFired === true) set.lastFiredAt = null;

  if (Object.keys(set).length === 0) {
    return new Response(JSON.stringify({ error: "Nothing to update" }), { status: 400 });
  }

  db.update(automationRules).set(set).where(eq(automationRules.id, id)).run();
  const updated = db.select().from(automationRules).where(eq(automationRules.id, id)).all()[0];
  logAppAction({
    tool: "automation_update",
    params: { ruleId: id, fields: Object.keys(set) },
    status: "succeeded",
    summary: `Automation rule "${updated?.name ?? row.name}" updated from the Settings page${set.active !== undefined ? ` (${set.active ? "armed" : "disarmed"})` : ""}.`,
  });
  return new Response(JSON.stringify({ ok: true, rule: serializeRule(updated) }), {
    headers: { "content-type": "application/json" },
  });
}

export async function DELETE(_req: Request, { params }: RouteParams) {
  ensureDb();
  const { id } = await params;

  const row = db.select().from(automationRules).where(eq(automationRules.id, id)).all()[0];
  if (!row) return new Response(JSON.stringify({ error: "Rule not found" }), { status: 404 });

  db.delete(automationRules).where(eq(automationRules.id, id)).run();
  logAppAction({
    tool: "automation_delete",
    params: { ruleId: id, name: row.name },
    status: "succeeded",
    summary: `Automation rule "${row.name}" deleted permanently.`,
  });
  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
}
