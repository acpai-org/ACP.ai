// ─────────────────────────────────────────────────────────────────────────────
// AC8 — agent-action attestation tracking (Task 6): unit tests for the pure
// eligibility helpers the generalized poller uses, plus a hermetic DB smoke
// test for the new agent_actions attestation columns and watcher counts.
//
// Scope policy (attestcoin-gaps.test.mts style): PURE logic only — the
// network paths (getTxProof / verifyProofOnChain) are deliberately untested
// here; the live pipeline has its own network-resilient suite.
//
// DB isolation: ACP_DB_PATH points at a throwaway temp file BEFORE the first
// @/… import (poller.ts pulls in @/db at module scope — same pattern as
// fund-safety.test.mts). A PRE-AC8 agent_actions table is forged BEFORE
// ensureDb() runs, so the ALTER TABLE migration path (the genuinely new code)
// is what gets exercised, not just the fresh CREATE TABLE path.
// ─────────────────────────────────────────────────────────────────────────────

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";

const DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "acp-actions-poller-test-")), "test.db");
process.env.ACP_DB_PATH = DB_PATH;

// Forge the legacy (post-C3, pre-AC8) agent_actions shape — everything the
// schema had BEFORE the attestation columns existed.
{
  const legacy = new DatabaseSync(DB_PATH);
  legacy.exec(`
    CREATE TABLE agent_actions (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      call_id TEXT,
      tool TEXT NOT NULL,
      params_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      chain_id INTEGER,
      usd_value_cents INTEGER,
      risk_class TEXT NOT NULL DEFAULT 'read',
      confirmation_required INTEGER NOT NULL DEFAULT 0,
      result_json TEXT,
      source_tx_hash TEXT,
      cc3_tx_hash TEXT,
      attest_root TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    )
  `);
  legacy.close();
}

const { actionSourceTxHash, isAttestableAction, CREDITCOIN_DESTINATION_EVM_IDS, getPollerStats } =
  await import("@/lib/attestcoin/poller");
const { ensureDb, db } = await import("@/db");
const { agentActions, payments } = await import("@/db/schema");
type ActionEligibility = import("@/lib/attestcoin/poller").ActionAttestEligibility;

// Testnet static fallback ids (SOURCE_CHAINS with the live map empty — the
// test process never refreshes the ChainInfo precompile).
const SEPOLIA = 11155111;
const ETHEREUM = 1;
const TRACKED = [SEPOLIA, ETHEREUM];
const TX_A = `0x${"aa".repeat(32)}`;
const TX_B = `0x${"bb".repeat(32)}`;
const TX_C = `0x${"cc".repeat(32)}`;

/** Eligibility fixture with transfer-like defaults. */
function actionRow(overrides: Partial<ActionEligibility> = {}): ActionEligibility {
  return {
    status: "succeeded",
    chainId: SEPOLIA,
    sourceTxHash: null,
    resultJson: JSON.stringify({ ok: true, summary: "confirmed", txHash: TX_A }),
    attestedAt: null,
    ...overrides,
  };
}

