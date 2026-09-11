import { db, ensureDb } from "@/db";
import { logAppAction } from "@/lib/agent/action-log";
import { automationRules, payments } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  AUTOMATION_RULE_CAP,
  isTriggerType,
  serializeRule,
  validateAction,
  validateTriggerConfig,
} from "@/lib/automation/validate";

// ─────────────────────────────────────────────────────────────────────────────
// /api/automation — user automation rules (brief §8): "when X happens, do Y".
//
//   GET  → all rules, newest first (trigger/action JSON parsed for the client)
//   POST → create a rule (validated: trigger config + action config — a
//          "transfer" action must validate against the transfer tool schema
//          fields; a "notify" action needs a message). Cap: 20 rules.
//
// Execution is app-open (queue-and-run): the client poller
// (src/components/automation-poller.tsx) evaluates triggers while the app is
// visible and calls POST /api/automation/[id]/fire right before executing.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET() {
  ensureDb();
  const rows = db.select().from(automationRules).orderBy(desc(automationRules.createdAt)).all();
  const rules = rows.map(serializeRule).filter((r) => r !== null);
  return new Response(JSON.stringify({ rules }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function POST(req: Request) {
  ensureDb();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 2 || name.length > 60) {
    return new Response(JSON.stringify({ error: "Name must be 2-60 characters." }), { status: 400 });
  }

  if (!isTriggerType(body.triggerType)) {
    return new Response(
      JSON.stringify({ error: "triggerType must be one of balance_above | balance_below | attestation_ready | schedule." }),
      { status: 400 },
    );
  }
  const triggerType = body.triggerType;

  const trigger = validateTriggerConfig(triggerType, body.triggerConfig);
  if (!trigger.ok) {
    return new Response(JSON.stringify({ error: trigger.error }), { status: 400 });
  }

  // attestation triggers must point at a real payment row (otherwise they can
  // never fire — better to reject at authoring time).
  if (triggerType === "attestation_ready") {
    const payment = trigger.value as { paymentId: string };
    const exists = db.select().from(payments).where(eq(payments.id, payment.paymentId)).get();
    if (!exists) {
      return new Response(JSON.stringify({ error: "Payment not found for triggerConfig.paymentId." }), { status: 400 });
    }
  }

  const action = validateAction(body.actionJson);
  if (!action.ok) {
    return new Response(JSON.stringify({ error: action.error }), { status: 400 });
  }

  const count = db.select({ id: automationRules.id }).from(automationRules).all().length;
  if (count >= AUTOMATION_RULE_CAP) {
    return new Response(
      JSON.stringify({ error: `Automation rule limit reached (${AUTOMATION_RULE_CAP}). Delete a rule first.` }),
      { status: 400 },
    );
  }

  const id = randomUUID();
  db.insert(automationRules)
    .values({
      id,
      name,
      triggerType,
      triggerConfigJson: JSON.stringify(trigger.value),
      actionJson: JSON.stringify(action.value),
      active: true, // rules arm on creation — the queue-and-run contract
      createdAt: Date.now(),
    })
    .run();

  const row = db.select().from(automationRules).where(eq(automationRules.id, id)).all()[0];
  logAppAction({
    tool: "automation_create",
    params: { ruleId: id, name, triggerType, trigger: trigger.value, action: action.value },
    status: "succeeded",
    summary: `Automation rule "${name}" created and armed from the Settings page (${triggerType} trigger).`,
  });
  return new Response(JSON.stringify({ rule: serializeRule(row) }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
}
