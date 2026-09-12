import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { drizzle, type NodeSqliteDatabase } from "@/db/node-sqlite-driver";
import { contacts, payments, notifications, recurringSchedules, agentSettings, agentActions, skills, automationRules } from "@/db/schema";

export type AppDatabase = NodeSqliteDatabase<{
  contacts: typeof contacts;
  payments: typeof payments;
  notifications: typeof notifications;
  recurringSchedules: typeof recurringSchedules;
  agentSettings: typeof agentSettings;
  agentActions: typeof agentActions;
  skills: typeof skills;
  automationRules: typeof automationRules;
}>;

// DB path: overridable via ACP_DB_PATH (tests isolate their DB this way —
// chdir would break the contracts/ compile service's relative paths).
// Serverless hosts (Vercel, Netlify) only give each function a writable
// /tmp — point the file there (data lifetime follows the platform's rules).
const DB_PATH = process.env.ACP_DB_PATH ?? (process.env.VERCEL || process.env.NETLIFY ? "/tmp/sqlite.db" : path.join(process.cwd(), "sqlite.db"));

const globalForDb = globalThis as unknown as {
  __sqlite?: DatabaseSync;
  __db?: AppDatabase;
};

const sqlite =
  globalForDb.__sqlite ??
  (() => {
    const instance = new DatabaseSync(DB_PATH);
    instance.exec("PRAGMA journal_mode = WAL");
    // D12 fix: WAL without a busy timeout throws SQLITE_BUSY IMMEDIATELY when
    // a second writer holds the lock (test scripts, qa seeds, dev restart
    // races) — node:sqlite's default busy_timeout is 0. 5s is the standard
    // pairing with WAL: writers queue instead of erroring.
    instance.exec("PRAGMA busy_timeout = 5000");
    instance.exec("PRAGMA foreign_keys = ON");
    // D11 (Node 24 teardown race): Statements prepared by ensureDb() become
    // garbage immediately; if GC hasn't reclaimed them by process exit, their
    // native destructors run AFTER environment teardown started and crash
    // (RemoveEnvironmentCleanupHook assertion — flaky 3/5 measured in the test
    // runner). Closing the connection on 'exit' finalizes every statement
    // BEFORE teardown, deterministically. Registered only where the instance
    // is created (HMR re-evaluations reuse globalThis and never re-register).
    process.on("exit", () => {
      try {
        instance.close();
      } catch {
        /* already closed */
      }
    });
    return instance;
  })();

if (!globalForDb.__sqlite) {
  globalForDb.__sqlite = sqlite;
}

export const db: AppDatabase =
  globalForDb.__db ??
  drizzle(sqlite, {
    schema: {
      contacts,
      payments,
      notifications,
      recurringSchedules,
      agentSettings,
      agentActions,
      skills,
      automationRules,
    },
  });

if (!globalForDb.__db) {
  globalForDb.__db = db;
}

let initialized = false;

/** Test-only: drop the init latch so the next ensureDb() re-runs its
 *  migrations + seed against the SAME connection (the F9 seed-versioning
 *  tests use this to simulate app restarts). Never call from app code. */
export function __resetDbInitForTests(): void {
  initialized = false;
}

