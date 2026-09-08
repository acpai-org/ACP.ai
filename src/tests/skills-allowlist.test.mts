// ─────────────────────────────────────────────────────────────────────────────
// C35 skill-allowlist unit tests (D.6 audit F1/F2/F6). Pure logic — the F1
// union semantics are exercised through the same parse/union core the loop
// uses (exported for testability); F6 through validateAllowlist/serializeSkill.
// ─────────────────────────────────────────────────────────────────────────────

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { validateAllowlist, sanitizeAllowlist, serializeSkill } = await import("@/lib/skills");
const { TOOL_REGISTRY, TOOL_NAMES } = await import("@/lib/agent/tool-registry");

// Two real tools from the fixed registry (whatever they are on this build).
const REAL_A = TOOL_NAMES[0];
const REAL_B = TOOL_NAMES[1] ?? TOOL_NAMES[0];

describe("C35/F6 — validateAllowlist (bogus-only no longer widens)", () => {
  test("null / undefined / non-array → all tools (ok, null)", () => {
    for (const input of [null, undefined, "nope", 42]) {
      const r = validateAllowlist(input);
      assert.equal(r.ok, true);
      assert.equal(r.allowlist, null);
    }
  });

  test("empty array → all tools (§12 'no restriction')", () => {
    const r = validateAllowlist([]);
    assert.equal(r.ok, true);
    assert.equal(r.allowlist, null);
  });

  test("known tools survive; unknown entries are dropped", () => {
    const r = validateAllowlist([REAL_A, "fake_tool_name"]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.allowlist, [REAL_A]);
  });

  test("BOGUS-ONLY input is invalid — not a silent all-tools grant", () => {
    const r = validateAllowlist(["fake_tool_a", "fake_tool_b"]);
    assert.equal(r.ok, false);
    assert.equal(r.error, "bogus_only");
    assert.ok(r.unknown.length === 2);
  });

  test("sanitizeAllowlist (legacy shim) stays null-safe on bogus-only", () => {
    // The shim is for internal non-API callers: bogus-only maps to null there
    // (callers must prefer validateAllowlist at API boundaries).
    assert.equal(sanitizeAllowlist(["fake_tool_a"]), null);
    assert.deepEqual(sanitizeAllowlist([REAL_A]), [REAL_A]);
  });
});

describe("C35/F6 — serializeSkill (stored bogus-only does not widen)", () => {
  const baseRow = {
    id: "skill-x",
    name: "X",
    description: "desc",
    instructions: "instructions",
    builtin: false,
    enabled: true,
    icon: null,
    createdAt: 1,
  } as const;

  test("null stored → null (all tools)", () => {
    const s = serializeSkill({ ...baseRow, toolAllowlist: null } as never);
    assert.equal(s.toolAllowlist, null);
  });

  test("bogus-only stored → EMPTY RESTRICTION, not all tools", () => {
    const s = serializeSkill({
      ...baseRow,
      toolAllowlist: JSON.stringify(["ghost_tool"]),
    } as never);
    assert.deepEqual(s.toolAllowlist, []);
  });

  test("valid stored list filters normally", () => {
    const s = serializeSkill({
      ...baseRow,
      toolAllowlist: JSON.stringify([REAL_A, REAL_B]),
    } as never);
    assert.deepEqual(s.toolAllowlist?.sort(), [REAL_A, REAL_B].sort());
  });
});

// ── F1 core: the union semantics (mirror of the loop's parse+union) ──────────

function unionCore(
  active: { toolAllowlist: string | null }[],
): Set<string> | null {
  const lists = active.map((s) => {
    try {
      const parsed = s.toolAllowlist ? (JSON.parse(s.toolAllowlist) as string[]) : null;
      return Array.isArray(parsed) ? parsed.filter((n) => n in TOOL_REGISTRY) : null;
    } catch {
      return null;
    }
  });
  // F1: ANY null (all-tools) grant widens the union to everything.
  if (lists.some((l) => l === null)) return null;
  const union = new Set<string>();
  for (const l of lists) {
    if (l) for (const n of l) union.add(n);
  }
  return union.size > 0 ? union : null;
}

describe("C35/F1 — skill allowlist union semantics", () => {
  test("no active skills → null (all tools)", () => {
    assert.equal(unionCore([]), null);
  });

  test("one concrete allowlist → that set", () => {
    const u = unionCore([{ toolAllowlist: JSON.stringify([REAL_A]) }]);
    assert.ok(u);
    assert.deepEqual([...u], [REAL_A]);
  });

  test("two concrete allowlists union", () => {
    const u = unionCore([
      { toolAllowlist: JSON.stringify([REAL_A]) },
      { toolAllowlist: JSON.stringify([REAL_B]) },
    ]);
    assert.ok(u);
    assert.deepEqual([...u].sort(), [REAL_A, REAL_B].sort());
  });

  test("ANY null-grant skill widens the union to ALL tools (the F1 bug)", () => {
    // Previously the null was dropped BEFORE unioning → {REAL_A} (narrower
    // than the member's grant). The union with the universe is the universe.
    const u = unionCore([
      { toolAllowlist: JSON.stringify([REAL_A]) },
      { toolAllowlist: null },
    ]);
    assert.equal(u, null);
  });

  test("all-null skills → all tools", () => {
    const u = unionCore([{ toolAllowlist: null }, { toolAllowlist: null }]);
    assert.equal(u, null);
  });
});
