// R13-A live-verification cleanup: removes exactly the rows this round's
// seed script inserted (memo / note marker "R13QA"). Run with node.
import { openDb, runInTransaction } from "./qa-node-sqlite.mjs";

const db = openDb(process.argv[2]);

const delPayments = db.prepare("DELETE FROM payments WHERE memo = 'R13QA'");
const delContacts = db.prepare("DELETE FROM contacts WHERE note = 'R13QA' OR id LIKE 'r13qa-%'");
const delRecurring = db.prepare("DELETE FROM recurring_schedules WHERE id LIKE 'r13qa-%'");

runInTransaction(db, () => {
  const p = delPayments.run();
  const c = delContacts.run();
  const r = delRecurring.run();
  console.log("removed:", { payments: p.changes, contacts: c.changes, recurring: r.changes });
});
db.close();
