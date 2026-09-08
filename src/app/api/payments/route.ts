import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db, ensureDb } from "@/db";
import { payments } from "@/db/schema";
import { validateCreatePayment } from "@/lib/payment";
import { submissionAvailability } from "@/lib/attestcoin/submit";
import { getPollerStats } from "@/lib/attestcoin/poller";

export async function GET() {
  ensureDb();
  const rows = db.select().from(payments).orderBy(desc(payments.createdAt)).all();
  // Submission availability (env-only check, no network) so the payments UI
  // can offer batch/single submission affordances without an extra round-trip.
  // Poller liveness (in-memory stats + one cheap count) so the page can show
  // "watching N payments" without hitting the chain.
  return NextResponse.json({
    payments: rows,
    submission: submissionAvailability(),
    poller: getPollerStats(),
  });
}

export async function POST(request: Request) {
  ensureDb();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const result = validateCreatePayment({
    recipientAddress: body.recipientAddress as string | undefined,
    recipientLabel: body.recipientLabel as string | null | undefined,
    token: body.token as string | undefined,
    tokenAddress: body.tokenAddress as string | null | undefined,
    amountHuman: body.amountHuman as string | undefined,
    memo: body.memo as string | null | undefined,
    chainId: body.chainId as number | undefined,
    senderAddress: body.senderAddress as string | null | undefined,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  db.insert(payments).values(result.data).run();
  return NextResponse.json({ payment: result.data }, { status: 201 });
}
