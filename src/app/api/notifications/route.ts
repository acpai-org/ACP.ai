import { NextResponse } from "next/server";
import { db, ensureDb } from "@/db/index";
import { notifications } from "@/db/schema";
import { desc } from "drizzle-orm";

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
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
