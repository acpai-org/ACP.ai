// ─────────────────────────────────────────────────────────────────────────────
// Fund-safety regression suite (P14 / P13 / P11 shapes — brief §5, Part 3).
//
// P14: the lock amount and the release amount are SEPARATE values end to end.
//      The lock transaction's value is exactly the requested lock amount,
//      always; the release side is pre-funded from lockWei × rate in bigint.
//      Covers rate > 1 (the owner's incident shape), rate = 1 (the boundary
//      where the two sides are equal by construction), and malformed fields.
// P13: zero-constructor / zero-parameter contracts deploy without the viem
//      encodeDeployData crash (args → undefined), parameterized contracts
//      keep their args.
// P11: create_conditional_release always resolves a real target chain
//      (Creditcoin Testnet 102031 via the compiled payload) — never
//      "Unsupported chain undefined".
// ─────────────────────────────────────────────────────────────────────────────

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { prepareClientTool } = await import("@/lib/agent/prepare-client");
const { prepareDeployment } = await import("@/lib/contracts/prepare");
const { encodeDeployData } = await import("viem");

const WEI = 10n ** 18n;

function toWeiStr(s: string): bigint {
  const [whole, frac = ""] = s.split(".");
  const padded = (frac + "0".repeat(18)).slice(0, 18);
  return BigInt(whole || "0") * WEI + BigInt(padded || "0");
}

describe("P14 — swap amount separation (lock vs release side)", () => {
  test("owner's incident shape: lock 0.0005 ETH at rate 1000 (rate > 1)", { timeout: 120_000 }, async () => {
    const prepared = await prepareClientTool("cross_chain_swap", {
      lockAmount: "0.0005",
      rateTctcPerEth: 1000,
    });
    assert.ok(prepared.ok, `prep failed: ${prepared.error}`);
    const lockWei = BigInt(String(prepared.enrichedArgs?.__lockWei));
    const fundWei = BigInt(String(prepared.enrichedArgs?.__fundWei));
    // The lock side is EXACTLY the requested lock amount — never the release
    // amount (the incident: 0.5 ETH sent instead of locking 0.0005).
    assert.equal(lockWei, toWeiStr("0.0005"), "lock value must be exactly 0.0005 ETH in wei");
    // The release side is exactly lockWei × rate — the pre-fund.
    assert.equal(fundWei, lockWei * 1000n, "release side must be lockWei × rate");
    // The incident's exact confusion must be impossible: the Sepolia-side
    // value (lockWei) must NOT equal the release amount (0.5).
    assert.notEqual(lockWei, toWeiStr("0.5"));
    assert.equal(fundWei, toWeiStr("0.5"));
  });

  test("boundary rate = 1: both sides equal BY CONSTRUCTION, never by conflation", { timeout: 120_000 }, async () => {
    const prepared = await prepareClientTool("cross_chain_swap", {
      lockAmount: "2",
      rateTctcPerEth: 1,
    });
    assert.ok(prepared.ok);
    const lockWei = BigInt(String(prepared.enrichedArgs?.__lockWei));
    const fundWei = BigInt(String(prepared.enrichedArgs?.__fundWei));
    assert.equal(lockWei, toWeiStr("2"));
    assert.equal(fundWei, lockWei * 1n, "rate=1: release side equals lock side × 1");
  });

  test("small fractional amount: no float truncation to zero (audit finding)", { timeout: 120_000 }, async () => {
    // lockAmount 0.000000001 × rate 1 — float math (Number × toFixed(8))
    // produced fundWei "0" here before the bigint fix.
    const prepared = await prepareClientTool("cross_chain_swap", {
      lockAmount: "0.000000001",
      rateTctcPerEth: 1,
    });
    assert.ok(prepared.ok);
    const fundWei = BigInt(String(prepared.enrichedArgs?.__fundWei));
    assert.equal(fundWei, 1_000_000_000n, "1 nano-ETH × rate 1 = 1e9 wei — bigint, never 0");
  });

  test("malformed: fractional rate is rejected (would silently round on-chain)", { timeout: 120_000 }, async () => {
    const prepared = await prepareClientTool("cross_chain_swap", {
      lockAmount: "1",
      rateTctcPerEth: 1000.5,
    });
    assert.equal(prepared.ok, false, "fractional rate must fail prep");
    assert.match(String(prepared.error), /integer/i);
  });

  test("malformed: zero rate and zero amount are rejected", { timeout: 120_000 }, async () => {
    const zeroRate = await prepareClientTool("cross_chain_swap", { lockAmount: "1", rateTctcPerEth: 0 });
    assert.equal(zeroRate.ok, false, "zero rate must fail prep");
    const zeroAmount = await prepareClientTool("cross_chain_swap", { lockAmount: "0", rateTctcPerEth: 1000 });
    assert.equal(zeroAmount.ok, false, "zero lock amount must fail prep");
  });
});

