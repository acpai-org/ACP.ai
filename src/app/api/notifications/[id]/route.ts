import { NextResponse } from "next/server";
import { db, ensureDb } from "@/db/index";
import { notifications } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    ensureDb();
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { read?: boolean };
    const read = body.read !== undefined ? body.read : true;

    db.update(notifications)
      .set({ read })
      .where(eq(notifications.id, id))
      .run();

    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
