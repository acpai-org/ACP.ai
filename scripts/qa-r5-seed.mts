// Round-5 QA: seed data for the payments date-range presets (R29) and the
// actions attest-root copy affordance (R27).
//   • payments spanning 25min / ~26h / ~3d / ~8d ago → /payments range chips
//     render (span >24h), 24h/7d/30d windows narrow the list correctly.
//   • agent_actions rows carrying attest_root + cc3_tx_hash → the row-level ⬡
//     chip and its R27 CopyRef render.
// Run with: node --import tsx scripts/qa-r5-seed.mts seed|cleanup
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.env.ACP_DB_PATH ?? "sqlite.db");
const now = Date.now();
const H = 3600_000;

const payments = [
  {
    // Fresh (<24h): visible under every window.
    id: "r5qa-pay-1", to: "0x1111111111111111111111111111111111111111",
    label: "Ada Lovelace", amount: "5", base: "5000000", status: "settled",
    memo: "coffee beans", ago: 25 * 60_000,
  },
  {
    // ~26h old: hidden by the 24h preset, visible under 7d/30d/All.
    id: "r5qa-pay-2", to: "0x2222222222222222222222222222222222222222",
    label: "Grace Hopper", amount: "42", base: "42000000", status: "settled",
    memo: "server invoice", ago: 26 * H,
  },
  {
    // ~3d old: outside 24h/7d? no — inside 7d, outside 24h.
    id: "r5qa-pay-3", to: "0x3333333333333333333333333333333333333333",
    label: "Alan Turing", amount: "0.4", base: "400000", status: "failed",
    memo: "retry needed", ago: 3 * 24 * H,
  },
  {
    // ~8d old: outside 7d, inside 30d.
    id: "r5qa-pay-4", to: "0x4444444444444444444444444444444444444444",
    label: "Edsger Dijkstra", amount: "12", base: "12000000", status: "pending",
    memo: "monthly retainer", ago: 8 * 24 * H,
  },
];

const actions = [
  {
    // Fresh row carrying an attest_root + cc3 hash → the row-level ⬡ chip
    // renders WITH its R27 CopyRef (the copy target for clipboard QA).
    id: "r5qa-act-1", tool: "transfer", status: "succeeded", chainId: 11155111,
    risk: "funds", conf: 1,
    result: { ok: true, summary: "Sent 5 USDC on Sepolia (attested)" },
    txHash: "0xaaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999",
    cc3: "0xccccaaaabbbbccdd000000000000000000000000000000000000000000000999",
    root: "0x5678abcd5678abcd5678abcd5678abcd5678abcd5678abcd5678abcd5678abcd",
    ago: 40 * 60_000,
  },
  {
    // ~2d old plain row → keeps the list >24h so actions range chips render.
    id: "r5qa-act-2", tool: "get_balances", status: "succeeded", chainId: 8453,
    risk: "read", conf: 0,
    result: { ok: true, summary: "Balances refreshed on Base" },
    ago: 2 * 24 * H,
  },
];

const delPay = db.prepare("DELETE FROM payments WHERE id LIKE 'r5qa-pay-%'");
const insPay = db.prepare(`INSERT INTO payments
  (id, recipient_label, recipient_address, token, amount_human, amount_base_units, memo, status, tx_hash, chain_id, sender_address, created_at, settled_at)
  VALUES (?, ?, ?, 'USDC', ?, ?, ?, ?, ?, ?, '0x9999999999999999999999999999999999999999', ?, ?)`);

const delAct = db.prepare("DELETE FROM agent_actions WHERE id LIKE 'r5qa-act-%'");
const insAct = db.prepare(`INSERT INTO agent_actions
  (id, run_id, call_id, tool, params_json, status, chain_id, risk_class, confirmation_required, result_json, source_tx_hash, cc3_tx_hash, attest_root, created_at, completed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

export function cleanup() {
  delPay.run();
  delAct.run();
}

export function seed() {
  cleanup();
  for (const p of payments) {
    insPay.run(
      p.id, p.label, p.to, p.amount, p.base, p.memo, p.status,
      p.status === "settled" ? "0x" + p.id.padEnd(62, "0").slice(2) : null,
      11155111, now - p.ago, p.status === "settled" ? now - p.ago + 60_000 : null,
    );
  }
  let i = 0;
  for (const a of actions) {
    insAct.run(
      a.id, "run_r5qa", `call_r5qa_${++i}`, a.tool, JSON.stringify({ note: "r5qa seed row" }),
      a.status, a.chainId, a.risk, a.conf ? 1 : 0,
      JSON.stringify(a.result), a.txHash ?? null, a.cc3 ?? null, a.root ?? null,
      now - a.ago, now - a.ago + 5000,
    );
  }
  return { payments: payments.length, actions: actions.length };
}

const mode = process.argv[2];
if (mode === "seed") {
  console.log("seeded", JSON.stringify(seed()));
} else if (mode === "cleanup") {
  cleanup();
  console.log("cleaned");
}
db.close();
