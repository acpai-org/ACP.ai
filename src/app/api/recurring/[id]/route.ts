import { NextResponse } from "next/server";
import { logAppAction } from "@/lib/agent/action-log";
import { eq } from "drizzle-orm";
import { db, ensureDb } from "@/db";
import { recurringSchedules } from "@/db/schema";
import { requeueRecurringSchedule } from "@/lib/recurring/fire";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDb();
  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Requeue: restore pre-fire state after a busy-run race (executions/
  // nextFireAt/active + lastFireAt=null so the next tick retries cleanly).
  if (body.requeue === true) {
    const executions = typeof body.executions === "number" ? body.executions : undefined;
    const nextFireAt = typeof body.nextFireAt === "number" ? body.nextFireAt : undefined;
    const active = typeof body.active === "boolean" ? body.active : undefined;
    if (executions == null || nextFireAt == null || active == null) {
      return NextResponse.json({ error: "requeue requires executions, nextFireAt and active." }, { status: 400 });
    }
    const ok = requeueRecurringSchedule(id, { executions, nextFireAt, active });
    if (!ok) return NextResponse.json({ error: "Schedule not found." }, { status: 404 });
    const row = db.select().from(recurringSchedules).where(eq(recurringSchedules.id, id)).get();
    return NextResponse.json({ schedule: row });
  }

  const updates: Record<string, unknown> = {};
  if (body.active !== undefined) updates.active = body.active ? 1 : 0;
  // Numeric fields are type-checked (SQLite is dynamically typed — writing a
  // string into next_fire_at would silently corrupt the fire arithmetic).
  if (body.executions !== undefined) {
    if (typeof body.executions !== "number" || !Number.isInteger(body.executions) || body.executions < 0) {
      return NextResponse.json({ error: "executions must be a non-negative integer." }, { status: 400 });
    }
    updates.executions = body.executions;
  }
  if (body.lastFireAt !== undefined) {
    if (body.lastFireAt !== null && (typeof body.lastFireAt !== "number" || !Number.isFinite(body.lastFireAt))) {
      return NextResponse.json({ error: "lastFireAt must be a number or null." }, { status: 400 });
    }
    updates.lastFireAt = body.lastFireAt;
  }
  if (body.nextFireAt !== undefined) {
    if (typeof body.nextFireAt !== "number" || !Number.isFinite(body.nextFireAt) || body.nextFireAt <= 0) {
      return NextResponse.json({ error: "nextFireAt must be a positive number." }, { status: 400 });
    }
    updates.nextFireAt = body.nextFireAt;
  }
  if (body.lastStatus !== undefined && (typeof body.lastStatus === "string" || body.lastStatus === null)) {
    updates.lastStatus = body.lastStatus === null ? null : body.lastStatus.slice(0, 40);
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No fields to update." }, { status: 400 });
  }

  db.update(recurringSchedules).set(updates).where(eq(recurringSchedules.id, id)).run();
  const row = db.select().from(recurringSchedules).where(eq(recurringSchedules.id, id)).get();
  if (body.active !== undefined) {
    logAppAction({
      tool: "recurring_update",
      params: { scheduleId: id, active: body.active },
      status: "succeeded",
      summary: `Recurring schedule ${body.active ? "resumed" : "paused"} from the Recurring page (${row?.amountHuman ?? "?"} ${row?.token ?? "?"}, ${row?.cadence ?? "?"}).`,
      chainId: row?.chainId ?? null,
    });
  }
  return NextResponse.json({ schedule: row });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDb();
  const { id } = await params;
  // P17.3: DELETE actually DELETES the schedule row (the old implementation
  // only set active:false — the "delete button doesn't delete" bug). Pause is
  // a separate, clearly-labeled control (PATCH active:false) — never aliased
  // to delete.
  const deleted = db.delete(recurringSchedules).where(eq(recurringSchedules.id, id)).run();
  if (deleted.changes === 0) {
    return NextResponse.json({ error: "Schedule not found." }, { status: 404 });
  }
  logAppAction({
    tool: "recurring_delete",
    params: { scheduleId: id },
    status: "succeeded",
    summary: `Recurring schedule deleted permanently from the Recurring page.`,
  });
  return NextResponse.json({ ok: true, deleted: id });
}
