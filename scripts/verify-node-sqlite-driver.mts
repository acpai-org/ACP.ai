// Driver conformance test for src/db/node-sqlite-driver.ts.
// Verifies EVERY drizzle query path the app uses, plus transaction semantics,
// plus read-compatibility with a database file written by better-sqlite3
// (zero data migration claim). Run: node --import tsx scripts/verify-node-sqlite-driver.mts
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, and, desc, isNull, or } from "drizzle-orm";
import { drizzle } from "../src/db/node-sqlite-driver";
import { contacts, payments, skills } from "../src/db/schema";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✔ ${name}`);
  } else {
    failures++;
    console.error(`  ✘ ${name}`, extra ?? "");
  }
}

const dir = mkdtempSync(path.join(tmpdir(), "acp-driver-verify-"));
const dbPath = path.join(dir, "verify.db");
const client = new DatabaseSync(dbPath);
client.exec("PRAGMA journal_mode = WAL");
client.exec("PRAGMA foreign_keys = ON");

// ── Create the app's real schema (subset covering all column shapes) ──────
client.exec(`
  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    address TEXT NOT NULL UNIQUE,
    note TEXT DEFAULT '',
    favorite INTEGER NOT NULL DEFAULT 0,
    last_used INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE payments (
    id TEXT PRIMARY KEY,
    recipient_label TEXT,
    recipient_address TEXT NOT NULL,
    token TEXT NOT NULL DEFAULT 'USDC',
    token_address TEXT,
    amount_human TEXT NOT NULL,
    amount_base_units TEXT NOT NULL,
    memo TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    tx_hash TEXT,
    chain_id INTEGER NOT NULL DEFAULT 11155111,
    sender_address TEXT,
    created_at INTEGER NOT NULL,
    settled_at INTEGER,
    attested_at INTEGER,
    attest_root TEXT,
    onchain_verified_at INTEGER,
    cc3_tx_hash TEXT
  );
  CREATE TABLE skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    instructions TEXT NOT NULL,
    tool_allowlist TEXT,
    builtin INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    icon TEXT,
    created_at INTEGER NOT NULL,
    seed_hash TEXT
  );
