import { NextResponse } from "next/server";
import { db, ensureDb } from "@/db/index";
import { notifications } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const revalidate = 0;
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
    // D16 fix: log the detail server-side; the response carries a generic
    // message (raw Error.message can leak filesystem paths in stack traces).
    console.error("[api/notifications] failed:", err);
    return NextResponse.json({ error: "An internal error occurred." }, { status: 500 });
  }
}
