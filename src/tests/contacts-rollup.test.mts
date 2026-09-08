// ─────────────────────────────────────────────────────────────────────────────
// R13-A contacts rollup unit tests. Pure logic — the payee grouping, the
// case-insensitive canonicalization (checksum vs raw lowercase), sort order,
// status counting, and the recent-slice limit.
// ─────────────────────────────────────────────────────────────────────────────

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { payeeKey, rollupsByPayee, rollupStatusTone, settledTotalsByToken } = await import("@/lib/contacts/rollup");

const ADDR_A = "0x9f8a7B6c5D4e3F2a1B0c9D8e7F6a5B4c3D2e1F0a" as const;
const ADDR_B = "0x1111111111111111111111111111111111111111" as const;
const ADDR_C = "0x2222222222222222222222222222222222222222" as const;

function mk(id: string, address: string, createdAt: number, status = "settled") {
  return {
    id,
    recipientAddress: address,
    recipientLabel: null,
    amountHuman: "5",
    token: "USDC",
    memo: null,
    status,
    chainId: 11155111,
    createdAt,
  };
}

describe("payeeKey", () => {
  test("checksums a well-formed address (case-insensitive input → one key)", () => {
    // The lowercase and checksummed spellings of the SAME address must agree.
    assert.equal(payeeKey(ADDR_A), payeeKey(ADDR_A.toLowerCase()));
  });

  test("malformed addresses fall back to lowercase without throwing", () => {
    assert.equal(payeeKey("0xNOTANADDRESS"), "0xnotanaddress");
    assert.equal(payeeKey(""), "");
  });
});

describe("rollupsByPayee", () => {
  test("groups by recipient, newest first, counts statuses", () => {
    const now = 1_700_000_000_000;
    const payments = [
      mk("a1", ADDR_A, now - 1000, "settled"),
      mk("a2", ADDR_A, now, "pending"), // newest A
      mk("a3", ADDR_A.toLowerCase(), now - 5000, "failed"),
      mk("b1", ADDR_B, now - 2000, "settled"),
    ];
    const map = rollupsByPayee(payments);
    const a = map.get(payeeKey(ADDR_A));
    assert.ok(a, "rollup for payee A exists");
    assert.equal(a.total, 3);
    assert.equal(a.settled, 1);
    assert.equal(a.inFlight, 1);
    assert.equal(a.last?.id, "a2", "newest payment wins regardless of input order");
    assert.deepEqual(
      a.recent.map((p) => p.id),
      ["a2", "a1", "a3"],
      "sorted newest-first",
    );

    const b = map.get(payeeKey(ADDR_B));
    assert.ok(b);
    assert.equal(b.total, 1);
    assert.equal(b.last?.id, "b1");
  });

  test("respects the recent-slice limit (default 3, custom honored)", () => {
    const base = 1_700_000_000_000;
    const payments = Array.from({ length: 6 }, (_, i) =>
      mk(`p${i}`, ADDR_C, base + i, i % 2 === 0 ? "settled" : "sent"),
    );
    const def = rollupsByPayee(payments).get(payeeKey(ADDR_C));
    assert.equal(def?.recent.length, 3);
    assert.equal(def?.recent[0].id, "p5", "newest first under the limit");
    assert.equal(def?.total, 6, "total is NOT truncated");

    const one = rollupsByPayee(payments, 1).get(payeeKey(ADDR_C));
    assert.equal(one?.recent.length, 1);
  });

  test("empty input → empty map (no crash, no empty groups)", () => {
    assert.equal(rollupsByPayee([]).size, 0);
  });

  test("does not mutate the input array order", () => {
    const payments = [mk("x1", ADDR_B, 2), mk("x2", ADDR_A, 1)];
    const snapshot = payments.map((p) => p.id);
    rollupsByPayee(payments);
    assert.deepEqual(
      payments.map((p) => p.id),
      snapshot,
    );
  });
});

describe("rollupStatusTone", () => {
  test("terminal and in-flight families map to semantic tones", () => {
    assert.equal(rollupStatusTone("settled"), "success");
    assert.equal(rollupStatusTone("failed"), "danger");
    assert.equal(rollupStatusTone("declined"), "danger");
    assert.equal(rollupStatusTone("pending"), "warning");
    assert.equal(rollupStatusTone("settling"), "warning");
    assert.equal(rollupStatusTone("attested"), "primary");
    assert.equal(rollupStatusTone("whatever-else"), "muted");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R14 settled totals: per-token sums over settled payments only.
// ─────────────────────────────────────────────────────────────────────────────
describe("settledTotalsByToken", () => {
  function mkAmt(id: string, token: string, amountHuman: string, status = "settled", createdAt = 1) {
    return { ...mk(id, ADDR_A, createdAt, status), token, amountHuman };
  }

  test("sums settled amounts per token; never crosses symbols", () => {
    const totals = settledTotalsByToken([
      mkAmt("1", "USDC", "12.5"),
      mkAmt("2", "USDC", "25"),
      mkAmt("3", "ETH", "1.25"),
      mkAmt("4", "USDC", "50", "failed"), // not settled — excluded
      mkAmt("5", "ETH", "2", "pending"), // in flight — excluded
    ]);
    assert.deepEqual(
      totals.map((t) => ({ token: t.token, count: t.count, total: t.total })),
      [
        { token: "USDC", count: 2, total: "37.5" },
        { token: "ETH", count: 1, total: "1.25" },
      ],
      "count-desc then token-asc; only settled rows counted",
    );
  });

  test("integer sums trim trailing zeros and the dot", () => {
    const totals = settledTotalsByToken([mkAmt("1", "USDC", "25"), mkAmt("2", "USDC", "62.5")]);
    assert.equal(totals[0].total, "87.5");
    const ints = settledTotalsByToken([mkAmt("1", "USDC", "30"), mkAmt("2", "USDC", "70")]);
    assert.equal(ints[0].total, "100");
  });

  test("malformed amounts are counted but skipped from the sum", () => {
    const totals = settledTotalsByToken([mkAmt("1", "USDC", "abc"), mkAmt("2", "USDC", "5")]);
    assert.equal(totals[0].count, 2);
    assert.equal(totals[0].total, "5");
  });

  test("no settled rows → empty array", () => {
    assert.deepEqual(settledTotalsByToken([mkAmt("1", "USDC", "5", "failed")]), []);
    assert.deepEqual(settledTotalsByToken([]), []);
  });

  test("rollupsByPayee exposes settledTotals per payee", () => {
    const now = 1_700_000_000_000;
    const map = rollupsByPayee([
      mkAmt("a1", "USDC", "10", "settled", now),
      mkAmt("a2", "USDC", "2.5", "settled", now - 1000),
      { ...mkAmt("a3", "ETH", "1", "settled", now - 2000), recipientAddress: ADDR_B },
    ]);
    const a = map.get(payeeKey(ADDR_A));
    assert.deepEqual(a?.settledTotals, [{ token: "USDC", count: 2, total: "12.5" }]);
    const b = map.get(payeeKey(ADDR_B));
    assert.deepEqual(b?.settledTotals, [{ token: "ETH", count: 1, total: "1" }]);
  });
});
