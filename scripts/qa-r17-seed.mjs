// R17 live-verification seed: 2 contacts + 4 payments + 4 notifications
// (3 UNREAD so the global badge surfaces a live count — the round's feature).
// Run with node (bun NAPI crash with better-sqlite3 — known). Rows carry the
// QA marker "R17QA" (payments memo) / note (contacts); notification ids are
// prefixed "r17qa-" so the cleanup pass deletes exactly what this inserted.
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

const db = new Database(process.argv[2] ?? "sqlite.db");
db.pragma("journal_mode = WAL");

const now = Date.now();
const A = "0x9f8a7B6c5D4e3F2a1B0c9D8e7F6a5B4c3D2e1F0a";
const B = "0xAbCdef0000000000000000000000000000000123";

const contacts = [
  { id: "r17qa-c1", label: "Coffee Buddy", address: A, note: "R17QA", favorite: 1, lastUsed: 0 },
  { id: "r17qa-c2", label: "Test Payee", address: B, note: "R17QA", favorite: 0, lastUsed: 0 },
];

// Payee A: 3 rows (2 settled USDC + 1 settled ETH). Payee B: 1 failed — the
// contact-filter empty state is exercised by a THIRD contact with no rows.
const payments = [
  { id: "r17qa-p1", addr: A, label: "Coffee Buddy", token: "USDC", amount: "12.5", base: "12500000", status: "settled", tx: "0x" + "a1".repeat(32), createdAt: now - 8 * 60_000 },
  { id: "r17qa-p2", addr: A, label: "Coffee Buddy", token: "USDC", amount: "5", base: "5000000", status: "settled", tx: "0x" + "b2".repeat(32), createdAt: now - 26 * 3600_000 },
  { id: "r17qa-p3", addr: A, label: "Coffee Buddy", token: "ETH", amount: "0.8", base: "800000000000000000", status: "settled", tx: "0x" + "c3".repeat(32), createdAt: now - 3 * 24 * 3600_000 },
  { id: "r17qa-p4", addr: B, label: "Test Payee", token: "USDC", amount: "7", base: "7000000", status: "failed", tx: null, createdAt: now - 2 * 24 * 3600_000 },
];

// 3 unread (badge = 3 on load) + 1 read. The settled one joins r17qa-p1.
const notifications = [
  { id: "r17qa-" + randomUUID().slice(0, 8), title: "notifications.event.settled", message: JSON.stringify({ amount: "12.5", token: "USDC", recipient: "Coffee Buddy" }), type: "payment", read: 0, rel: "r17qa-p1", createdAt: now - 7 * 60_000 },
  { id: "r17qa-" + randomUUID().slice(0, 8), title: "notifications.event.initiated", message: JSON.stringify({ amount: "5", token: "USDC", recipient: "Coffee Buddy" }), type: "payment", read: 0, rel: "r17qa-p2", createdAt: now - 25 * 3600_000 },
  { id: "r17qa-" + randomUUID().slice(0, 8), title: "System check complete", message: "Attestcoin watcher heartbeat OK", type: "system", read: 0, createdAt: now - 30 * 60_000, rel: null },
  { id: "r17qa-" + randomUUID().slice(0, 8), title: "notifications.event.failed", message: JSON.stringify({ amount: "7", token: "USDC", recipient: "Test Payee" }), type: "payment", read: 1, rel: "r17qa-p4", createdAt: now - 2 * 24 * 3600_000 + 60_000 },
];

const insC = db.prepare(
  "INSERT INTO contacts (id, label, address, note, favorite, last_used) VALUES (?, ?, ?, ?, ?, ?)",
);
const insP = db.prepare(
  `INSERT INTO payments (id, recipient_label, recipient_address, token, amount_human, amount_base_units, memo, status, tx_hash, chain_id, created_at, settled_at)
   VALUES (?, ?, ?, ?, ?, ?, 'R17QA', ?, ?, 11155111, ?, ?)`,
);
const insN = db.prepare(
  "INSERT INTO notifications (id, title, message, type, read, related_payment_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
);

const tx = db.transaction(() => {
  for (const c of contacts) insC.run(c.id, c.label, c.address, c.note, c.favorite, c.lastUsed);
  for (const p of payments) insP.run(p.id, p.label, p.addr, p.token, p.amount, p.base, p.status, p.tx, p.createdAt, p.status === "settled" ? p.createdAt + 60_000 : null);
  for (const n of notifications) insN.run(n.id, n.title, n.message, n.type, n.read, n.rel, n.createdAt);
});
tx();

console.log("seeded:", {
  contacts: contacts.length,
  payments: payments.length,
  notifications: notifications.length,
  unread: notifications.filter((n) => !n.read).length,
});
db.close();
