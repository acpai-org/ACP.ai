import { NextResponse } from "next/server";
import { logAppAction } from "@/lib/agent/action-log";
import { eq } from "drizzle-orm";
import { db, ensureDb } from "@/db";
import { payments, type PaymentInsert } from "@/db/schema";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const dynamic = "force-dynamic";
export const revalidate = 0;
export async function GET(_request: Request, { params }: RouteParams) {
  ensureDb();
  const { id } = await params;
  const row = db.select().from(payments).where(eq(payments.id, id)).get();
  if (!row) {
    return NextResponse.json({ error: "Payment not found." }, { status: 404 });
  }
  return NextResponse.json({ payment: row });
}

export async function PATCH(request: Request, { params }: RouteParams) {
  ensureDb();
  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const patch: Partial<PaymentInsert> = {};
  if (typeof body.status === "string") patch.status = body.status;
  if (typeof body.txHash === "string") patch.txHash = body.txHash;
  if (typeof body.chainId === "number") patch.chainId = body.chainId;
  if (typeof body.senderAddress === "string") patch.senderAddress = body.senderAddress;
  if (typeof body.tokenAddress === "string") patch.tokenAddress = body.tokenAddress;
  if (body.status === "settled" || body.status === "failed") {
    patch.settledAt = Date.now();
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No updatable fields." }, { status: 400 });
  }

  const existing = db.select().from(payments).where(eq(payments.id, id)).get();
  if (!existing) {
    return NextResponse.json({ error: "Payment not found." }, { status: 404 });
  }

  db.update(payments).set(patch).where(eq(payments.id, id)).run();
  const updated = db.select().from(payments).where(eq(payments.id, id)).get();
  // P24: the chat intent-card settlement is a REAL wallet transaction — it
  // must land in the action log with its tx hash like every fund action.
  if (body.status === "settled" && existing.status !== "settled") {
    logAppAction({
      tool: "payment_settle",
      params: { paymentId: id, amount: updated?.amountHuman ?? existing.amountHuman, token: updated?.token ?? existing.token, recipient: existing.recipientAddress },
      status: "succeeded",
      summary: `Payment settled via the chat intent card: ${updated?.amountHuman ?? existing.amountHuman} ${updated?.token ?? existing.token} to ${existing.recipientLabel || existing.recipientAddress}.`,
      riskClass: "funds",
      chainId: (typeof body.chainId === "number" ? body.chainId : existing.chainId) ?? null,
      txHash: (typeof body.txHash === "string" ? body.txHash : existing.txHash) ?? null,
    });
  } else if (body.status === "failed" && existing.status !== "failed") {
    logAppAction({
      tool: "payment_settle",
      params: { paymentId: id },
      status: "failed",
      summary: `Payment failed during settlement (intent card flow).`,
      riskClass: "funds",
      chainId: existing.chainId ?? null,
    });
  }
  return NextResponse.json({ payment: updated });
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  ensureDb();
  const { id } = await params;

  const existing = db.select().from(payments).where(eq(payments.id, id)).get();
  if (!existing) {
    return NextResponse.json({ error: "Payment not found." }, { status: 404 });
  }

  db.delete(payments).where(eq(payments.id, id)).run();
  return NextResponse.json({ ok: true, id });
}
