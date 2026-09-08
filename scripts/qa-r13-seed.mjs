// R13-A live-verification seed: 2 contacts + 3 payments (mixed statuses) so
// the contacts rollup and the payments surfaces can be exercised in a real
// browser. Run with node (bun NAPI crash with better-sqlite3 — known).
// Rows carry the QA marker "R13QA" in the memo so the cleanup pass can
// delete exactly what this script inserted.
import Database from "better-sqlite3";

const db = new Database(process.argv[2] ?? "sqlite.db");
db.pragma("journal_mode = WAL");

const now = Date.now();
const A = "0x9f8a7B6c5D4e3F2a1B0c9D8e7F6a5B4c3D2e1F0a";
const B = "0xAbCdef0000000000000000000000000000000123";

const contacts = [
  { id: "r13qa-c1", label: "Coffee Buddy", address: A, note: "R13QA", favorite: 1, lastUsed: 0 },
  { id: "r13qa-c2", label: "Test Payee", address: B, note: "R13QA", favorite: 0, lastUsed: 0 },
];

const payments = [
  { id: "r13qa-p1", addr: A, label: "Coffee Buddy", amount: "12.5", status: "settled", tx: "0x" + "a1".repeat(32), createdAt: now - 8 * 60_000, memo: "R13QA" },
  { id: "r13qa-p2", addr: A.toLowerCase(), label: "Coffee Buddy", amount: "5", status: "pending", tx: null, createdAt: now - 26 * 3600_000, memo: "R13QA" },
  { id: "r13qa-p3", addr: A, label: "Coffee Buddy", amount: "3", status: "failed", tx: null, createdAt: now - 3 * 24 * 3600_000, memo: "R13QA" },
];

// One active recurring schedule (daily, 5 runs) for the R13-C Ask-agent test.
const recurring = [
  { id: "r13qa-r1", label: "Coffee Buddy", addr: A, amount: "4.5", nextFire: Math.floor((now + 3600_000) / 1000) },
];

const insC = db.prepare(
  "INSERT INTO contacts (id, label, address, note, favorite, last_used) VALUES (?, ?, ?, ?, ?, ?)",
);
const insP = db.prepare(
  `INSERT INTO payments (id, recipient_label, recipient_address, token, amount_human, amount_base_units, memo, status, tx_hash, chain_id, created_at)
   VALUES (?, ?, ?, 'USDC', ?, ?, ?, ?, ?, 11155111, ?)`,
);

const insR = db.prepare(
  `INSERT INTO recurring_schedules (id, recipient_label, recipient_address, token, amount_human, amount_base_units, cadence, chain_id, next_fire_at, executions, max_executions, active, schedule_id_hash, created_at)
   VALUES (?, ?, ?, 'USDC', ?, '4500000', 'daily', 11155111, ?, 0, 5, 1, ?, ?)`,
);

const tx = db.transaction(() => {
  for (const c of contacts) insC.run(c.id, c.label, c.address, c.note, c.favorite, c.lastUsed);
  for (const p of payments) insP.run(p.id, p.label, p.addr, p.amount, p.amount, p.memo, p.status, p.tx, p.createdAt);
  for (const r of recurring) insR.run(r.id, r.label, r.addr, r.amount, r.nextFire, "r13qa-hash-" + r.id, now);
});
tx();
console.log("seeded:", { contacts: contacts.length, payments: payments.length });
db.close();
