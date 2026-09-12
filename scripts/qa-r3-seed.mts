// Round-3 QA: seed agent_actions rows across two chains (Sepolia + Base)
// so the Actions view renders multi-chain data for filter-chip verification.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.env.ACP_DB_PATH ?? "sqlite.db");
const now = Date.now();
const rows = [
  {
    id: "r3qa-seed-1", tool: "get_balances", status: "succeeded", chainId: 11155111,
    risk: "read", conf: 0, result: { ok: true, summary: "Balances refreshed on Sepolia" },
  },
  {
    id: "r3qa-seed-2", tool: "transfer", status: "succeeded", chainId: 11155111,
    risk: "funds", conf: 1, result: { ok: true, summary: "Sent 5 USDC on Sepolia", txHash: "0x1111aaabbbcccdddeeeeffff0000111122223333444455556666777788889999" },
  },
  {
    id: "r3qa-seed-3", tool: "check_attestation_status", status: "failed", chainId: 11155111,
    risk: "read", conf: 0, result: { ok: false, summary: "RPC timeout fetching attestation status" },
  },
  {
    id: "r3qa-seed-4", tool: "get_balances", status: "succeeded", chainId: 8453,
    risk: "read", conf: 0, result: { ok: true, summary: "Balances refreshed on Base" },
  },
  {
    id: "r3qa-seed-5", tool: "transfer", status: "awaiting_signature", chainId: 8453,
    risk: "funds", conf: 1, result: null,
  },
];
const del = db.prepare("DELETE FROM agent_actions WHERE id LIKE 'r3qa-seed-%'");
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
      r.id, "run_r3qa", `call_r3qa_${++i}`, r.tool, JSON.stringify({ note: "r3qa seed row" }),
      r.status, r.chainId, r.risk, r.conf ? 1 : 0,
      r.result ? JSON.stringify(r.result) : null, null, null, null,
      now - i * 60000, r.status === "awaiting_signature" ? null : now - i * 60000 + 5000,
    );
  }
  return rows.length;
}

// CLI: `node --import tsx scripts/qa-r3-seed.mts seed|cleanup`
const mode = process.argv[2];
if (mode === "seed") {
  console.log("seeded", seed(), "rows");
} else if (mode === "cleanup") {
  cleanup();
  console.log("cleaned");
}
db.close();
