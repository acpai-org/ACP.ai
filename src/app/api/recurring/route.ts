import { NextResponse } from "next/server";
import { logAppAction } from "@/lib/agent/action-log";
import { desc, eq } from "drizzle-orm";
import { db, ensureDb } from "@/db";
import { recurringSchedules } from "@/db/schema";
import { isKnownCadenceSpec } from "@/lib/recurring/cadence";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export async function GET(request: Request) {
  ensureDb();
  const url = new URL(request.url);
  const activeOnly = url.searchParams.get("active") === "true";

  let query = db.select().from(recurringSchedules).orderBy(desc(recurringSchedules.createdAt));
  if (activeOnly) {
    query = query.where(eq(recurringSchedules.active, true)) as typeof query;
  }
  const rows = query.all();
  return NextResponse.json({ schedules: rows });
}

export async function POST(request: Request) {
  ensureDb();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const required = ["id", "recipientAddress", "amountHuman", "amountBaseUnits", "cadence", "nextFireAt", "maxExecutions", "scheduleIdHash", "senderAddress"] as const;
  for (const field of required) {
    if (body[field] === undefined || body[field] === null) {
      return NextResponse.json({ error: `Missing field: ${field}` }, { status: 400 });
    }
  }

  // C37: cadence must be a recognized spec (preset, in-bounds custom, legacy
  // numeric) — garbage is rejected honestly, never silently treated as monthly.
  if (!isKnownCadenceSpec(body.cadence as string | number)) {
    return NextResponse.json(
      { error: "cadence must be a preset (daily/weekly/biweekly/monthly), a custom spec (every-<n>h 1–2160 / every-<n>d 1–365), or a legacy numeric day count." },
      { status: 400 },
    );
  }

  // Phase-2 executor: optional target chain (validated against the registry;
  // legacy callers omit it → the dispatched transfer makes the agent ask).
  let chainId: number | null = null;
  if (body.chainId !== undefined && body.chainId !== null) {
    const n = Number(body.chainId);
    if (!Number.isInteger(n) || n <= 0) {
      return NextResponse.json({ error: "chainId must be a positive integer." }, { status: 400 });
    }
    chainId = n;
  }

  const row = {
    id: body.id as string,
    recipientLabel: (body.recipientLabel as string) ?? null,
    recipientAddress: body.recipientAddress as string,
    token: (body.token as string) ?? "USDC",
    tokenAddress: (body.tokenAddress as string) ?? null,
    amountHuman: body.amountHuman as string,
    amountBaseUnits: body.amountBaseUnits as string,
    cadence: body.cadence as string,
    chainId,
    nextFireAt: body.nextFireAt as number,
    lastFireAt: null,
    executions: 0,
    maxExecutions: body.maxExecutions as number,
    active: true,
    lastStatus: null,
    scheduleIdHash: body.scheduleIdHash as string,
    senderAddress: body.senderAddress as string,
    createdAt: Date.now(),
    userId: (body.userId as string) ?? null,
  };

  db.insert(recurringSchedules).values(row).run();
  // P24: UI-created schedules land in the action log (agent-created ones log
  // via the loop's own machinery).
  logAppAction({
    tool: "recurring_create",
    params: { scheduleId: row.id, cadence: row.cadence, amount: row.amountHuman, token: row.token, chainId: row.chainId, recipient: row.recipientAddress },
    status: "succeeded",
    summary: `Recurring schedule created from the Recurring page: ${row.amountHuman} ${row.token} (${row.cadence}).`,
    chainId: row.chainId ?? null,
  });
  return NextResponse.json({ schedule: row }, { status: 201 });
}
