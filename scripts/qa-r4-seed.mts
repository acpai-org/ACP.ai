// Round-4 QA: seed agent_actions rows spanning multiple TIME WINDOWS
// (minutes / ~26h / ~3d / ~8d ago) with tx hashes on Attestcoin-tracked
// chains, so the Actions view can be verified for:
//   • R23 range chips (log spans >24h → chips render; 24h/7d/30d windows)
//   • R24 check-attestation buttons (terminal rows carrying a tx hash)
// Run with: node --import tsx scripts/qa-r4-seed.mts seed|cleanup
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.env.ACP_DB_PATH ?? "sqlite.db");
const now = Date.now();
const H = 3600_000;

const rows = [
  {
    // Fresh (<24h): hidden by the 24h window filter.
    id: "r4qa-seed-1", tool: "get_balances", status: "succeeded", chainId: 11155111,
    risk: "read", conf: 0, result: { ok: true, summary: "Balances refreshed on Sepolia" }, ago: 25 * 60_000,
  },
  {
    // ~26h old: visible with "All time"/"7d"/"30d", hidden by "24h". Terminal
    // + tx hash → check-attestation button renders.
    id: "r4qa-seed-2", tool: "transfer", status: "succeeded", chainId: 11155111,
    risk: "funds", conf: 1,
    result: { ok: true, summary: "Sent 5 USDC on Sepolia", txHash: "0x1111aaabbbcccdddeeeeffff0000111122223333444455556666777788889999" },
    sourceTx: "0x1111aaabbbcccdddeeeeffff0000111122223333444455556666777788889999",
    ago: 26 * H,
  },
  {
    // ~3d old: unknown status + tx hash → the primary "did it land?" row.
    // (Realistic shape: an unknown/broadcast-unconfirmed transfer carries its
    // tx hash in result JSON — sourceTxHash is the attestation-pipeline
    // column, not the transfer receipt slot.)
    id: "r4qa-seed-3", tool: "transfer", status: "unknown", chainId: 11155111,
    risk: "funds", conf: 1,
    result: { ok: true, summary: "Broadcast 0.4 ETH on Sepolia; receipt never confirmed", txHash: "0x2222aaabbbcccdddeeeeffff0000111122223333444455556666777788889999" },
    ago: 3 * 24 * H,
  },
  {
    // ~8d old: outside the 7d window, inside 30d.
    id: "r4qa-seed-4", tool: "transfer", status: "succeeded", chainId: 8453,
    risk: "funds", conf: 1,
    result: { ok: true, summary: "Sent 12 USDC on Base", txHash: "0x3333aaabbbcccdddeeeeffff0000111122223333444455556666777788889999" },
    ago: 8 * 24 * H,
  },
];

const del = db.prepare("DELETE FROM agent_actions WHERE id LIKE 'r4qa-seed-%'");
const ins = db.prepare(`INSERT INTO agent_actions
  (id, run_id, call_id, tool, params_json, status, chain_id, risk_class, confirmation_required, result_json, source_tx_hash, cc3_tx_hash, attest_root, created_at, completed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

export function cleanup() {
  del.run();
}

export function seed() {
  cleanup();
  let i = 0;
  for (const r of rows) {
    ins.run(
      r.id, "run_r4qa", `call_r4qa_${++i}`, r.tool, JSON.stringify({ note: "r4qa seed row" }),
      r.status, r.chainId, r.risk, r.conf ? 1 : 0,
      JSON.stringify(r.result), r.sourceTx ?? null, null, null,
      now - r.ago, now - r.ago + 5000,
    );
  }
  return rows.length;
}

const mode = process.argv[2];
if (mode === "seed") {
  console.log("seeded", seed(), "rows");
} else if (mode === "cleanup") {
  cleanup();
  console.log("cleaned");
}
db.close();
