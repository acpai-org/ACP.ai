// Raw-sqlite test helpers for the F9 seed-versioning suite. Opens a SECOND
// connection to the same temp DB (ACP_DB_PATH) so the tests can inspect and
// tamper with rows exactly as an app restart would see them.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.env.ACP_DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
// D11: finalize statements before env teardown (same Node 24 crash class as
// src/db/index.ts — second connection, same fix).
process.on("exit", () => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
});

/**
 * @returns {{ id: string, name: string, description: string, instructions: string,
 *   tool_allowlist: string | null, builtin: number, enabled: number,
 *   icon: string | null, created_at: number, seed_hash: string | null } | undefined}
 */
export function getRawSkill(id) {
  return db.prepare("SELECT id, name, description, instructions, tool_allowlist, builtin, enabled, icon, created_at, seed_hash FROM skills WHERE id = ?").get(id);
}

/**
 * Overwrite selected columns — used to forge legacy / user-owned row states.
 * @param {string} id
 * @param {Record<string, unknown>} patch
 * @returns {void}
 */
export function setLegacySkill(id, patch) {
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(patch)) {
    fields.push(`${key} = ?`);
    values.push(value);
  }
  values.push(id);
  db.prepare(`UPDATE skills SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

/** @returns {number} */
export function countSkills() {
  return db.prepare("SELECT COUNT(*) AS n FROM skills").get().n;
}