export function ensureDb(): void {
  if (initialized) return;

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS payments (
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
      attest_root TEXT
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      address TEXT NOT NULL UNIQUE,
      note TEXT DEFAULT '',
      favorite INTEGER NOT NULL DEFAULT 0,
      last_used INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'system',
      read INTEGER NOT NULL DEFAULT 0,
      related_payment_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
    CREATE INDEX IF NOT EXISTS idx_contacts_last_used ON contacts(last_used DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
    CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);

    CREATE TABLE IF NOT EXISTS recurring_schedules (
      id TEXT PRIMARY KEY,
      recipient_label TEXT,
      recipient_address TEXT NOT NULL,
      token TEXT NOT NULL DEFAULT 'USDC',
      token_address TEXT,
      amount_human TEXT NOT NULL,
      amount_base_units TEXT NOT NULL,
      cadence TEXT NOT NULL,
      chain_id INTEGER,
      next_fire_at INTEGER NOT NULL,
      last_fire_at INTEGER,
      executions INTEGER NOT NULL DEFAULT 0,
      max_executions INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      last_status TEXT,
      schedule_id_hash TEXT NOT NULL,
      sender_address TEXT,
      created_at INTEGER NOT NULL,
      user_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_recurring_active ON recurring_schedules(active);
    CREATE INDEX IF NOT EXISTS idx_recurring_next_fire ON recurring_schedules(next_fire_at);
    CREATE INDEX IF NOT EXISTS idx_recurring_created ON recurring_schedules(created_at DESC);

    CREATE TABLE IF NOT EXISTS agent_settings (
      id TEXT PRIMARY KEY DEFAULT 'local',
      mainnet_deploy_opt_in INTEGER NOT NULL DEFAULT 0,
      dismissed_custom_deploy_warning INTEGER NOT NULL DEFAULT 0,
      active_chain_keys TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_actions (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      call_id TEXT,
      tool TEXT NOT NULL,
      params_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      chain_id INTEGER,
      usd_value_cents INTEGER,
      risk_class TEXT NOT NULL DEFAULT 'read',
      confirmation_required INTEGER NOT NULL DEFAULT 0,
      result_json TEXT,
      source_tx_hash TEXT,
      cc3_tx_hash TEXT,
      attest_root TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_agent_actions_created ON agent_actions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_actions_run ON agent_actions(run_id);

    CREATE TABLE IF NOT EXISTS skills (
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

    CREATE TABLE IF NOT EXISTS automation_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      trigger_config_json TEXT NOT NULL,
      action_json TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      last_fired_at INTEGER,
      last_status TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  // Phase 3 (C3): call_id column for the live lifecycle overlay join.
  try {
    const actionCols = sqlite.prepare("PRAGMA table_info(agent_actions)").all() as { name: string }[];
    if (!actionCols.some((c) => c.name === "call_id")) {
      sqlite.exec("ALTER TABLE agent_actions ADD COLUMN call_id TEXT");
    }
  } catch { /* fresh table already has it */ }

  // Phase 3 (C26): the session mandate feature was removed — drop the retired
  // table if an older database still carries it (idempotent, harmless fresh).
  sqlite.exec("DROP TABLE IF EXISTS session_mandates");

  // Idempotent column migrations for DBs created before the Phase-2
  // attestation fields existed (CREATE TABLE IF NOT EXISTS won't add them).
  try {
    const paymentCols = sqlite.prepare("PRAGMA table_info(payments)").all() as { name: string }[];
    const paymentColNames = new Set(paymentCols.map((c) => c.name));
    if (!paymentColNames.has("attested_at")) {
      sqlite.exec("ALTER TABLE payments ADD COLUMN attested_at INTEGER");
    }
    if (!paymentColNames.has("attest_root")) {
      sqlite.exec("ALTER TABLE payments ADD COLUMN attest_root TEXT");
    }
    if (!paymentColNames.has("onchain_verified_at")) {
      sqlite.exec("ALTER TABLE payments ADD COLUMN onchain_verified_at INTEGER");
    }
    if (!paymentColNames.has("cc3_tx_hash")) {
      sqlite.exec("ALTER TABLE payments ADD COLUMN cc3_tx_hash TEXT");
    }
  } catch {
    // non-critical — reads/writes of the new columns will fail loudly in dev
  }

  // Phase-2 recurring executor columns (same pattern).
  try {
    const recurringCols = sqlite.prepare("PRAGMA table_info(recurring_schedules)").all() as { name: string }[];
    const recurringColNames = new Set(recurringCols.map((c) => c.name));
    if (!recurringColNames.has("chain_id")) {
      sqlite.exec("ALTER TABLE recurring_schedules ADD COLUMN chain_id INTEGER");
    }
    if (!recurringColNames.has("last_status")) {
      sqlite.exec("ALTER TABLE recurring_schedules ADD COLUMN last_status TEXT");
    }
  } catch {
    // non-critical
  }

  fixStuckSettling();
  // N31 one-time default migration (schema version 1): builtin rows seeded
  // before N31 carry enabled=0 from the old seed default. The skills UI was
  // unreachable (the /api/skills routes never existed) until this change, so
  // no enabled state could have been user-set — flipping the stale default is
  // honest, not an override. Guarded by PRAGMA user_version so it runs exactly
  // once per database file; later user choices are never clobbered.
  if ((sqlite.prepare("PRAGMA user_version").get() as { user_version: number }).user_version < 1) {
    sqlite
      .prepare("UPDATE skills SET enabled = 1 WHERE builtin = 1 AND enabled = 0")
      .run();
    sqlite.exec("PRAGMA user_version = 1");
  }
  // P17.2 one-time data migration (schema version 2): recurring schedules
  // created through the AGENT tool (Phase ≤3) stored createdAt in epoch
  // SECONDS while every other writer (and the view's formatter) uses epoch
  // MILLISECONDS — those rows rendered as fake "Jan 21, 1970" dates. Seconds
  // values are unambiguous (< 1e12 for any realistic epoch), so multiply once.
  if ((sqlite.prepare("PRAGMA user_version").get() as { user_version: number }).user_version < 2) {
    sqlite
      .prepare(
        "UPDATE recurring_schedules SET created_at = created_at * 1000 WHERE created_at > 0 AND created_at < 1000000000000",
      )
      .run();
    sqlite.exec("PRAGMA user_version = 2");
  }
  seedBuiltinSkills();

  initialized = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Builtin skill seeding with VERSIONING (F9, D.6 audit).
//
// Old behavior: INSERT only when the id was missing — a fix to a builtin's
// instructions/allowlist never reached databases that already had the row.
// New behavior: every builtin spec carries a content hash (sha256 over the
// spec's content fields). On boot:
//   - row missing            → INSERT (enabled=0) with the spec hash
//   - row is a user skill    → skip (never touch; ids can't collide in practice)
//   - row is builtin and its stored seed_hash ≠ current spec hash → refresh
//     the CONTENT (name/description/instructions/allowlist/icon) + hash.
//     `enabled` is NEVER touched — activation is the user's call, and a
//     refresh must not re-activate a skill the user deliberately turned off.
//   - legacy rows (seed_hash NULL) hash-differ from the current spec → they
//     were seeded by an older version (builtins cannot be edited in the UI),
//     so the refresh path adopts them too — that's how F3's allowlist fix
//     lands on existing databases.
// ─────────────────────────────────────────────────────────────────────────────

interface BuiltinSkillSpec {
  id: string;
  name: string;
  description: string;
  instructions: string;
  /** JSON string of allowed tool names (null = all tools). */
  toolAllowlist: string | null;
  icon: string;
}

const BUILTIN_SKILL_SPECS: BuiltinSkillSpec[] = [
  {
    id: "skill-exact-payer",
    name: "Exact-change payer",
    description:
      "Before any transfer, verify the recipient's address character-by-character and echo the full address + amount in your reply. Prefer asking over assuming.",
    instructions:
      "When paying: 1) restate the recipient's FULL 0x address and the exact amount in your reply before calling transfer; 2) if the user gave only a name, resolve it via list_contacts and show the address; 3) refuse transfers where the address is uncertain. Double-check decimals for USDC (6) vs ETH-style (18).",
    // F3 (D.6 audit): the instructions tell the agent to resolve names via
    // contacts — the allowlist must actually include list_contacts, or the
    // skill is incoherent with its own guidance.
    toolAllowlist: JSON.stringify(["transfer", "get_balances", "batch_transfer", "list_contacts"]),
    icon: "target",
  },
  {
    id: "skill-attestcoin-operator",
    name: "Attestcoin flow operator",
    description:
      "Guides the full conditional-release and cross-chain-swap flows: lock, attestation wait, proof-backed release — with status narration at every step.",
    instructions:
      "For conditional-release or swap requests: 1) lay out the multi-step plan FIRST (lock → wait for Attestcoin attestation → on-chain verified release); 2) call check_attestation_status before waiting; 3) narrate each step as it executes; 4) after release, report the source tx hash, the Creditcoin tx hash and the Merkle root. Never claim a release happened without a tx hash.",
    toolAllowlist: null,
    icon: "shield",
  },
  {
    id: "skill-thrifty",
    name: "Thrifty router",
    description:
      "Prefers the cheapest path: checks balances across all active chains, warns about mainnet spends, and suggests testnets for experiments.",
    instructions:
      "When the user wants to move or experiment with funds: 1) call get_balances across their active chains; 2) recommend executing on testnets when the request is a test/demo; 3) flag any mainnet action explicitly with its USD-equivalent value; 4) mention gas considerations.",
    toolAllowlist: JSON.stringify(["get_balances", "transfer", "get_transaction_status", "check_attestation_status"]),
    icon: "leaf",
  },
  // ── Wave 2 builtins (D.6 candidate skills — every one composes the FIXED
  //    toolset; allowlists only NARROW, per §12) ─────────────────────────────
  {
    id: "skill-balance-digest",
    name: "Balance digest",
    description:
      "Opens any money conversation with a compact cross-chain digest: balances grouped by chain, dust flagged, testnet vs mainnet clearly separated.",
    instructions:
      "When the user asks about balances, holdings or 'how much do I have': 1) call get_balances with chain=null to cover all active chains; 2) present a compact digest grouped by chain with the nominal USD equivalent where known; 3) flag dust balances (under ~$1 nominal) as dust instead of padding the list; 4) always label testnet balances as testnet; 5) if a chain query fails, report that chain as unavailable instead of guessing.",
    toolAllowlist: JSON.stringify(["get_balances", "list_chains"]),
    icon: "chart",
  },
  {
    id: "skill-network-reporter",
    name: "Network reporter",
    description:
      "Answers oracle-freshness questions with live data: attested heights, source-chain heads, lag in human terms, and what that means for proofs right now.",
    instructions:
      "When the user asks about Attestcoin/Oracle status, freshness or lag: 1) call attestcoin_network_status; 2) report attested height vs each source chain's head and translate the block gap into approximate wait time ('a few minutes'); 3) state plainly whether proofs for a just-sent transaction are available RIGHT NOW or not yet; 4) call list_chains when asked which chains are covered. Never estimate lag without the live call.",
    toolAllowlist: JSON.stringify(["attestcoin_network_status", "list_chains"]),
    icon: "radio",
  },
  {
    id: "skill-testnet-guardian",
    name: "Testnet guardian",
    description:
      "A safety rail for fund movements: names mainnet spends with their USD value, requires explicit mainnet intent, and steers experiments to testnets.",
    instructions:
      "Before ANY transfer or batch_transfer to a MAINNET chain (Ethereum, Base, Arbitrum, Optimism, Polygon, BNB): 1) say MAINNET explicitly and state the USD-equivalent value; 2) if the request smells like a test, demo or experiment, propose the testnet equivalent first (Sepolia / Creditcoin Testnet); 3) if the user's intent is ambiguous between test and real funds, ASK before calling the tool; 4) never silently substitute a different chain than the user asked for.",
    toolAllowlist: JSON.stringify(["transfer", "batch_transfer", "get_balances", "list_chains"]),
    icon: "flask",
  },
  {
    id: "skill-token-discipline",
    name: "Token discipline",
    description:
      "Decimal and symbol sanity for every send: right token, right decimals, right magnitude — asks instead of substituting when a token doesn't resolve.",
    instructions:
      "On every transfer: 1) resolve the token symbol carefully — USDC/USDT use 6 decimals, ETH-style natives use 18; 2) when the user gives a 0x contract address as the token, echo which token that address is; 3) sanity-check the amount's magnitude (0.05 vs 50) against the user's phrasing and the balance; 4) if the named token isn't known on the target chain, say so — never substitute a lookalike symbol. When in doubt, ask.",
    toolAllowlist: JSON.stringify(["get_balances", "transfer", "list_chains"]),
    icon: "scale",
  },
  {
    id: "skill-action-narrator",
    name: "Action log narrator",
    description:
      "Narrates 'what did you do' questions from the real action log — one plain sentence per action, tx hashes included, nothing invented.",
    instructions:
      "When the user asks what you did, their history, or recent activity: 1) call list_recent_actions (raise the limit when they ask for a full day); 2) narrate each action in one plain sentence — what, when, outcome, and the tx hash when there is one; 3) group consecutive retries or failures honestly ('three attempts, all reverted'); 4) NEVER describe an action that is not in the log — if the log is empty, say so.",
    toolAllowlist: JSON.stringify(["list_recent_actions", "get_transaction_status"]),
    icon: "history",
  },
  {
    id: "skill-attestation-sentinel",
    name: "Attestation sentinel",
    description:
      "Watches pending Attestcoin proofs like a hawk: honest bracket reporting, bounded waits with live progress, and no 'verified' claims without the precompile verdict.",
    instructions:
      "When a transaction's Attestcoin proof is pending: 1) call check_attestation_status and report the honest bracket (attested height, the tx's block, the gap); 2) if the user wants to wait, call wait_for_attestation with an explicit bound and narrate progress; 3) after any wait, re-check before claiming success — only the on-chain VERIFIED verdict counts; 4) for a transaction that just won't attest, say so and suggest checking network status rather than looping forever.",
    toolAllowlist: JSON.stringify(["check_attestation_status", "wait_for_attestation", "get_transaction_status"]),
    icon: "radar",
  },
  {
    id: "skill-payroll-dispatcher",
    name: "Payroll dispatcher",
    description:
      "Multi-recipient payouts done carefully: resolves everyone against contacts first, lays out a who/amount table, and offers standing schedules for regular payroll.",
    instructions:
      "For payroll or multi-recipient payout requests: 1) resolve every recipient name via list_contacts before anything else and surface any unresolved names; 2) present the full plan as a table (who, address, amount, token, chain) and get an explicit go-ahead; 3) execute with batch_transfer on a single chain; 4) for standing payroll, offer create_recurring_payment with the right cadence instead of ad-hoc batches; 5) ask about max executions when the payroll has an end date.",
    toolAllowlist: JSON.stringify(["batch_transfer", "transfer", "list_contacts", "create_recurring_payment"]),
    icon: "users",
  },
  {
    id: "skill-subscription-manager",
    name: "Subscription manager",
    description:
      "Turns 'pay my rent every month' into honest recurring schedules: cadence, catch-up semantics and end dates stated up front.",
    instructions:
      "When the user mentions subscriptions, rent, retainers or any repeating bill: 1) propose create_recurring_payment with the cadence that matches their phrasing (monthly, weekly, or a custom interval); 2) state the execution model honestly — runs while the app is open with the wallet connected, and anything missed while away executes at the next connect; 3) when there's an end date, set maxExecutions instead of leaving it open-ended; 4) confirm recipient, token, amount and chain before creating. Never create a schedule the user didn't ask for.",
    toolAllowlist: JSON.stringify(["create_recurring_payment", "list_recent_actions"]),
    icon: "calendar",
  },
];

/** Stable content hash of a builtin spec — `enabled` is deliberately absent
 *  (it's user state, not seed content) so toggling never triggers a refresh. */
function hashSkillSpec(spec: BuiltinSkillSpec): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        spec.name,
        spec.description,
        spec.instructions,
        spec.toolAllowlist,
        spec.icon,
      ]),
    )
    .digest("hex");
}

/** Idempotent, versioned seed of the built-in skill library (F9). */
function seedBuiltinSkills(): void {
  try {
    // F9: seed_hash column for DBs created before versioning existed.
    try {
      const skillCols = sqlite.prepare("PRAGMA table_info(skills)").all() as { name: string }[];
      if (!skillCols.some((c) => c.name === "seed_hash")) {
        sqlite.exec("ALTER TABLE skills ADD COLUMN seed_hash TEXT");
      }
    } catch {
      /* fresh table already has it */
    }

    for (const spec of BUILTIN_SKILL_SPECS) {
      const hash = hashSkillSpec(spec);
      const existing = sqlite
        .prepare(
          "SELECT name, description, instructions, tool_allowlist, icon, builtin, enabled, seed_hash FROM skills WHERE id = ?",
        )
        .get(spec.id) as
        | {
            name: string;
            description: string;
            instructions: string;
            tool_allowlist: string | null;
            icon: string | null;
            builtin: number;
            enabled: number;
            seed_hash: string | null;
          }
        | undefined;

      if (!existing) {
        // N31: builtin skills seed ENABLED by default — the library's default
        // state is all-on; disabling is the user's choice (the toggle persists
        // because seed refreshes never touch `enabled`).
        sqlite
          .prepare(
            "INSERT INTO skills (id, name, description, instructions, tool_allowlist, builtin, enabled, icon, created_at, seed_hash) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?)",
          )
          .run(spec.id, spec.name, spec.description, spec.instructions, spec.toolAllowlist, spec.icon, Date.now(), hash);
        continue;
      }

      // A user skill holding a builtin id (practically impossible — user ids
      // are random `skill-xxxxxxxx`) is untouchable.
      if (!existing.builtin) continue;

      // Up to date → nothing to do.
      if (existing.seed_hash === hash) continue;

      // Stale or legacy (hash NULL): refresh content, PRESERVE `enabled` —
      // activation is user state that survives builtin updates.
      sqlite
        .prepare(
          "UPDATE skills SET name = ?, description = ?, instructions = ?, tool_allowlist = ?, icon = ?, seed_hash = ? WHERE id = ?",
        )
        .run(spec.name, spec.description, spec.instructions, spec.toolAllowlist, spec.icon, hash, spec.id);
    }
  } catch {
    // non-critical — skills UI will show an empty library if this fails
  }
}

/** One-time fix: payments that have a tx_hash but are stuck in 'settling' should be 'settled'. */
function fixStuckSettling(): void {
  try {
    sqlite.exec(
      `UPDATE payments SET status = 'settled', settled_at = COALESCE(settled_at, created_at) WHERE status = 'settling' AND tx_hash IS NOT NULL AND tx_hash != ''`,
    );
  } catch {
    // non-critical
  }
}