describe("AC8 — actionSourceTxHash (source tx extraction)", () => {
  test("top-level txHash from a transfer-like result (the loop's resultPayload shape)", () => {
    assert.equal(actionSourceTxHash(JSON.stringify({ ok: true, summary: "sent", txHash: TX_A }), null), TX_A);
  });

  test("the dedicated source_tx_hash column is used when result_json is null", () => {
    assert.equal(actionSourceTxHash(null, TX_B), TX_B);
  });

  test("malformed result_json falls through to the column instead of throwing", () => {
    assert.equal(actionSourceTxHash("{not json", TX_B), TX_B);
  });

  test("batch_transfer results: the FIRST SUCCESS entry's hash wins over the top-level hash", () => {
    // Realistic shape: the top-level hash is the first BROADCAST tx (here it
    // reverted), the results[] entries carry the per-recipient outcomes. The
    // row-level attestation must point at a tx that actually confirmed.
    const resultJson = JSON.stringify({
      ok: true,
      summary: "1/2 transfers confirmed",
      txHash: TX_A,
      results: [
        { recipient: "0x1", ok: false, txHash: TX_A, summary: "reverted" },
        { recipient: "0x2", ok: true, txHash: TX_B, summary: "confirmed" },
      ],
    });
    assert.equal(actionSourceTxHash(resultJson, null), TX_B);
  });

  test("batch results: failed entries are skipped; the next success is taken", () => {
    const resultJson = JSON.stringify({
      ok: true,
      summary: "2/3 confirmed",
      results: [
        { recipient: "0x1", ok: false, txHash: TX_A, summary: "reverted" },
        { recipient: "0x2", ok: true, txHash: TX_B, summary: "confirmed" },
        { recipient: "0x3", ok: true, txHash: TX_C, summary: "confirmed" },
      ],
    });
    assert.equal(actionSourceTxHash(resultJson, null), TX_B);
  });

  test("batch results without any success fall back to the top-level hash", () => {
    const resultJson = JSON.stringify({
      ok: false,
      summary: "0/1 confirmed",
      txHash: TX_C,
      results: [{ recipient: "0x1", ok: false, txHash: TX_A, summary: "reverted" }],
    });
    assert.equal(actionSourceTxHash(resultJson, null), TX_C);
  });

  test("read-only tool results (no txHash anywhere) yield null", () => {
    assert.equal(actionSourceTxHash(JSON.stringify({ ok: true, summary: "balances", chains: [] }), null), null);
    // Server tools can echo OTHER rows' hashes nested inside arrays/objects —
    // only the top-level txHash and results[] are extraction points.
    const nested = JSON.stringify({ ok: true, actions: [{ tool: "transfer", txHash: TX_A }] });
    assert.equal(actionSourceTxHash(nested, null), null);
  });

  test("garbage hash values are rejected (not 0x + 64 hex)", () => {
    for (const bad of ["", "0x0", "pending", "0x1234", 42, null, undefined]) {
      assert.equal(
        actionSourceTxHash(JSON.stringify({ ok: true, txHash: bad }), null),
        null,
        `txHash ${String(bad)} must not be extracted`,
      );
    }
  });

  test("null-valued txHash key in result JSON yields null (falls to column)", () => {
    assert.equal(actionSourceTxHash(JSON.stringify({ ok: true, txHash: null }), TX_B), TX_B);
  });

  test("both sources absent → null; non-object JSON → null", () => {
    assert.equal(actionSourceTxHash(null, null), null);
    assert.equal(actionSourceTxHash('"a string"', null), null);
    assert.equal(actionSourceTxHash("42", null), null);
  });
});

describe("AC8 — isAttestableAction (eligibility rules)", () => {
  test("succeeded transfer on Sepolia with a tx hash is attestable", () => {
    assert.equal(isAttestableAction(actionRow(), TRACKED), true);
  });

  test("succeeded action on Ethereum (mainnet source chain) is attestable", () => {
    assert.equal(isAttestableAction(actionRow({ chainId: ETHEREUM }), TRACKED), true);
  });

  test("batch_transfer row (hash only inside results[]) is attestable", () => {
    const row = actionRow({
      resultJson: JSON.stringify({
        ok: true,
        summary: "1/1 confirmed",
        results: [{ recipient: "0x1", ok: true, txHash: TX_B, summary: "confirmed" }],
      }),
    });
    assert.equal(isAttestableAction(row, TRACKED), true);
  });

  test("non-succeeded rows never attest (failed/pending/unknown/declined/interrupted)", () => {
    for (const status of ["failed", "pending", "unknown", "declined", "interrupted", "broadcast"]) {
      assert.equal(isAttestableAction(actionRow({ status }), TRACKED), false, `status=${status}`);
    }
  });

  test("already-attested rows are not re-attested (attestedAt gate)", () => {
    assert.equal(isAttestableAction(actionRow({ attestedAt: Date.now() }), TRACKED), false);
  });

  test("rows without a chain id are skipped", () => {
    assert.equal(isAttestableAction(actionRow({ chainId: null }), TRACKED), false);
  });

  test("Creditcoin (the DESTINATION chain) never attests itself — 102031 and 102030 excluded", () => {
    // e.g. execute_conditional_release rows whose own tx lives on Creditcoin.
    assert.equal(isAttestableAction(actionRow({ chainId: 102031 }), TRACKED), false);
    assert.equal(isAttestableAction(actionRow({ chainId: 102030 }), TRACKED), false);
  });

  test("untracked source chains are skipped (Base 8453 / Polygon 137 / BNB 56)", () => {
    for (const chainId of [8453, 137, 56]) {
      assert.equal(isAttestableAction(actionRow({ chainId }), TRACKED), false, `chainId=${chainId}`);
    }
  });

  test("read-only tool rows (no tx hash anywhere) on a tracked chain are skipped", () => {
    const row = actionRow({
      resultJson: JSON.stringify({ ok: true, summary: "Tx …: succeeded at block 7", status: "succeeded" }),
    });
    assert.equal(isAttestableAction(row, TRACKED), false);
  });

  test("the tracked-chain set is caller-supplied (live ChainInfo map drives it)", () => {
    assert.equal(isAttestableAction(actionRow(), []), false);
    // If the live map ever adds a new source chain, the same row shape on it
    // becomes attestable without touching this helper.
    assert.equal(isAttestableAction(actionRow({ chainId: 8453 }), [8453]), true);
  });

  test("CREDITCOIN_DESTINATION_EVM_IDS pins the destination chain ids", () => {
    assert.deepEqual([...CREDITCOIN_DESTINATION_EVM_IDS], [102031, 102030]);
  });
});

