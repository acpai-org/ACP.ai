// ─────────────────────────────────────────────────────────────────────────────
// C2 gap-fix unit tests (G1/G2/G3/G4/G7): pure logic only — no network.
//
// G1  resolveSourceChain   — live-map precedence, testnet-only static fallback,
//                            the mainnet wrong-chainKey class is impossible.
// G2  chunkByProtocolLimits — ≤10 proofs, <1000-block span, sorted output.
// G3  tryMergeProofs        — mergeProofs contiguity semantics (overlap ok,
//                            gap → ok:false, the signal to degrade per-tx).
// G4  toDecodedSummary      — receipt status mapping + display fields.
// G7  proofCostContext      — CTC formula + stale verdict.
// ─────────────────────────────────────────────────────────────────────────────

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { chunkByProtocolLimits, tryMergeProofs, MAX_BATCH_SIZE, MAX_BATCH_RANGE } = await import(
  "@/lib/attestcoin/batch"
);
const { resolveSourceChain } = await import("@/lib/attestcoin/chains");
const { toDecodedSummary } = await import("@/lib/attestcoin/decode");
const { proofCostContext, estimateVerificationCtc, STALE_GAP_BLOCKS } = await import(
  "@/lib/attestcoin/proof"
);

describe("C2/G2 — chunkByProtocolLimits (protocol batch limits)", () => {
  test("12 same-range proofs → chunks of 10 + 2 (MAX_BATCH_SIZE is 10, not 12)", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ headerNumber: 100 + i }));
    const chunks = chunkByProtocolLimits(items);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, MAX_BATCH_SIZE);
    assert.equal(chunks[1].length, 2);
  });

  test("height span ≥ 1000 blocks splits at the boundary", () => {
    const items = [
      { headerNumber: 1000 },
      { headerNumber: 1500 },
      { headerNumber: 1999 },
      { headerNumber: 2000 }, // 2000-1000 = 1000 → new chunk
    ];
    const chunks = chunkByProtocolLimits(items);
    assert.equal(chunks.length, 2);
    assert.deepEqual(
      chunks.map((c) => c.map((i) => i.headerNumber)),
      [
        [1000, 1500, 1999],
        [2000],
      ],
    );
  });

  test("input order does not matter — output is height-sorted", () => {
    const items = [{ headerNumber: 5000 }, { headerNumber: 100 }, { headerNumber: 200 }];
    const chunks = chunkByProtocolLimits(items);
    assert.deepEqual(
      chunks.flatMap((c) => c.map((i) => i.headerNumber)),
      [100, 200, 5000],
    );
  });

  test("custom height accessor (raw.headerNumber shape)", () => {
    const items = [
      { paymentId: "a", raw: { headerNumber: 300 } },
      { paymentId: "b", raw: { headerNumber: 100 } },
    ];
    const chunks = chunkByProtocolLimits(items, (i) => i.raw.headerNumber);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0][0].paymentId, "b");
  });

  test("empty input → no chunks; single item → one chunk", () => {
    assert.deepEqual(chunkByProtocolLimits([]), []);
    const one = chunkByProtocolLimits([{ headerNumber: 1 }]);
    assert.equal(one.length, 1);
    assert.equal(one[0].length, 1);
  });

  test("constants match the protocol (MAX_BATCH_SIZE 10, MAX_BATCH_RANGE 1000)", () => {
    assert.equal(MAX_BATCH_SIZE, 10);
    assert.equal(MAX_BATCH_RANGE, 1000);
  });
});

describe("C2/G3 — tryMergeProofs (contiguity semantics)", () => {
  // A proof with N roots covers [height, height + N − 1] per the SDK's
  // mergeProofs implementation.
  const proof = (roots: number) => ({
    lowerEndpointDigest: "0xabc",
    roots: Array.from({ length: roots }, (_, i) => `0x${i.toString(16).padStart(4, "0")}`),
  });

  test("overlapping coverage merges fine", () => {
    // proof A covers [100..119], proof B starts at 110 (inside A) — overlap.
    const outcome = tryMergeProofs([
      { headerNumber: 100, continuityProof: proof(20) },
      { headerNumber: 110, continuityProof: proof(20) },
    ]);
    assert.equal(outcome.ok, true);
    assert.ok(outcome.merged);
    // Overlap: B's start (110) is 10 blocks inside A → merge re-uses from
    // index latestEnd − 110 + 1 = 10 → 20 − 10 + 20 = 30 roots.
    assert.equal(outcome.merged.roots.length, 30);
  });

  test("abutting coverage merges (end+1 start)", () => {
    // A covers [100..119]; B starts exactly at 120.
    const outcome = tryMergeProofs([
      { headerNumber: 100, continuityProof: proof(20) },
      { headerNumber: 120, continuityProof: proof(10) },
    ]);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.merged?.roots.length, 30);
  });

  test("gap → ok:false with a reason (the degrade-to-per-tx signal)", () => {
    // A covers [100..119]; B starts at 130 — 10-block gap.
    const outcome = tryMergeProofs([
      { headerNumber: 100, continuityProof: proof(20) },
      { headerNumber: 130, continuityProof: proof(10) },
    ]);
    assert.equal(outcome.ok, false);
    assert.ok(outcome.reason);
  });

  test("single proof merges to itself; empty input refuses", () => {
    const single = tryMergeProofs([{ headerNumber: 5, continuityProof: proof(3) }]);
    assert.equal(single.ok, true);
    assert.equal(single.merged?.roots.length, 3);
    const empty = tryMergeProofs([]);
    assert.equal(empty.ok, false);
  });
});

