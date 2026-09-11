import { NextResponse } from "next/server";
import { db, ensureDb } from "@/db/index";
import { notifications } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/notifications/mark-all-read — with an optional { ids } body this
// becomes the R18 bulk-mark endpoint (the notifications page's selection mode);
// with no body (or an empty list) it keeps its original meaning: mark every
// unread row read. Idempotent either way — already-read ids are a no-op, and
// unknown ids simply match nothing.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const revalidate = 0;
export async function POST(req: Request) {
  try {
    ensureDb();

    // Optional body: { ids?: string[] }. Tolerate absent/invalid bodies —
    // the no-body caller (the header button) must keep working unchanged.
    let ids: string[] | null = null;
    try {
      const body = (await req.json()) as { ids?: unknown } | null;
      if (body && Array.isArray(body.ids)) {
        ids = body.ids
          .filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 128)
          .slice(0, 100);
        if (ids.length === 0) ids = null;
      }
    } catch {
      // no/invalid JSON body → full sweep (the original contract)
    }

    if (ids) {
      const result = db
        .update(notifications)
        .set({ read: true })
        .where(and(inArray(notifications.id, ids), eq(notifications.read, false)))
        .run();
      return NextResponse.json({ ok: true, updated: result.changes });
    }

    db.update(notifications).set({ read: true }).where(eq(notifications.read, false)).run();
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
