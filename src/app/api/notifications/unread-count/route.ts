import { NextResponse } from "next/server";
import { db, ensureDb } from "@/db/index";
import { notifications } from "@/db/schema";
import { count, eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/notifications/unread-count — the lightweight badge feed.
//
// The R17 unread badge (drawer pill + tabbar dot) polls this instead of the
// full list: a single indexed count, no row serialization, no 100-row payload.
// The notifications page itself keeps using the full GET /api/notifications
// (it needs the rows) and pushes reconciled counts into the badge store.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const revalidate = 0;
export async function GET() {
  try {
    ensureDb();
    const result = db
      .select({ value: count() })
      .from(notifications)
      .where(eq(notifications.read, false))
      .get();
    return NextResponse.json({ count: result?.value ?? 0 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
