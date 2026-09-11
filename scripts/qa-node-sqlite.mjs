// Shared QA-script utilities over Node's built-in node:sqlite.
// node:sqlite's DatabaseSync has no .pragma()/.transaction() conveniences —
// these helpers wrap the equivalent SQL so the QA seed/cleanup scripts stay
// behaviorally 1:1 with their former better-sqlite3 versions.
import { DatabaseSync } from "node:sqlite";

/** Open the QA database (default ./sqlite.db) with WAL journaling. */
export function openDb(path) {
  const db = new DatabaseSync(path ?? "sqlite.db");
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}

/**
 * Synchronous transaction wrapper — same semantics as better-sqlite3's
 * db.transaction(fn)(): runs fn inside BEGIN/COMMIT, ROLLBACKs on throw.
 * @template T
 * @param {DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 */
export function runInTransaction(db, fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
