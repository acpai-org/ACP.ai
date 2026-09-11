// R14 live-verification seed: 2 contacts + 4 payments (per-token settled mix)
// + 5 notifications (settled/failed/settling events, orphaned reference,
// system row) so the notifications→payment join, repeat intents, event-tone
// icons, contacts settled-totals chips, and the recurring empty-state chips
// can all be exercised in a real browser. Run with node. Rows carry the QA
// marker "R14QA" so the cleanup pass can delete exactly what this script
// inserted.
import { openDb, runInTransaction } from "./qa-node-sqlite.mjs";
import { randomUUID } from "node:crypto";

const db = openDb(process.argv[2]);

const now = Date.now();
const A = "0x9f8a7B6c5D4e3F2a1B0c9D8e7F6a5B4c3D2e1F0a";
const B = "0xAbCdef0000000000000000000000000000000123";

const contacts = [
  { id: "r14qa-c1", label: "Coffee Buddy", address: A, note: "R14QA", favorite: 1, lastUsed: 0 },
  { id: "r14qa-c2", label: "Test Payee", address: B, note: "R14QA", favorite: 0, lastUsed: 0 },
];

// Payee A: 2 settled USDC + 1 settled ETH (proves per-token totals), 1
// pending USDC (the in-flight no-repeat case). Payee B: 1 failed row.
const payments = [
  { id: "r14qa-p1", addr: A, label: "Coffee Buddy", token: "USDC", amount: "12.5", base: "12500000", status: "settled", tx: "0x" + "a1".repeat(32), createdAt: now - 8 * 60_000 },
  { id: "r14qa-p2", addr: A, label: "Coffee Buddy", token: "USDC", amount: "5", base: "5000000", status: "settled", tx: "0x" + "b2".repeat(32), createdAt: now - 26 * 3600_000 },
  { id: "r14qa-p3", addr: A, label: "Coffee Buddy", token: "ETH", amount: "0.8", base: "800000000000000000", status: "settled", tx: "0x" + "c3".repeat(32), createdAt: now - 3 * 24 * 3600_000 },
  { id: "r14qa-p4", addr: A, label: "Coffee Buddy", token: "USDC", amount: "3", base: "3000000", status: "pending", tx: null, createdAt: now - 4 * 60_000 },
  { id: "r14qa-p5", addr: B, label: "Test Payee", token: "USDC", amount: "7", base: "7000000", status: "failed", tx: null, createdAt: now - 2 * 24 * 3600_000 },
];

const notifications = [
  // unread settled event → success Check icon + Pay-again on a settled row
  { id: randomUUID(), title: "notifications.event.settled", message: JSON.stringify({ amount: "12.5", token: "USDC", recipient: "Coffee Buddy" }), type: "payment", read: 0, rel: "r14qa-p1", createdAt: now - 7 * 60_000 },
  // READ failed event → danger X icon + Pay-again (retry) on a failed row
  { id: randomUUID(), title: "notifications.event.failed", message: JSON.stringify({ amount: "7", token: "USDC", recipient: "Test Payee" }), type: "payment", read: 1, rel: "r14qa-p5", createdAt: now - 2 * 24 * 3600_000 + 60_000 },
  // settling event → primary Bell icon, NO Pay-again (payment in flight)
  { id: randomUUID(), title: "notifications.event.settling", message: JSON.stringify({ amount: "3", token: "USDC", recipient: "Coffee Buddy" }), type: "payment", read: 0, rel: "r14qa-p4", createdAt: now - 3 * 60_000 },
  // attested event → ShieldCheck icon + Pay-again (payment settled)
  { id: randomUUID(), title: "notifications.event.attested", message: JSON.stringify({ amount: "5", token: "USDC", recipient: "Coffee Buddy" }), type: "payment", read: 1, rel: "r14qa-p2", createdAt: now - 20 * 3600_000 },
  // orphaned reference (payment deleted) → honest record, no action button
  { id: randomUUID(), title: "notifications.event.settled", message: JSON.stringify({ amount: "9", token: "USDC", recipient: "Ghost Payee" }), type: "payment", read: 1, rel: "r14qa-ghost", createdAt: now - 5 * 24 * 3600_000 },
  // system row, no payment link → no join, no action
  { id: randomUUID(), title: "notifications.event.initiated", message: JSON.stringify({ amount: "12.5", token: "USDC", recipient: "Coffee Buddy" }), type: "payment", read: 1, rel: "r14qa-p1", createdAt: now - 9 * 60_000 },
  { id: randomUUID(), title: "System check complete", message: "Attestcoin watcher heartbeat OK", type: "system", read: 1, rel: null, createdAt: now - 30 * 60_000 },
];

const insC = db.prepare(
  "INSERT INTO contacts (id, label, address, note, favorite, last_used) VALUES (?, ?, ?, ?, ?, ?)",
);
const insP = db.prepare(
  `INSERT INTO payments (id, recipient_label, recipient_address, token, amount_human, amount_base_units, memo, status, tx_hash, chain_id, created_at, settled_at)
   VALUES (?, ?, ?, ?, ?, ?, 'R14QA', ?, ?, 11155111, ?, ?)`,
);
const insN = db.prepare(
  "INSERT INTO notifications (id, title, message, type, read, related_payment_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
);

runInTransaction(db, () => {
  for (const c of contacts) insC.run(c.id, c.label, c.address, c.note, c.favorite, c.lastUsed);
  for (const p of payments) insP.run(p.id, p.label, p.addr, p.token, p.amount, p.base, p.status, p.tx, p.createdAt, p.status === "settled" ? p.createdAt + 60_000 : null);
  for (const n of notifications) insN.run(n.id, n.title, n.message, n.type, n.read, n.rel, n.createdAt);
});

console.log("seeded:", {
  contacts: contacts.length,
  payments: payments.length,
  notifications: notifications.length,
});
db.close();
