// N20 e2e reproduction: seed a SETTLED payment carrying a REAL attested
// Sepolia tx hash, then watch the server-side poller flip it to
// attestedAt + onchainVerifiedAt — proving the "Verified on Attestcoin"
// stat counts real verifications (and that the flip actually happens).
// Usage: bunx tsx scripts/qa-n20-poll.ts
import { randomUUID } from "node:crypto";
import { db, ensureDb } from "../src/db";
import { payments } from "../src/db/schema";

const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

async function findAttestedSepoliaTx(): Promise<{ txHash: string; blockNumber: number }> {
  const headRes = await fetch(SEPOLIA_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    signal: AbortSignal.timeout(15_000),
  });
  const headNum = parseInt(((await headRes.json()) as { result?: string }).result ?? "0x0", 16);
  for (let offset = 300; offset < 320; offset++) {
    const target = headNum - offset;
    const blockRes = await fetch(SEPOLIA_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_getBlockByNumber", params: [`0x${target.toString(16)}`, false] }),
      signal: AbortSignal.timeout(15_000),
    });
    const block = (await blockRes.json()) as { result?: { transactions?: string[] } };
    const txs = block.result?.transactions ?? [];
    if (txs.length > 0) return { txHash: txs[0], blockNumber: target };
  }
  throw new Error("no tx found");
}

async function main() {
  ensureDb();
  // Clean slate for the repro (only QA rows we created earlier).
  db.run("DELETE FROM payments WHERE recipient_label = 'QA N20'");

  const { txHash, blockNumber } = await findAttestedSepoliaTx();
  console.log(`[qa-n20] using Sepolia tx ${txHash} (block ${blockNumber})`);

  const id = randomUUID();
  const now = Date.now();
  db.insert(payments)
    .values({
      id,
      recipientLabel: "QA N20",
      recipientAddress: "0x9f8a7B6c5D4e3F2a1B0c9D8e7F6a5B4c3D2e1F0a",
      token: "USDC",
      tokenAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      amountHuman: "5",
      amountBaseUnits: "5000000",
      status: "settled",
      txHash,
      chainId: 11155111,
      senderAddress: "0xA11ce00000000000000000000000000000001234",
      createdAt: now - 60_000,
      settledAt: now - 60_000,
    })
    .run();
  console.log(`[qa-n20] inserted settled payment ${id} — poller should pick it up on the next tick`);

  // Watch the flip for up to 100 seconds (poller interval is 60s).
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const row = db.select().from(payments).all().find((p) => p.id === id);
    if (row?.attestedAt) {
      console.log(`[qa-n20] FLIPPED after ~${(i + 1) * 5}s: attestedAt=${row.attestedAt} root=${row.attestRoot} onchainVerifiedAt=${row.onchainVerifiedAt}`);
      process.exit(0);
    }
    console.log(`[qa-n20] waiting... ${(i + 1) * 5}s (status=${row?.status})`);
  }
  console.log("[qa-n20] NEVER FLIPPED within 100s — poller bug or proof not found");
  process.exit(1);
}

main().catch((e) => {
  console.error("[qa-n20] failed:", e);
  process.exit(1);
});
