import { NextResponse } from "next/server";
import { logAppAction } from "@/lib/agent/action-log";
import { db, ensureDb } from "@/db";
import { skills } from "@/db/schema";
import { serializeSkill, validateAllowlist } from "@/lib/skills";

// ─────────────────────────────────────────────────────────────────────────────
// /api/skills — the skills library CRUD backing Settings → Agent skills
// (N30: these routes were missing entirely, so the settings section rendered
// nothing while the table sat seeded and unused).
//
// Contract (matches components/skill-library.tsx):
//   GET  → { skills: SerializedSkill[] }
//   POST → create a USER skill (builtin always false server-side) — 201
//
// A skill is prompt-level configuration over the CLOSED toolset (§12): the
// allowlist only ever contains names that exist in the tool registry, and
// validation rejects an all-bogus non-empty list instead of widening it to
// "all tools" (F6).
// ─────────────────────────────────────────────────────────────────────────────

const MAX_NAME = 60;
const MAX_DESCRIPTION = 200;
const MAX_INSTRUCTIONS = 20_000;

function asTrimmedString(v: unknown): string | null {
  return typeof v === "string" ? v.trim() : null;
}

export async function GET() {
  ensureDb();
  const rows = db.select().from(skills).all();
  // Builtins first, then user skills; stable alphabetical order within groups.
  rows.sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return NextResponse.json({ skills: rows.map(serializeSkill) });
}

export async function POST(request: Request) {
  ensureDb();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const name = asTrimmedString(body.name);
  const description = asTrimmedString(body.description);
  const instructions = asTrimmedString(body.instructions);

  if (!name || name.length < 2 || name.length > MAX_NAME) {
    return NextResponse.json({ error: `Name must be 2–${MAX_NAME} characters.` }, { status: 400 });
  }
  if (!description || description.length < 4 || description.length > MAX_DESCRIPTION) {
    return NextResponse.json(
      { error: `Description must be 4–${MAX_DESCRIPTION} characters.` },
      { status: 400 },
    );
  }
  if (!instructions || instructions.length < 10 || instructions.length > MAX_INSTRUCTIONS) {
    return NextResponse.json(
      { error: `Instructions must be 10–${MAX_INSTRUCTIONS} characters.` },
      { status: 400 },
    );
  }

  const allowlistResult = validateAllowlist(body.toolAllowlist);
  if (!allowlistResult.ok) {
    return NextResponse.json({ error: "Tool allowlist contains no known tools." }, { status: 400 });
  }

  // Duplicate name guard (the UI matches on trimmed lowercase name).
  const nameLower = name.toLowerCase();
  const clash = db
    .select()
    .from(skills)
    .all()
    .some((row) => row.name.trim().toLowerCase() === nameLower);
  if (clash) {
    return NextResponse.json({ error: "A skill with this name already exists." }, { status: 409 });
  }

  const icon = asTrimmedString(body.icon);
  const row = {
    id: crypto.randomUUID(),
    name,
    description,
    instructions,
    toolAllowlist: allowlistResult.allowlist ? JSON.stringify(allowlistResult.allowlist) : null,
    builtin: false,
    enabled: true, // N31: newly added skills default to enabled.
    icon: icon && icon.length > 0 && icon.length <= 30 ? icon : null,
    createdAt: Date.now(),
    seedHash: null, // user skills are never seed-managed (F9)
  };

  db.insert(skills).values(row).run();
  logAppAction({
    tool: "skill_create",
    params: { skillId: row.id, name: row.name, builtin: false },
    status: "succeeded",
    summary: `Custom skill "${row.name}" authored and saved from the Skills page.`,
  });
  return NextResponse.json({ skill: serializeSkill(row) }, { status: 201 });
}
