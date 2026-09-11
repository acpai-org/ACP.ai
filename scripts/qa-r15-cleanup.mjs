// R15 cleanup: remove exactly the rows this round's seed inserted (marker R15QA).
import { openDb } from "./qa-node-sqlite.mjs";
const db = openDb(process.argv[2]);
const c = db.prepare("DELETE FROM contacts WHERE note = 'R15QA'").run();
const p = db.prepare("DELETE FROM payments WHERE memo = 'R15QA'").run();
const n = db.prepare("DELETE FROM notifications WHERE related_payment_id LIKE 'r15qa-%'").run();
console.log("deleted:", { contacts: c.changes, payments: p.changes, notifications: n.changes });
db.close();
