import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const payments = sqliteTable("payments", {
  id: text("id").primaryKey(),
  recipientLabel: text("recipient_label"),
  recipientAddress: text("recipient_address").notNull(),
  token: text("token").notNull().default("USDC"),
  tokenAddress: text("token_address"),
  amountHuman: text("amount_human").notNull(),
  amountBaseUnits: text("amount_base_units").notNull(),
  memo: text("memo"),
  status: text("status").notNull().default("pending"),
  txHash: text("tx_hash"),
  chainId: integer("chain_id").notNull().default(11155111),
  senderAddress: text("sender_address"),
  createdAt: integer("created_at").notNull(),
  settledAt: integer("settled_at"),
  /** Epoch ms when the Attestcoin poller first saw a proof for txHash (server-side flip). */
  attestedAt: integer("attested_at"),
  /** Merkle root of the attested block's tx tree, persisted with attestedAt. */
  attestRoot: text("attest_root"),
  /** Epoch ms when the Block Prover Precompile (0x0FD2) first confirmed the proof on-chain. */
  onchainVerifiedAt: integer("onchain_verified_at"),
  /** Creditcoin tx hash of the on-chain proof submission (verifyAndEmitSingle), when performed. */
  cc3TxHash: text("cc3_tx_hash"),
});

export const contacts = sqliteTable("contacts", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  address: text("address").notNull().unique(),
  note: text("note").default(""),
  favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
  lastUsed: integer("last_used").notNull(),
});

export const notifications = sqliteTable("notifications", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  type: text("type").notNull().default("system"),
  read: integer("read", { mode: "boolean" }).notNull().default(false),
  relatedPaymentId: text("related_payment_id"),
  createdAt: integer("created_at").notNull(),
});

export type PaymentRow = typeof payments.$inferSelect;
export type PaymentInsert = typeof payments.$inferInsert;
export type ContactRow = typeof contacts.$inferSelect;
export type ContactInsert = typeof contacts.$inferInsert;
export type NotificationRow = typeof notifications.$inferSelect;
export type NotificationInsert = typeof notifications.$inferInsert;

export const recurringSchedules = sqliteTable("recurring_schedules", {
  id: text("id").primaryKey(),
  recipientLabel: text("recipient_label"),
  recipientAddress: text("recipient_address").notNull(),
  token: text("token").notNull().default("USDC"),
  tokenAddress: text("token_address"),
  amountHuman: text("amount_human").notNull(),
  amountBaseUnits: text("amount_base_units").notNull(),
  cadence: text("cadence").notNull(),
  /** Target chain (Phase-2 executor; null = legacy rows → the agent asks). */
  chainId: integer("chain_id"),
  nextFireAt: integer("next_fire_at").notNull(),
  lastFireAt: integer("last_fire_at"),
  executions: integer("executions").notNull().default(0),
  maxExecutions: integer("max_executions").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  /** Last dispatch outcome from the poller ("dispatched"|"deferred"|"failed"|"fired"). */
  lastStatus: text("last_status"),
  scheduleIdHash: text("schedule_id_hash").notNull(),
  senderAddress: text("sender_address"),
  createdAt: integer("created_at").notNull(),
  userId: text("user_id"),
});

export type RecurringRow = typeof recurringSchedules.$inferSelect;
export type RecurringInsert = typeof recurringSchedules.$inferInsert;

// ── Phase 2: agent runtime tables ────────────────────────────────────────────

/**
 * Per-user persistent agent settings (Phase 3): the mandate policy columns
 * were removed with the feature (C26) — what remains are the deploy policy
 * fields and chain preferences. Single local row (local-first app).
 */
