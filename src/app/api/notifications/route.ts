import { NextResponse } from "next/server";
import { db, ensureDb } from "@/db/index";
import { notifications } from "@/db/schema";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export async function GET() {
  try {
    ensureDb();
    const rows = db
      .select()
      .from(notifications)
      .orderBy(desc(notifications.createdAt))
      .limit(100)
      .all();

    return NextResponse.json({ notifications: rows });
  } catch (err) {
    // D16 fix: log the detail server-side; the response carries a generic
    // message (raw Error.message can leak filesystem paths in stack traces).
    console.error("[api/notifications] failed:", err);
    return NextResponse.json({ error: "An internal error occurred." }, { status: 500 });
  }
}
