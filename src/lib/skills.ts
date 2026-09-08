import type { skills } from "@/db/schema";
import { isKnownTool } from "@/lib/agent/tool-registry";

// ─────────────────────────────────────────────────────────────────────────────
// Shared skill serialization + validation (brief §7 / §12). Used by
// /api/skills and /api/skills/[id].
// ─────────────────────────────────────────────────────────────────────────────

export interface SerializedSkill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  toolAllowlist: string[] | null;
  builtin: boolean;
  enabled: boolean;
  icon: string | null;
  createdAt: number;
}

/** Serialize a skills row for the client (toolAllowlist JSON → array, §12-filtered). */
export function serializeSkill(row: typeof skills.$inferSelect): SerializedSkill {
  let allowlist: string[] | null = null;
  try {
    const parsed = row.toolAllowlist ? (JSON.parse(row.toolAllowlist) as unknown) : null;
    if (Array.isArray(parsed)) {
      allowlist = parsed.filter((n): n is string => typeof n === "string" && isKnownTool(n));
      // F6 (D.6 audit): a stored list that filters to NOTHING must NOT
      // serialize as null (= all tools). Honest representation: an empty
      // restriction (the skill's tools went away, e.g. a tool was removed
      // from the registry) — the UI shows the restriction, not a silent
      // grant of the whole toolset.
      if (parsed.length > 0 && allowlist.length === 0) allowlist = [];
      if (parsed.length === 0) allowlist = null;
    }
  } catch {
    allowlist = null;
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    toolAllowlist: allowlist,
    builtin: row.builtin,
    enabled: row.enabled,
    icon: row.icon,
    createdAt: row.createdAt,
  };
}

/**
 * §12 boundary: keep only known tool names; null/absent → null (all tools).
 *
 * F6 (D.6 audit): a NON-EMPTY array whose entries are all unknown tool names
 * is INVALID, not "all tools" — silently widening a bogus-only input would
 * grant the whole toolset to a restriction the user thought they were
 * setting. Empty array [] stays a legitimate "no restriction" per §12.
 */
export type AllowlistValidation =
  | { ok: true; allowlist: string[] | null }
  | { ok: false; error: "bogus_only"; unknown: string[] };

export function validateAllowlist(input: unknown): AllowlistValidation {
  if (input === null || input === undefined) return { ok: true, allowlist: null };
  if (!Array.isArray(input)) return { ok: true, allowlist: null };
  const known = input.filter((n): n is string => typeof n === "string" && isKnownTool(n));
  const unknown = input.filter(
    (n): n is string => typeof n === "string" && !isKnownTool(n) && /^[a-z_][a-z0-9_]*$/i.test(n),
  );
  if (known.length === 0 && input.length > 0) {
    // Every entry was dropped — non-empty input that filters to nothing.
    return { ok: false, error: "bogus_only", unknown };
  }
  return { ok: true, allowlist: known.length > 0 ? known : null };
}

/** Legacy shape — prefer validateAllowlist (F6). Null-safe for internal use. */
export function sanitizeAllowlist(input: unknown): string[] | null {
  const result = validateAllowlist(input);
  return result.ok ? result.allowlist : null;
}