export const agentSettings = sqliteTable("agent_settings", {
  id: text("id").primaryKey().default("local"),
  /** Mainnet contract-deployment opt-in (off by default, brief §7 [retained default]). */
  mainnetDeployOptIn: integer("mainnet_deploy_opt_in", { mode: "boolean" }).notNull().default(false),
  /** Per-user "don't show again" for the custom-contract warning (the deployment confirmation itself is never dismissible). */
  dismissedCustomDeployWarning: integer("dismissed_custom_deploy_warning", { mode: "boolean" }).notNull().default(false),
  /** Active chain keys (JSON array of registry keys) — null/empty = all. */
  activeChainKeys: text("active_chain_keys"),
  updatedAt: integer("updated_at").notNull(),
});

export type AgentSettingsRow = typeof agentSettings.$inferSelect;
export type AgentSettingsInsert = typeof agentSettings.$inferInsert;

/**
 * The user-visible action log (brief §5): every action attempted or taken,
 * with the proof/tx references that authorized it.
 */
export const agentActions = sqliteTable("agent_actions", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  /** Tool-call id from the loop — the join key for live lifecycle overlays (§4.6). */
  callId: text("call_id"),
  tool: text("tool").notNull(),
  /** Params as JSON (contract addresses, recipients, amounts…). */
  paramsJson: text("params_json"),
  status: text("status").notNull().default("pending"), // pending|awaiting_confirmation|running|succeeded|failed|declined|interrupted
  chainId: integer("chain_id"),
  /** Nominal USD value at execution time (cents, integer). */
  usdValueCents: integer("usd_value_cents"),
  riskClass: text("risk_class").notNull().default("read"),
  confirmationRequired: integer("confirmation_required", { mode: "boolean" }).notNull().default(false),
  /** Outcome/result JSON: txHash, contract address, error, summary… */
  resultJson: text("result_json"),
  /** Source-chain tx hash the action depends on (Attestcoin flows). */
  sourceTxHash: text("source_tx_hash"),
  /** Creditcoin tx hash when the action submitted/verified a proof on-chain. */
  cc3TxHash: text("cc3_tx_hash"),
  /** Merkle root of the attestation backing this action, when applicable. */
  attestRoot: text("attest_root"),
  createdAt: integer("created_at").notNull(),
  completedAt: integer("completed_at"),
});

export type AgentActionRow = typeof agentActions.$inferSelect;
export type AgentActionInsert = typeof agentActions.$inferInsert;

/**
 * Skills (brief §7): the extensibility mechanism. Builtin library + user-
 * authored. A skill composes the FIXED toolset via instructions and an optional
 * tool allowlist — never new code execution.
 */
export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  /** Prompt instructions injected into the agent's system prompt when active. */
  instructions: text("instructions").notNull(),
  /** JSON array of allowed tool names (null = all fixed tools). */
  toolAllowlist: text("tool_allowlist"),
  builtin: integer("builtin", { mode: "boolean" }).notNull().default(false),
  /** N31: skills default to ENABLED — the library's all-on default state. */
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  icon: text("icon"),
  createdAt: integer("created_at").notNull(),
  /** F9: content hash of the seed spec this builtin row was seeded from —
   *  lets ensureDb() refresh builtin content when the spec changes, while
   *  never touching `enabled` (user state). NULL for user skills. */
  seedHash: text("seed_hash"),
});

export type SkillRow = typeof skills.$inferSelect;
export type SkillInsert = typeof skills.$inferInsert;

/**
 * User automation rules (brief §8): "when X happens, do Y". App-open semantics
 * (queue-and-run) — same as recurring payments.
 */
export const automationRules = sqliteTable("automation_rules", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** balance_above|balance_below|attestation_ready|schedule */
  triggerType: text("trigger_type").notNull(),
  /** Trigger config JSON: { chainId, token, threshold } / { paymentId } / { everyMinutes }. */
  triggerConfigJson: text("trigger_config_json").notNull(),
  /** Action JSON: { kind: "transfer"|"notify", … } — executed via fixed toolset. */
  actionJson: text("action_json").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  lastFiredAt: integer("last_fired_at"),
  lastStatus: text("last_status"),
  createdAt: integer("created_at").notNull(),
});

export type AutomationRuleRow = typeof automationRules.$inferSelect;
export type AutomationRuleInsert = typeof automationRules.$inferInsert;
