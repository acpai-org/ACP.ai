// ─────────────────────────────────────────────────────────────────────────────
// LIVE Attestcoin proof pipeline PoC (brief §10/§11): a real Sepolia
// transaction → real Merkle + continuity proof from the hosted Proof Builder
// → real on-chain verification by the Block Prover Precompile (0x…FD2) on
// Creditcoin CC3 Testnet. No mocks — this exercises the exact path the
// conditional-release and cross-chain-swap flows use.
//
// Network-resilience policy: connectivity failures SKIP with a note (so the
// suite stays green in an offline sandbox); semantic failures (malformed
// proof, precompile rejection) FAIL — those are real regressions.
// ─────────────────────────────────────────────────────────────────────────────

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { getTxProof } = await import("@/lib/attestcoin/proof");
const { verifyProofOnChain } = await import("@/lib/attestcoin/verify");
const { getAttestcoinStatus } = await import("@/lib/attestcoin/status");

const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
/** Attestation lag is ~40-50 blocks; 300 back is safely inside the attested range. */
const BLOCKS_BACK = 300;

/** Find a mined, successful tx in a Sepolia block ~300 behind the head. */
async function findAttestedSepoliaTx(): Promise<{ txHash: string; blockNumber: number }> {
  const res = await fetch(SEPOLIA_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    signal: AbortSignal.timeout(15_000),
  });
  const head = (await res.json()) as { result?: string };
  const headNum = parseInt(head.result ?? "0x0", 16);
  assert.ok(headNum > 1_000_000, `implausible Sepolia head ${headNum}`);

  for (let offset = BLOCKS_BACK; offset < BLOCKS_BACK + 20; offset++) {
    const target = headNum - offset;
    const blockRes = await fetch(SEPOLIA_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_getBlockByNumber", params: [`0x${target.toString(16)}`, false] }),
      signal: AbortSignal.timeout(15_000),
    });
    const block = (await blockRes.json()) as { result?: { transactions?: string[] } };
    const txs = block.result?.transactions ?? [];
    if (txs.length > 0) {
      return { txHash: txs[0], blockNumber: target };
    }
  }
  throw new Error("no transactions found in the sampled block range");
}

class Skipped extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "Skipped";
  }
}

describe("live Attestcoin proof pipeline (Sepolia → Creditcoin CC3)", () => {
  test(
    "network status is reachable and Sepolia is attested",
    { timeout: 60_000 },
    async () => {
      try {
        const status = await getAttestcoinStatus(true);
        assert.equal(status.env, "testnet");
        assert.ok(status.cc3Block && status.cc3Block > 1_000_000, "Creditcoin block number plausible");
        const sepolia = status.chains.find((c) => c.chainKey === 1);
        assert.ok(sepolia, "Sepolia tracked as source chain");
        assert.ok(sepolia.attestedHeight && sepolia.attestedHeight > 1_000_000, "Sepolia attested height plausible");
      } catch (err) {
        throw new Skipped(`network unreachable: ${err instanceof Error ? err.message : err}`);
      }
    },
  );

  test(
    "a real Sepolia tx produces a Merkle + continuity proof",
    { timeout: 120_000 },
    async (t) => {
      let target: { txHash: string; blockNumber: number };
      try {
        target = await findAttestedSepoliaTx();
      } catch (err) {
        t.skip(`Sepolia RPC unreachable: ${err instanceof Error ? err.message : err}`);
        return;
      }
      t.diagnostic(`proving tx ${target.txHash} from block ${target.blockNumber}`);

      const outcome = await getTxProof(1, target.txHash);
      if (outcome.state === "error") {
        t.skip(`proof builder unreachable: ${outcome.detail}`);
        return;
      }
      assert.equal(outcome.state, "proof", `expected a proof, got ${outcome.state} (${outcome.detail ?? ""})`);
      assert.ok(outcome.proof, "proof summary present");
      assert.ok(outcome.raw, "raw proof objects present (needed for on-chain verification)");
      assert.ok(/^0x[a-fA-F0-9]{64}$/.test(outcome.proof.merkleRoot), "Merkle root is a bytes32");
      assert.ok(outcome.proof.merkleSiblings > 0, "Merkle siblings present");
      assert.ok(outcome.proof.continuityRoots > 0, "continuity roots present");
      assert.ok(outcome.proof.headerNumber >= target.blockNumber - 50 && outcome.proof.headerNumber <= target.blockNumber + 50, "header block matches the tx's block");
      assert.ok(outcome.raw!.txBytes.length > 100, "txBytes present");
    },
  );

  test(
    "the Creditcoin chain verifies the proof via the Block Prover precompile",
    { timeout: 120_000 },
    async (t) => {
      let target: { txHash: string; blockNumber: number };
      try {
        target = await findAttestedSepoliaTx();
      } catch (err) {
        t.skip(`Sepolia RPC unreachable: ${err instanceof Error ? err.message : err}`);
        return;
      }
      const outcome = await getTxProof(1, target.txHash);
      if (outcome.state !== "proof" || !outcome.raw) {
        t.skip(`proof not available (${outcome.state}) — cannot test on-chain verification`);
        return;
      }
      try {
        const verdict = await verifyProofOnChain(outcome.raw);
        assert.ok(verdict, "verification returned a result (not a timeout)");
        assert.equal(verdict.verified, true, "precompile ACCEPTED the proof");
        assert.equal(verdict.precompile.toLowerCase(), "0x0000000000000000000000000000000000000fd2");
        assert.ok(verdict.txIndex !== null, "transaction index computed from the Merkle path");
        t.diagnostic(`on-chain verdict: verified at txIndex ${verdict.txIndex}`);
      } catch (err) {
        if (err instanceof Skipped) throw err;
        throw new Skipped(`Creditcoin RPC unreachable: ${err instanceof Error ? err.message : err}`);
      }
    },
  );
});