describe("P13 — zero-constructor deployment (viem encodeDeployData guard)", () => {
  // viem's TS types infer `never` for literal ABIs — the runtime behavior is
  // what these tests pin, so the params are loosely typed.
  const encode = encodeDeployData as unknown as (p: {
    abi: unknown[];
    args?: unknown[] | undefined;
    bytecode: `0x${string}`;
  }) => `0x${string}`;

  test("viem: empty args array passes through as bare bytecode", async () => {
    const bytecode = "0x6080604052";
    // Verified behavior of viem's encodeDeployData (see node_modules source):
    // !args || args.length === 0 → returns the bytecode unchanged.
    assert.equal(encode({ abi: [], args: [], bytecode }), bytecode);
    assert.equal(encode({ abi: [], args: undefined, bytecode }), bytecode);
  });

  test("viem: non-empty args with NO constructor ABI throws (the P13 crash)", async () => {
    // This is exactly the crash the owner reported — the guard in the
    // executor + prepare layer exists so this shape never reaches viem.
    assert.throws(() => encode({ abi: [], args: [1], bytecode: "0x6080" }));
  });

  test("custom path: no-constructor contract + stray args → args dropped + warning", { timeout: 120_000 }, async () => {
    const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract NoCtor {
    uint256 public value;
    function set(uint256 v) external { value = v; }
}`;
    const prepared = await prepareDeployment({
      mode: "custom",
      chain: 11155111,
      source,
      sourceName: "NoCtor",
      constructorArgs: { stray: "value" },
    });
    assert.ok(prepared.ok, `prep failed: ${prepared.error}`);
    assert.deepEqual(prepared.compiled?.constructorArgs, [], "args must be dropped for a zero-arg constructor");
    assert.ok(
      (prepared.contractInfo?.warnings ?? []).some((w) => /no parameters/i.test(w)),
      "the confirmation card must warn about the ignored args",
    );
  });

  test("custom path: parameterized contract keeps its args", { timeout: 120_000 }, async () => {
    const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract WithCtor {
    uint256 public value;
    constructor(uint256 v) { value = v; }
}`;
    const prepared = await prepareDeployment({
      mode: "custom",
      chain: 11155111,
      source,
      sourceName: "WithCtor",
      constructorArgs: { v: 42 },
    });
    assert.ok(prepared.ok, `prep failed: ${prepared.error}`);
    assert.deepEqual(prepared.compiled?.constructorArgs, [42], "parameterized contracts keep their args");
  });

  test("swap source artifact has NO constructor — deploy args are undefined-safe", { timeout: 120_000 }, async () => {
    const { compileContract } = await import("@/lib/contracts/compile");
    const artifact = await compileContract("CrossChainSwapSource.sol");
    const ctor = (artifact.abi as Array<{ type?: string }>).find((x) => x.type === "constructor");
    assert.equal(ctor, undefined, "CrossChainSwapSource must have no constructor (it takes no params)");
    // The executor passes args: undefined for this shape — encodeDeployData
    // must accept it (bare bytecode).
    assert.equal(
      encode({ abi: artifact.abi as unknown[], args: undefined, bytecode: artifact.bytecode as `0x${string}` }),
      artifact.bytecode,
    );
  });
});

describe("P11 — create_conditional_release chain resolution", () => {
  test("the compiled payload pins Creditcoin Testnet (102031) — never undefined", { timeout: 120_000 }, async () => {
    const prepared = await prepareClientTool("create_conditional_release", {
      beneficiary: "0x1111111111111111111111111111111111111111",
      amount: "5",
      sourceTxHash: null,
      timeoutHours: 72,
    });
    assert.ok(prepared.ok, `prep failed: ${prepared.error}`);
    const compiled = prepared.enrichedArgs?.__compiled as { chainId?: number } | undefined;
    assert.equal(compiled?.chainId, 102031, "the ASC deploys on Creditcoin Testnet — the executor resolves this, not args.chain");
  });

  test("unsupported source chain fails CLOSED (no silent wrong-chain pin)", { timeout: 60_000 }, async () => {
    // Base (8453) is a supported wallet chain but NOT an Attestcoin source —
    // the old code silently pinned chainKey 1; the fixed code refuses.
    const prepared = await prepareClientTool("create_conditional_release", {
      beneficiary: "0x1111111111111111111111111111111111111111",
      amount: "5",
      sourceChain: 8453,
      timeoutHours: 72,
    });
    assert.equal(prepared.ok, false, "non-source chains must fail prep");
    assert.match(String(prepared.error), /not an Attestcoin source chain/i);
  });
});

describe("P17 shape — wei conversion correctness at the prepare layer", () => {
  test("toWeiStr-equivalent math: fractional human amounts never lose precision", () => {
    assert.equal(toWeiStr("0.0005"), 500_000_000_000_000n);
    assert.equal(toWeiStr("1.5"), WEI + 500_000_000_000_000_000n);
    assert.equal(toWeiStr("0.000000001"), 1_000_000_000n);
  });
});
