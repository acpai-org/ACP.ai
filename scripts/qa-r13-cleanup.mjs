// R13-A live-verification cleanup: removes exactly the rows this round's
// seed script inserted (memo / note marker "R13QA"). Run with node.
import Database from "better-sqlite3";

const db = new Database(process.argv[2] ?? "sqlite.db");
db.pragma("journal_mode = WAL");

const delPayments = db.prepare("DELETE FROM payments WHERE memo = 'R13QA'");
const delContacts = db.prepare("DELETE FROM contacts WHERE note = 'R13QA' OR id LIKE 'r13qa-%'");
const delRecurring = db.prepare("DELETE FROM recurring_schedules WHERE id LIKE 'r13qa-%'");

const tx = db.transaction(() => {
  const p = delPayments.run();
  const c = delContacts.run();
  const r = delRecurring.run();
  console.log("removed:", { payments: p.changes, contacts: c.changes, recurring: r.changes });
});
tx();
db.close();
