import { eq } from "drizzle-orm";
import { db, ensureDb } from "@/db";
import { agentSettings } from "@/db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Deploy policy (Phase 3 §5/§7): the session-spending mandate was REMOVED
// entirely (owner's C26) — the wallet signature is now the only confirmation
// for routine fund actions. What persists here are the two deploy-related
// per-user preferences that survive the mandate removal:
//
//   - mainnetDeployOptIn: contract deployment on mainnet chains sits behind
//     an explicit opt-in, off by default ([retained default], brief §7).
//   - dismissedCustomDeployWarning: the one-time custom-source generation
//     warning can be dismissed per user; the deployment confirmation itself
//     is never dismissible (hard boundary 5).
// ─────────────────────────────────────────────────────────────────────────────

export interface DeployPolicy {
  mainnetDeployOptIn: boolean;
  dismissedCustomDeployWarning: boolean;
}

export function getDeployPolicy(): DeployPolicy {
  ensureDb();
  const rows = db.select().from(agentSettings).where(eq(agentSettings.id, "local")).all();
  const row = rows[0];
  if (!row) {
    db.insert(agentSettings)
      .values({ id: "local", updatedAt: Date.now() })
      .onConflictDoNothing()
      .run();
    return { mainnetDeployOptIn: false, dismissedCustomDeployWarning: false };
  }
  return {
    mainnetDeployOptIn: row.mainnetDeployOptIn ?? false,
    dismissedCustomDeployWarning: row.dismissedCustomDeployWarning ?? false,
  };
}

export function updateDeployPolicy(patch: Partial<DeployPolicy>): DeployPolicy {
  ensureDb();
  const current = getDeployPolicy();
  db.update(agentSettings)
    .set({
      mainnetDeployOptIn: patch.mainnetDeployOptIn ?? current.mainnetDeployOptIn,
      dismissedCustomDeployWarning: patch.dismissedCustomDeployWarning ?? current.dismissedCustomDeployWarning,
      updatedAt: Date.now(),
    })
    .where(eq(agentSettings.id, "local"))
    .run();
  return getDeployPolicy();
}
