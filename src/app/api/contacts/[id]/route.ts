import { NextResponse } from "next/server";
import { logAppAction } from "@/lib/agent/action-log";
import { eq } from "drizzle-orm";
import { db, ensureDb } from "@/db";
import { contacts, type ContactInsert } from "@/db/schema";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const dynamic = "force-dynamic";
export const revalidate = 0;
export async function PATCH(request: Request, { params }: RouteParams) {
  ensureDb();
  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const patch: Partial<ContactInsert> = {};
  if (typeof body.label === "string" && body.label.trim()) patch.label = body.label.trim();
  if (typeof body.note === "string") patch.note = body.note;
  if (typeof body.favorite === "boolean") patch.favorite = body.favorite;
  // Explicit usage marker — payment/agent flows dispatch this when they send
  // to the contact. Favoriting is NOT usage (semantic fix, C9).
  if (body.used === true) patch.lastUsed = Date.now();

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No updatable fields." }, { status: 400 });
  }

  const existing = db.select().from(contacts).where(eq(contacts.id, id)).get();
  if (!existing) {
    return NextResponse.json({ error: "Contact not found." }, { status: 404 });
  }

  db.update(contacts).set(patch).where(eq(contacts.id, id)).run();
  const updated = db.select().from(contacts).where(eq(contacts.id, id)).get();
  logAppAction({
    tool: "contact_update",
    params: { label: updated?.label ?? existing.label, address: existing.address },
    status: "succeeded",
    summary: `Contact "${existing.label}" updated${patch.label ? ` (renamed to "${String(patch.label)}")` : ""} from the Contacts page.`,
  });
  return NextResponse.json({ contact: updated });
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  ensureDb();
  const { id } = await params;

  const existing = db.select().from(contacts).where(eq(contacts.id, id)).get();
  if (!existing) {
    return NextResponse.json({ error: "Contact not found." }, { status: 404 });
  }

  db.delete(contacts).where(eq(contacts.id, id)).run();
  logAppAction({
    tool: "contact_delete",
    params: { label: existing.label, address: existing.address },
    status: "succeeded",
    summary: `Contact "${existing.label}" deleted.`,
  });
  return NextResponse.json({ ok: true });
}