describe("AC8 — DB migration + watcher stats (hermetic)", () => {
  before(() => {
    ensureDb();
  });

  test("ensureDb() ALTERs a pre-AC8 agent_actions table to gain the attestation columns", () => {
    // The table was forged WITHOUT attested_at/onchain_verified_at before the
    // first ensureDb() — the PRAGMA-driven ALTER TABLE path must have added
    // them (mirroring the payments attestation-column migration).
    const raw = new DatabaseSync(DB_PATH);
    try {
      const cols = raw.prepare("PRAGMA table_info(agent_actions)").all() as { name: string }[];
      const names = cols.map((c) => c.name);
      assert.ok(names.includes("attested_at"), "attested_at column missing after migration");
      assert.ok(names.includes("onchain_verified_at"), "onchain_verified_at column missing after migration");
    } finally {
      raw.close();
    }
  });

  test("getPollerStats counts only attestable unattested rows (payments + actions sum)", () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    // One attestable payment…
    db.insert(payments)
      .values({
        id: "pay-watch-1",
        recipientAddress: "0x1111111111111111111111111111111111111111",
        amountHuman: "1",
        amountBaseUnits: "1000000",
        status: "settled",
        txHash: TX_A,
        chainId: SEPOLIA,
        createdAt: now,
      })
      .run();
    // …one that is already attested (must not count)…
    db.insert(payments)
      .values({
        id: "pay-attested-1",
        recipientAddress: "0x1111111111111111111111111111111111111111",
        amountHuman: "1",
        amountBaseUnits: "1000000",
        status: "settled",
        txHash: TX_B,
        chainId: SEPOLIA,
        createdAt: now,
        attestedAt: now,
      })
      .run();
    // …one attestable action…
    db.insert(agentActions)
      .values({
        id: "act-watch-1",
        tool: "transfer",
        status: "succeeded",
        chainId: SEPOLIA,
        createdAt: now,
        resultJson: JSON.stringify({ ok: true, summary: "sent", txHash: TX_A }),
      })
      .run();
    // …and four that must NOT count: read-only (no tx hash), untracked chain,
    // outside the age window, and already attested.
    db.insert(agentActions)
      .values([
        {
          id: "act-readonly-1",
          tool: "get_balances",
          status: "succeeded",
          chainId: SEPOLIA,
          createdAt: now,
          resultJson: JSON.stringify({ ok: true, summary: "balances", chains: [] }),
        },
        {
          id: "act-untracked-1",
          tool: "transfer",
          status: "succeeded",
          chainId: 137, // Polygon — not an Attestcoin source chain
          createdAt: now,
          resultJson: JSON.stringify({ ok: true, summary: "sent", txHash: TX_A }),
        },
        {
          id: "act-stale-1",
          tool: "transfer",
          status: "succeeded",
          chainId: SEPOLIA,
          createdAt: now - 15 * day, // beyond MAX_AGE_MS
          resultJson: JSON.stringify({ ok: true, summary: "sent", txHash: TX_A }),
        },
        {
          id: "act-attested-1",
          tool: "transfer",
          status: "succeeded",
          chainId: SEPOLIA,
          createdAt: now,
          resultJson: JSON.stringify({ ok: true, summary: "sent", txHash: TX_B }),
          attestedAt: now,
        },
      ])
      .run();

    const stats = getPollerStats();
    assert.equal(stats.watchingActions, 1, "exactly the one eligible unattested action is watched");
    assert.equal(stats.watching, 2, "watching sums payments (1) + eligible actions (1)");

    // Cleanup so the counts stay deterministic if this file ever grows more
    // stats assertions.
    db.delete(payments).where(eq(payments.id, "pay-watch-1")).run();
    db.delete(payments).where(eq(payments.id, "pay-attested-1")).run();
    for (const id of ["act-watch-1", "act-readonly-1", "act-untracked-1", "act-stale-1", "act-attested-1"]) {
      db.delete(agentActions).where(eq(agentActions.id, id)).run();
    }
    assert.equal(getPollerStats().watching, 0);
    assert.equal(getPollerStats().watchingActions, 0);
  });
});
