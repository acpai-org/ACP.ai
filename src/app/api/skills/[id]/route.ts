import { NextResponse } from "next/server";
import { logAppAction } from "@/lib/agent/action-log";
import { eq } from "drizzle-orm";
import { db, ensureDb } from "@/db";
import { skills } from "@/db/schema";
import { serializeSkill, validateAllowlist } from "@/lib/skills";

// ─────────────────────────────────────────────────────────────────────────────
// /api/skills/[id] — per-skill operations (N30).
//   GET    → the skill
//   PATCH  → { enabled } for ANY skill (toggling is the user's);
//            { name?, description?, instructions?, toolAllowlist? } for USER
//            skills only — builtin content is seed-managed and read-only.
//   DELETE → USER skills only (builtin deletion is refused).
// ─────────────────────────────────────────────────────────────────────────────

const MAX_NAME = 60;
const MAX_DESCRIPTION = 200;
const MAX_INSTRUCTIONS = 20_000;

interface Params {
  params: Promise<{ id: string }>;
}

function loadSkill(id: string) {
  return db.select().from(skills).where(eq(skills.id, id)).get();
}

export async function GET(_request: Request, { params }: Params) {
  ensureDb();
  const { id } = await params;
  const row = loadSkill(id);
  if (!row) return NextResponse.json({ error: "Skill not found." }, { status: 404 });
  return NextResponse.json({ skill: serializeSkill(row) });
}

export async function PATCH(request: Request, { params }: Params) {
  ensureDb();
  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const row = loadSkill(id);
  if (!row) return NextResponse.json({ error: "Skill not found." }, { status: 404 });

  const update: Partial<typeof skills.$inferInsert> = {};

  // enabled: valid for every skill — the toggle is user state, never seed state.
  if (typeof body.enabled === "boolean") {
    update.enabled = body.enabled;
  }

  // Content fields: user skills only. Builtins are seed-versioned (F9).
  const contentKeys = ["name", "description", "instructions", "toolAllowlist"] as const;
  const wantsContent = contentKeys.some((k) => body[k] !== undefined);
  if (wantsContent) {
    if (row.builtin) {
      return NextResponse.json(
        { error: "Built-in skills cannot be edited. Duplicate it into a custom skill instead." },
        { status: 403 },
      );
    }

    if (body.name !== undefined) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name.length < 2 || name.length > MAX_NAME) {
        return NextResponse.json({ error: `Name must be 2–${MAX_NAME} characters.` }, { status: 400 });
      }
      update.name = name;
    }
    if (body.description !== undefined) {
      const description = typeof body.description === "string" ? body.description.trim() : "";
      if (description.length < 4 || description.length > MAX_DESCRIPTION) {
        return NextResponse.json(
          { error: `Description must be 4–${MAX_DESCRIPTION} characters.` },
          { status: 400 },
        );
      }
      update.description = description;
    }
    if (body.instructions !== undefined) {
      const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
      if (instructions.length < 10 || instructions.length > MAX_INSTRUCTIONS) {
        return NextResponse.json(
          { error: `Instructions must be 10–${MAX_INSTRUCTIONS} characters.` },
          { status: 400 },
        );
      }
      update.instructions = instructions;
    }
    if (body.toolAllowlist !== undefined) {
      const result = validateAllowlist(body.toolAllowlist);
      if (!result.ok) {
        return NextResponse.json({ error: "Tool allowlist contains no known tools." }, { status: 400 });
      }
      update.toolAllowlist = result.allowlist ? JSON.stringify(result.allowlist) : null;
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  db.update(skills).set(update).where(eq(skills.id, id)).run();
  const updated = loadSkill(id);
  // P24: skill changes alter the agent's LIVE toolset — always logged.
  logAppAction({
    tool: "skill_update",
    params: { skillId: id, name: updated?.name ?? row.name, fields: Object.keys(update), builtin: row.builtin },
    status: "succeeded",
    summary: `Skill "${updated?.name ?? row.name}" ${update.enabled !== undefined ? (update.enabled ? "enabled" : "disabled") : "updated"}${update.toolAllowlist !== undefined ? " (tool allowlist changed — this reshapes the agent's available tools)" : ""}.`,
  });
  return NextResponse.json({ skill: updated ? serializeSkill(updated) : null });
}

export async function DELETE(_request: Request, { params }: Params) {
  ensureDb();
  const { id } = await params;
  const row = loadSkill(id);
  if (!row) return NextResponse.json({ error: "Skill not found." }, { status: 404 });
  if (row.builtin) {
    return NextResponse.json(
      { error: "Built-in skills cannot be deleted — disable them instead." },
      { status: 403 },
    );
  }
  db.delete(skills).where(eq(skills.id, id)).run();
  logAppAction({
    tool: "skill_delete",
    params: { skillId: id, name: row.name },
    status: "succeeded",
    summary: `Custom skill "${row.name}" deleted.`,
  });
  return NextResponse.json({ ok: true });
}
