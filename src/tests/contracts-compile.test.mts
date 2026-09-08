// ─────────────────────────────────────────────────────────────────────────────
// Contract compile suite (brief §11): every in-repo contract compiles to real
// bytecode + ABI via the app's own compile service — the same path the
// deploy_contract tool uses at runtime. Catches Solidity regressions before
// they reach the wallet.
// ─────────────────────────────────────────────────────────────────────────────

import { test, describe } from "node:test";
import assert from "node:assert/strict";
// The compile service reads contracts/ relative to process.cwd() — run from a
// temp dir would break it, so chdir is NOT used here; tests run from the repo
// root. (The agent-loop test isolates its DB instead.)
const { compileContract, compileCustomSource, knownContractKeys } = await import("@/lib/contracts/compile");

const EXPECTED_ABIS: Record<string, string[]> = {
  "ConditionalRelease.sol": ["release", "claimRefund", "VERIFIER", "beneficiary", "escrowAmount", "state", "releaseWindowEnd"],
  "CrossChainSwapSource.sol": ["lock", "claimRefund", "lockCount"],
  "CrossChainSwapDestination.sol": ["releaseWithProof", "fund", "withdraw", "spentLocks", "trustedSourceContract", "funder"],
  "templates/SimpleERC20.sol": ["name", "symbol", "decimals", "balanceOf", "transfer", "totalSupply"],
  "templates/SimpleEscrow.sol": ["release", "refund", "depositor", "beneficiary", "deadline", "concluded"],
  "templates/SimpleMultisig.sol": ["submit", "confirm", "owners", "threshold", "transactionCount"],
};

describe("contract compile suite", () => {
  for (const key of knownContractKeys()) {
    test(`compiles ${key}`, { timeout: 120_000 }, async () => {
      const artifact = await compileContract(key);
      assert.ok(artifact.bytecode.startsWith("0x"), "bytecode must be 0x-prefixed");
      assert.ok(artifact.bytecode.length > 100, `bytecode suspiciously small (${artifact.bytecode.length} chars)`);
      assert.ok(Array.isArray(artifact.abi) && artifact.abi.length > 0, "ABI present");
      assert.equal(artifact.warnings.length, 0, `unexpected warnings: ${artifact.warnings.join(" | ").slice(0, 300)}`);
      const expected = EXPECTED_ABIS[key] ?? [];
      const names = new Set((artifact.abi as Array<{ name?: string; type?: string }>).map((e) => e.name ?? ""));
      for (const fn of expected) {
        assert.ok(names.has(fn), `ABI missing ${fn}`);
      }
    });
  }

  test("ASC contracts reference the BlockProver precompile constant", { timeout: 120_000 }, async () => {
    // viaIR + optimizer encodes the address 0x…0FD2 as its minimal PUSH2 form
    // (0x61 0x0fd2) rather than a full 20-byte PUSH20.
    const asc = await compileContract("ConditionalRelease.sol");
    assert.ok(asc.bytecode.toLowerCase().includes("610fd2"), "ConditionalRelease bytecode should embed the precompile address (PUSH2 0x0fd2)");
    const swapDest = await compileContract("CrossChainSwapDestination.sol");
    assert.ok(swapDest.bytecode.toLowerCase().includes("610fd2"), "swap destination should embed the precompile address");
  });

  test("custom source path: compiles agent-shaped Solidity", { timeout: 120_000 }, async () => {
    const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract GreeterToken is ERC20 {
    string public greeting;
    constructor(string memory g, uint256 supply) ERC20("Greeter", "GRT") {
        greeting = g;
        _mint(msg.sender, supply);
    }
}`;
    const artifact = await compileCustomSource(source, "GreeterToken");
    assert.ok(artifact.bytecode.length > 100, "custom bytecode present");
    assert.equal(artifact.contractName, "GreeterToken");
    const names = new Set((artifact.abi as Array<{ name?: string }>).map((e) => e.name ?? ""));
    assert.ok(names.has("greeting"));
    assert.ok(names.has("transfer"));
  });

  test("custom source path: rejects broken Solidity with the compiler error", { timeout: 60_000 }, async () => {
    await assert.rejects(
      compileCustomSource("pragma solidity ^0.8.23; contract Broken { function f() { undefinedCall(); } }", "Broken"),
      /compilation failed/i,
    );
  });

  test("artifact cache: second compile of the same key is instant and identical", { timeout: 120_000 }, async () => {
    const first = await compileContract("CrossChainSwapSource.sol");
    const t0 = Date.now();
    const second = await compileContract("CrossChainSwapSource.sol");
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 500, `cached compile should be instant, took ${elapsed}ms`);
    assert.equal(second.bytecode, first.bytecode);
    assert.equal(second.sourceHash, first.sourceHash);
  });
});
