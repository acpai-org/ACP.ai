import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db, ensureDb } from "@/db";
import { contacts } from "@/db/schema";
import { isAddress } from "viem";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/contacts/used  { address }
//
// Marks a saved contact as used (lastUsed = now). Called by the transfer
// executors when a confirmed send lands on a saved recipient — "last used"
// means a real payment, not a favorite toggle or a creation.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const revalidate = 0;
export async function POST(request: Request) {
  ensureDb();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const address = typeof body.address === "string" ? body.address.trim() : "";
  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: "A valid 0x address is required." }, { status: 400 });
  }

  // D14 fix: contacts may be stored checksummed while executors hand back
  // lowercase (or vice versa) — compare case-insensitively so the lastUsed
  // bump actually fires and "sort by recent use" keeps working.
  const existing = db
    .select()
    .from(contacts)
    .where(sql`lower(${contacts.address}) = ${address.toLowerCase()}`)
    .get();
  if (!existing) {
    // Not a saved contact — not an error; callers fire-and-forget.
    return NextResponse.json({ updated: false });
  }

  db.update(contacts).set({ lastUsed: Date.now() }).where(eq(contacts.id, existing.id)).run();
  return NextResponse.json({ updated: true });
}
