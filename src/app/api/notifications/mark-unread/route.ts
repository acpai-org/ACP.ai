import { NextResponse } from "next/server";
import { db, ensureDb } from "@/db/index";
import { notifications } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/notifications/mark-unread — the R19 companion to mark-all-read.
//
// Body: { ids: string[] } (REQUIRED — no-body makes no sense here: "mark
// EVERYTHING unread" would silently re-light the global badge for rows the
// user deliberately read; this endpoint is bulk-SELECT only). Marks the listed
// READ rows unread (the WHERE read=true guard keeps it idempotent and keeps
// unread rows' timestamps/states untouched). Unknown ids match nothing.
//
// Mirrors mark-all-read's validation contract: ids are strings of length
// 1..128, capped at 100 entries.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const revalidate = 0;
export async function POST(req: Request) {
  try {
    ensureDb();

    let ids: string[] = [];
    try {
      const body = (await req.json()) as { ids?: unknown } | null;
      if (body && Array.isArray(body.ids)) {
        ids = body.ids.filter(
          (v): v is string => typeof v === "string" && v.length > 0 && v.length <= 128,
        );
      }
    } catch {
      // invalid/absent JSON → empty list → 400 below
    }

    if (ids.length === 0) {
      return NextResponse.json(
        { error: "ids: non-empty array required" },
        { status: 400 },
      );
    }

    const result = db
      .update(notifications)
      .set({ read: false })
      .where(and(inArray(notifications.id, ids.slice(0, 100)), eq(notifications.read, true)))
      .run();
    return NextResponse.json({ ok: true, updated: result.changes });
  } catch (err) {
    // D16 fix: log the detail server-side; the response carries a generic
    // message (raw Error.message can leak filesystem paths in stack traces).
    console.error("[api/notifications] failed:", err);
    return NextResponse.json({ error: "An internal error occurred." }, { status: 500 });
  }
}