`);

const db = drizzle(client, { schema: { contacts, payments, skills } });

// ── 1. INSERT via drizzle (.run()) with boolean-mode columns ───────────────
const now = Date.now();
const ins1 = db
  .insert(contacts)
  .values({ id: "c1", label: "Alice", address: "0xAAA1", note: "first", favorite: true, lastUsed: now })
  .run();
check("insert().run() returns { changes: 1 }", ins1.changes === 1, ins1);
db.insert(contacts)
  .values({ id: "c2", label: "Bob", address: "0xBBB2", favorite: false, lastUsed: now - 1000 })
  .run();
db.insert(contacts)
  .values({ id: "c3", label: "Carol", address: "0xCCC3", favorite: true, lastUsed: now - 2000 })
  .run();

// ── 2. SELECT all with fields (array-mode + mapResultRow) ──────────────────
const allContacts = db.select().from(contacts).all();
check("select().all() returns all rows", allContacts.length === 3, allContacts.length);
check(
  "boolean-mode column reads back as true/false (not 1/0)",
  allContacts[0].favorite === true && allContacts[1].favorite === false,
  { a: allContacts[0].favorite, b: allContacts[1].favorite },
);
check("text column round-trips", allContacts[0].label === "Alice");

// ── 3. .get() with fields (raw().get() path — array mode single row) ───────
const got = db.select().from(contacts).where(eq(contacts.id, "c2")).get();
check("select().where().get() returns row", got?.id === "c2" && got?.label === "Bob", got);
const gotMissing = db.select().from(contacts).where(eq(contacts.id, "nope")).get();
check("select().get() miss returns undefined", gotMissing === undefined, gotMissing);

// ── 4. orderBy + limit (values()/raw().all() path) ─────────────────────────
const ordered = db.select().from(contacts).orderBy(desc(contacts.lastUsed)).limit(2).all();
check("orderBy desc + limit respected", ordered.length === 2 && ordered[0].id === "c1" && ordered[1].id === "c2", ordered.map((r) => r.id));

// ── 5. UPDATE with boolean + where, changes count ──────────────────────────
const upd = db.update(contacts).set({ favorite: false, note: "upd" }).where(eq(contacts.id, "c1")).run();
check("update().run() changes === 1", upd.changes === 1, upd);
const reRead = db.select().from(contacts).where(eq(contacts.id, "c1")).get();
check("updated boolean persisted (true→false)", reRead?.favorite === false, reRead);

// ── 6. Compound WHERE (and/or/isNull) — parameter binding order ────────────
db.insert(payments)
  .values({ id: "p1", recipientAddress: "0xAAA1", amountHuman: "1.5", amountBaseUnits: "1500000", status: "settled", createdAt: now, txHash: "0x11" })
  .run();
db.insert(payments)
  .values({ id: "p2", recipientAddress: "0xBBB2", amountHuman: "2.5", amountBaseUnits: "2500000", status: "pending", createdAt: now - 5000 })
  .run();
const settledWithTx = db
  .select()
  .from(payments)
  .where(and(eq(payments.status, "settled"), isNull(payments.attestedAt)))
  .all();
check("and(eq, isNull) matches only p1", settledWithTx.length === 1 && settledWithTx[0].id === "p1");
const orMatch = db
  .select()
  .from(payments)
  .where(or(eq(payments.id, "p1"), eq(payments.id, "p2")))
  .all();
check("or() matches both", orMatch.length === 2);
const nullField = db.select().from(payments).where(eq(payments.id, "p2")).get();
check("un-set nullable column reads undefined/null", nullField?.txHash === null && nullField?.settledAt === null, nullField);

// ── 7. DELETE with changes ─────────────────────────────────────────────────
const del = db.delete(contacts).where(eq(contacts.id, "c3")).run();
check("delete().run() changes === 1", del.changes === 1, del);

// ── 8. COUNT-style select of partial fields (custom mapper path) ──────────
const count = db.select({ id: contacts.id }).from(contacts).all().length;
check("partial-field select works", count === 2, count);

// ── 9. Transactions: COMMIT / ROLLBACK / savepoint ─────────────────────────
try {
  db.transaction((tx) => {
    tx.insert(skills).values({ id: "s1", name: "sk", description: "d", instructions: "i", builtin: true, enabled: true, createdAt: now }).run();
    tx.insert(skills).values({ id: "s2", name: "sk2", description: "d", instructions: "i", builtin: false, enabled: true, createdAt: now }).run();
  });
  check("transaction COMMIT persists both rows", db.select().from(skills).all().length === 2);
} catch (e) {
  check("transaction COMMIT persists both rows", false, e);
}
try {
  db.transaction((tx) => {
    tx.insert(skills).values({ id: "s3", name: "sk3", description: "d", instructions: "i", createdAt: now }).run();
    throw new Error("boom");
  });
  check("transaction ROLLBACK discards (throw propagates)", false, "should have thrown");
} catch (e) {
  check("transaction ROLLBACK discards on throw", (e as Error).message === "boom");
  check("rolled-back row absent", db.select().from(skills).where(eq(skills.id, "s3")).all().length === 0);
}
// nested savepoints
try {
  db.transaction((tx) => {
    tx.insert(skills).values({ id: "s4", name: "sk4", description: "d", instructions: "i", createdAt: now }).run();
    try {
      tx.transaction((tx2) => {
        tx2.insert(skills).values({ id: "s5", name: "sk5", description: "d", instructions: "i", createdAt: now }).run();
        throw new Error("inner");
      });
    } catch {
      /* inner rollback expected */
    }
  });
  const ids = db.select({ id: skills.id }).from(skills).all().map((r) => r.id).sort();
  check("nested savepoint: outer row kept, inner rolled back", ids.join(",") === "s1,s2,s4", ids);
} catch (e) {
  check("nested savepoint semantics", false, e);
}

// ── 10. WAL + concurrency: second connection sees committed data ──────────
const reader = new DatabaseSync(dbPath);
const fromSecond = reader.prepare("SELECT COUNT(*) AS n FROM contacts").get() as { n: number };
check("second connection (WAL) sees committed rows", fromSecond.n === 2, fromSecond);
reader.close();

// ── 11. File compatibility: better-sqlite3-written DB opens with node:sqlite
// (created by /tmp/bs3-compat-db generator in the outer script)
const compatPath = process.env.BS3_COMPAT_DB;
if (compatPath) {
  const compat = new DatabaseSync(compatPath);
  const row = compat.prepare("SELECT id, label, favorite FROM bs3_table WHERE id = ?").get("x1") as
    | { id: string; label: string; favorite: number }
    | undefined;
  check("better-sqlite3-written file readable (WAL across drivers)", row?.id === "x1" && row?.label === "from-bs3" && row?.favorite === 1, row);
  compat.close();
} else {
  console.log("  ℹ skipping better-sqlite3 file-compat check (no BS3_COMPAT_DB)");
}

client.close();
rmSync(dir, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\nDRIVER VERIFICATION FAILED: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nALL DRIVER CONFORMANCE CHECKS PASSED");
