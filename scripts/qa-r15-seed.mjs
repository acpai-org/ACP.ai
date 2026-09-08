// R15 live-verification seed: 2 contacts + 4 payments (settled USDC + settled
// ETH so the payments-page settled-total chips show two tokens) + 3
// notifications with relatedPaymentId (deep-link View-payment test). Run with
// node (bun NAPI crash with better-sqlite3 — known). Rows carry the QA marker
// "R15QA" so the cleanup pass deletes exactly what this script inserted.
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

const db = new Database(process.argv[2] ?? "sqlite.db");
db.pragma("journal_mode = WAL");

const now = Date.now();
const A = "0x9f8a7B6c5D4e3F2a1B0c9D8e7F6a5B4c3D2e1F0a";
const B = "0xAbCdef0000000000000000000000000000000123";

const contacts = [
  { id: "r15qa-c1", label: "Coffee Buddy", address: A, note: "R15QA", favorite: 1, lastUsed: 0 },
  { id: "r15qa-c2", label: "Test Payee", address: B, note: "R15QA", favorite: 0, lastUsed: 0 },
];

// Payee A: 2 settled USDC (12.5 + 5 = 17.5) + 1 settled ETH (0.8) → the
// payments-page chips read "17.5 USDC" and "0.8 ETH". Payee B: 1 failed.
const payments = [
  { id: "r15qa-p1", addr: A, label: "Coffee Buddy", token: "USDC", amount: "12.5", base: "12500000", status: "settled", tx: "0x" + "a1".repeat(32), createdAt: now - 8 * 60_000 },
  { id: "r15qa-p2", addr: A, label: "Coffee Buddy", token: "USDC", amount: "5", base: "5000000", status: "settled", tx: "0x" + "b2".repeat(32), createdAt: now - 26 * 3600_000 },
  { id: "r15qa-p3", addr: A, label: "Coffee Buddy", token: "ETH", amount: "0.8", base: "800000000000000000", status: "settled", tx: "0x" + "c3".repeat(32), createdAt: now - 3 * 24 * 3600_000 },
  { id: "r15qa-p4", addr: B, label: "Test Payee", token: "USDC", amount: "7", base: "7000000", status: "failed", tx: null, createdAt: now - 2 * 24 * 3600_000 },
];

const notifications = [
  // settled event → View-payment deep-link to r15qa-p1 (settled, repeatable too)
  { id: randomUUID(), title: "notifications.event.settled", message: JSON.stringify({ amount: "12.5", token: "USDC", recipient: "Coffee Buddy" }), type: "payment", read: 0, rel: "r15qa-p1", createdAt: now - 7 * 60_000 },
  // failed event → View-payment deep-link to r15qa-p4 (the retry case)
  { id: randomUUID(), title: "notifications.event.failed", message: JSON.stringify({ amount: "7", token: "USDC", recipient: "Test Payee" }), type: "payment", read: 1, rel: "r15qa-p4", createdAt: now - 2 * 24 * 3600_000 + 60_000 },
  // system row → no join, no buttons
  { id: randomUUID(), title: "System check complete", message: "Attestcoin watcher heartbeat OK", type: "system", read: 1, rel: null, createdAt: now - 30 * 60_000 },
];

const insC = db.prepare(
  "INSERT INTO contacts (id, label, address, note, favorite, last_used) VALUES (?, ?, ?, ?, ?, ?)",
);
const insP = db.prepare(
  `INSERT INTO payments (id, recipient_label, recipient_address, token, amount_human, amount_base_units, memo, status, tx_hash, chain_id, created_at, settled_at)
   VALUES (?, ?, ?, ?, ?, ?, 'R15QA', ?, ?, 11155111, ?, ?)`,
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
});
db.close();
