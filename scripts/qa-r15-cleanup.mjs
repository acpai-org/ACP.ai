// R15 cleanup: remove exactly the rows this round's seed inserted (marker R15QA).
import Database from "better-sqlite3";
const db = new Database(process.argv[2] ?? "sqlite.db");
const c = db.prepare("DELETE FROM contacts WHERE note = 'R15QA'").run();
const p = db.prepare("DELETE FROM payments WHERE memo = 'R15QA'").run();
const n = db.prepare("DELETE FROM notifications WHERE related_payment_id LIKE 'r15qa-%'").run();
console.log("deleted:", { contacts: c.changes, payments: p.changes, notifications: n.changes });
db.close();
