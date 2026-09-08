// ─────────────────────────────────────────────────────────────────────────────
// C35/F9 seed-versioning tests (D.6 audit). The builtin skill library must be
// REFRESHABLE: a fix to a builtin's content (instructions/allowlist/icon)
// lands on databases that already have the row, while `enabled` (user state)
// and user-authored skills are never touched.
//
// DB isolation: ACP_DB_PATH pointed at a temp dir BEFORE the first @/db
// import (same pattern as agent-loop tests). App "restarts" are simulated by
// __resetDbInitForTests() + ensureDb() against the same connection.
// ─────────────────────────────────────────────────────────────────────────────

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.ACP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "acp-skills-seed-test-")), "test.db");

// ensureDb is exercised through the real module so the seeding path is
// exactly what production runs.
const { ensureDb, __resetDbInitForTests } = await import("@/db");
const { TOOL_REGISTRY } = await import("@/lib/agent/tool-registry");
const { getRawSkill, setLegacySkill, countSkills } = await import("./seed-test-helpers.mjs");

function restart(): void {
  __resetDbInitForTests();
  ensureDb();
}

const BUILTIN_IDS = [
  "skill-exact-payer",
  "skill-attestcoin-operator",
  "skill-thrifty",
  "skill-balance-digest",
  "skill-network-reporter",
  "skill-testnet-guardian",
  "skill-token-discipline",
  "skill-action-narrator",
  "skill-attestation-sentinel",
  "skill-payroll-dispatcher",
  "skill-subscription-manager",
];

before(() => {
  ensureDb(); // fresh DB — first boot
});

describe("C35/F9 — fresh seed", () => {
  test("all wave-2 builtins are present and enabled by default (N31)", () => {
    for (const id of BUILTIN_IDS) {
      const row = getRawSkill(id);
      assert.ok(row, `missing builtin ${id}`);
      assert.equal(row!.builtin, 1, `${id} should be builtin`);
      assert.equal(row!.enabled, 1, `${id} must seed ENABLED (N31 all-on default)`);
      assert.ok(row!.seed_hash, `${id} must carry a seed hash`);
    }
    assert.equal(countSkills(), BUILTIN_IDS.length, "no extra rows on a fresh DB");
  });

  test("F3: exact-payer's allowlist includes list_contacts (instructions say to use it)", () => {
    const row = getRawSkill("skill-exact-payer")!;
    const allow = JSON.parse(row.tool_allowlist ?? "[]") as string[];
    assert.ok(allow.includes("list_contacts"), `allowlist ${JSON.stringify(allow)} must include list_contacts`);
    assert.ok(allow.includes("transfer"));
  });

  test("wave-2 allowlists only reference known registry tools (§12)", () => {
    for (const id of [
      "skill-balance-digest",
      "skill-network-reporter",
      "skill-testnet-guardian",
      "skill-token-discipline",
      "skill-action-narrator",
      "skill-attestation-sentinel",
      "skill-payroll-dispatcher",
      "skill-subscription-manager",
    ]) {
      const row = getRawSkill(id);
      assert.ok(row, `missing ${id}`);
      const allow = JSON.parse(row!.tool_allowlist ?? "[]") as string[];
      assert.ok(allow.length > 0, `${id} should carry a non-empty allowlist`);
      for (const tool of allow) {
        assert.ok(tool in TOOL_REGISTRY, `${id} references unknown tool ${tool}`);
      }
    }
  });
});

describe("C35/F9 — versioned refresh", () => {
  test("LEGACY row (hash NULL, old allowlist, enabled=1) gets content refreshed but stays enabled", () => {
    // Simulate a database seeded by the OLD code: 3-tool allowlist, no
    // seed_hash, and the user has the skill switched ON.
    setLegacySkill("skill-exact-payer", {
      tool_allowlist: JSON.stringify(["transfer", "get_balances", "batch_transfer"]),
      seed_hash: null,
      enabled: 1,
    });
    restart(); // "app restart" → ensureDb runs the versioned seed again

    const row = getRawSkill("skill-exact-payer")!;
    const allow = JSON.parse(row.tool_allowlist ?? "[]") as string[];
    assert.ok(allow.includes("list_contacts"), "F3 fix must land on legacy rows");
    assert.ok(row.seed_hash, "seed hash must be backfilled");
    assert.equal(row.enabled, 1, "user's activation state must NEVER be reset by a refresh");
  });

  test("idempotent: a second restart with matching hashes changes nothing", () => {
    const before = getRawSkill("skill-exact-payer")!;
    restart();
    const after = getRawSkill("skill-exact-payer")!;
    assert.equal(after.seed_hash, before.seed_hash);
    assert.equal(after.enabled, before.enabled);
    assert.equal(after.created_at, before.created_at, "created_at must not churn on no-op restarts");
  });

  test("USER skills are untouchable (builtin flag = 0)", () => {
    // Tamper a builtin row into "user-owned" state: not builtin, custom
    // content, no hash. A refresh must leave it exactly as-is.
    setLegacySkill("skill-thrifty", {
      description: "my personal router variant",
      instructions: "do things my way",
      builtin: 0,
      seed_hash: null,
      enabled: 1,
    });
    restart();
    const row = getRawSkill("skill-thrifty")!;
    assert.equal(row.description, "my personal router variant", "user content must not be clobbered");
    assert.equal(row.instructions, "do things my way");
    assert.equal(row.enabled, 1);
    assert.equal(row.seed_hash, null, "user skills never get a seed hash");
  });

  test("disabling survives a content refresh (the F9 core contract)", () => {
    // enabled=0 + stale hash → refresh content, keep disabled.
    setLegacySkill("skill-attestcoin-operator", {
      description: "stale description from an old version",
      seed_hash: "0".repeat(64),
      enabled: 0,
    });
    restart();
    const row = getRawSkill("skill-attestcoin-operator")!;
    assert.notEqual(row.description, "stale description from an old version", "stale content must refresh");
    assert.equal(row.enabled, 0, "stays disabled — refresh never re-activates");
  });
});