describe("C2/G1 — resolveSourceChain (live map precedence)", () => {
  test("live map wins over the static testnet keys", () => {
    // Live map says evm 1 → chainKey 1 (mainnet truth); the static testnet
    // list says evm 1 → chainKey 3. Resolution must use the live key.
    const resolved = resolveSourceChain(1, "mainnet", [
      { chainKey: 1, evmChainId: 1, name: "Ethereum" },
    ]);
    assert.ok(resolved);
    assert.equal(resolved.chainKey, 1);
    assert.equal(resolved.name, "Ethereum"); // static metadata by evmChainId
    assert.ok(resolved.headRpcUrl.startsWith("https://"));
  });

  test("mainnet + no live map → NO static fallback (wrong-chain class impossible)", () => {
    assert.equal(resolveSourceChain(1, "mainnet", []), undefined);
    assert.equal(resolveSourceChain(11155111, "mainnet", []), undefined);
  });

  test("testnet + no live map → static fallback applies (cold start)", () => {
    const resolved = resolveSourceChain(11155111, "testnet", []);
    assert.ok(resolved);
    assert.equal(resolved.chainKey, 1);
    assert.equal(resolved.name, "Ethereum Sepolia");
  });

  test("live map adds chains the static list never knew (future-proofing)", () => {
    const resolved = resolveSourceChain(8453, "testnet", [
      { chainKey: 7, evmChainId: 8453, name: "" }, // on-chain name empty/undecodable
    ]);
    assert.ok(resolved);
    assert.equal(resolved.chainKey, 7);
    assert.equal(resolved.evmChainId, 8453);
  });

  test("unknown evm id with a live map → undefined (not a wrong answer)", () => {
    assert.equal(
      resolveSourceChain(999, "testnet", [{ chainKey: 1, evmChainId: 11155111, name: "Sepolia" }]),
      undefined,
    );
  });
});

describe("C2/G4 — toDecodedSummary (decoder output mapping)", () => {
  const base = {
    commonTx: {
      nonce: 7n,
      from: "0x1111111111111111111111111111111111111111",
      toIsNull: false,
      to: "0x2222222222222222222222222222222222222222",
      value: 1_500_000_000_000_000_000n, // 1.5 ETH
      data: "0xa9059cbb0000000000000000000000001234",
    },
    receipt: { receiptStatus: 1, receiptGasUsed: 51_000n },
  };

  test("success receipt maps + value formatting + calldata preview", () => {
    const s = toDecodedSummary({ type: 2, data: base });
    assert.equal(s.type, 2);
    assert.equal(s.receiptStatus, "success");
    assert.equal(s.valueEther, "1.5");
    assert.equal(s.dataPreview, "0xa9059cbb…");
    assert.equal(s.nonce, 7);
    assert.equal(s.receiptGasUsed, 51_000);
    assert.equal(s.to, "0x2222222222222222222222222222222222222222");
  });

  test("reverted receipt maps to 'reverted' (the trust hole G4 closes)", () => {
    const s = toDecodedSummary({ type: 0, data: { ...base, receipt: { receiptStatus: 0, receiptGasUsed: 21_000n } } });
    assert.equal(s.receiptStatus, "reverted");
  });

  test("contract creation (toIsNull) → to is null", () => {
    const s = toDecodedSummary({
      type: 2,
      data: { ...base, commonTx: { ...base.commonTx, toIsNull: true, data: "0x" } },
    });
    assert.equal(s.to, null);
    assert.equal(s.dataPreview, null);
  });
});

describe("C2/G7 — proof cost / freshness context", () => {
  test("CTC formula: 2.3e-5 + 2.9e-7 × roots", () => {
    assert.equal(estimateVerificationCtc(0), 2.3e-5);
    assert.equal(estimateVerificationCtc(27), 2.3e-5 + 2.9e-7 * 27);
  });

  test("fresh proof (recent block) is not stale", () => {
    const ctx = proofCostContext({ headerNumber: 100_000, continuityRoots: 10 }, 100_050);
    assert.equal(ctx.stale, false);
    assert.equal(ctx.staleGapBlocks, 50);
    assert.ok(ctx.ctcLabel.startsWith("≈"));
    assert.ok(ctx.ctcLabel.endsWith("CTC"));
  });

  test("stale proof (≥ STALE_GAP_BLOCKS behind the head) flags", () => {
    const ctx = proofCostContext(
      { headerNumber: 100_000, continuityRoots: 10 },
      100_000 + STALE_GAP_BLOCKS,
    );
    assert.equal(ctx.stale, true);
  });

  test("unknown attested height → gap null, not stale", () => {
    const ctx = proofCostContext({ headerNumber: 1, continuityRoots: 5 }, null);
    assert.equal(ctx.stale, false);
    assert.equal(ctx.staleGapBlocks, null);
  });
});
