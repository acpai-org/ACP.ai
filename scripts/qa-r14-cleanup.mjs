// R14 live-verification cleanup (T4, deferred #5): removes exactly the rows
// qa-r14-seed.mjs inserted. Markers: contacts carry note "R14QA" / id prefix
// "r14qa-"; payments carry memo "R14QA"; notifications reference
// related_payment_id LIKE 'r14qa-%' plus the seed's distinctive system
// heartbeat row. Run with node (same optional DB path argument as the seed).
import { openDb, runInTransaction } from "./qa-node-sqlite.mjs";

const db = openDb(process.argv[2]);

const delNotifications = db.prepare(
  "DELETE FROM notifications WHERE related_payment_id LIKE 'r14qa-%' OR (title = 'System check complete' AND message = 'Attestcoin watcher heartbeat OK')",
);
const delPayments = db.prepare("DELETE FROM payments WHERE memo = 'R14QA' OR id LIKE 'r14qa-%'");
const delContacts = db.prepare("DELETE FROM contacts WHERE note = 'R14QA' OR id LIKE 'r14qa-%'");

runInTransaction(db, () => {
  // Notifications first — their related_payment_id points at the payment rows
  // deleted right after (no FK, but deleting in this order keeps the log honest).
  const n = delNotifications.run();
  const p = delPayments.run();
  const c = delContacts.run();
  console.log("removed:", { notifications: n.changes, payments: p.changes, contacts: c.changes });
});
db.close();
