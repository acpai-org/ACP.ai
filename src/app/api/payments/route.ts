import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db, ensureDb } from "@/db";
import { payments, type PaymentInsert } from "@/db/schema";
import { validateCreatePayment } from "@/lib/payment";
import { submissionAvailability } from "@/lib/attestcoin/submit";
import { getPollerStats } from "@/lib/attestcoin/poller";

export const dynamic = "force-dynamic";
export const revalidate = 0;
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

  // AC5 — optional settlement fields on CREATE.
  // WHY: agent-executed transfers (use-agent-run.ts dispatchTool → execTransfer)
  // already hold their tx hash + receipt the moment they can create a payment
  // row; forcing them through create-then-PATCH meant two round-trips, a
  // window where the Attestcoin poller could see a pending row with no tx, and
  // a duplicate "payment_settle" action-log entry (the agent loop already logs
  // the tool execution in agent_actions). One POST that births the row settled
  // closes root cause #4 cleanly. Validation mirrors the PATCH route's D15
  // whitelist so no arbitrary status string can reach the column.
  const data: PaymentInsert = { ...result.data };
  const ALLOWED_STATUSES = ["pending", "signing", "settling", "settled", "failed"] as const;
  const bodyStatus = typeof body.status === "string" ? body.status : undefined;
  if (bodyStatus !== undefined) {
    if (!(ALLOWED_STATUSES as readonly string[]).includes(bodyStatus)) {
      return NextResponse.json(
        { error: `status must be one of: ${ALLOWED_STATUSES.join(", ")}` },
        { status: 400 },
      );
    }
    if (bodyStatus === "settled" && typeof body.txHash !== "string") {
      return NextResponse.json({ error: "settled requires a txHash." }, { status: 400 });
    }
    data.status = bodyStatus;
  }
  if (typeof body.txHash === "string") {
    data.txHash = body.txHash;
  }
  if (data.status === "settled") {
    // D15 mirror: settledAt stamps a real settlement only — and only a
    // caller-supplied positive epoch ms overrides "now".
    data.settledAt =
      typeof body.settledAt === "number" && Number.isFinite(body.settledAt) && body.settledAt > 0
        ? body.settledAt
        : Date.now();
  }

  db.insert(payments).values(data).run();
  return NextResponse.json({ payment: data }, { status: 201 });
}
