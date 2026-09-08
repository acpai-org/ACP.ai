import { z } from "zod";
import { CHAIN_REGISTRY } from "@/lib/chains/registry";

// ─────────────────────────────────────────────────────────────────────────────
// THE CLOSED TOOLSET (brief §4 + §12 hard boundary).
//
// The agent may ONLY call tools in this registry. The loop rejects any other
// name structurally — the model literally cannot invoke code that is not
// enumerated here. Wallet-touching tools never contain arbitrary transaction
// bytes; they contain INTENTS (recipient, amount, chain, contract identity)
// which the client executor turns into specific, known transaction shapes.
//
// Tool schema design principle: few, rich tools serving many phrasings
// (one transfer tool beats five near-duplicates). Every fund-moving tool is
// chain-parameterized across the active chain set.
// ─────────────────────────────────────────────────────────────────────────────

export type RiskClass = "read" | "funds" | "deploy" | "config" | "privilege";
export type ExecutorKind = "server" | "client";

export interface ToolDef {
  name: string;
  description: string;
  /** OpenAI JSON Schema for the tool parameters. */
  parameters: Record<string, unknown>;
  /** Zod schema for runtime validation (shared by server + client executors). */
  zod: z.ZodTypeAny;
  executor: ExecutorKind;
  risk: RiskClass;
  /**
   * Force the pre-deployment confirmation card even for tools whose risk
   * class is "funds" (create_conditional_release / cross_chain_swap both
   * DEPLOY contracts — the standing rule requires the source/template +
   * plain-English summary confirmation on every deployment path).
   */
  confirmationRequired?: boolean;
  /** Compact one-line title for the trace UI (English; client localizes by tool key). */
  traceTitle?: (args: Record<string, unknown>) => string;
}

const chainIdSchema = z
  .number()
  .int()
  .describe(
    `Target EVM chain ID. Supported: ${CHAIN_REGISTRY.map((c) => `${c.chainId} (${c.shortName})`).join(", ")}. If the user's phrasing is ambiguous about which chain, ASK before calling.`,
  );

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Must be a valid 0x EVM address");
const amountSchema = z.string().regex(/^\d+(?:\.\d{1,18})?$/, "Decimal amount string, e.g. '50' or '25.50'");
const tokenSchema = z
  .string()
  .describe(
    "Token symbol (e.g. ETH, tCTC, USDC, USDT, BNB, POL) — or a 0x contract address for custom ERC-20 tokens. Native symbols (ETH/tCTC/CTC/BNB/POL) send as plain value transfers.",
  );

const optionalMemo = z.string().max(200).nullish().describe("Optional note/memo for the payment, omit if none")

/** Models (esp. JSON-protocol ones) sometimes emit amounts as numbers — coerce to string before validating. */
const amountHuman = z.preprocess(
  (v) => (typeof v === "number" && Number.isFinite(v) ? String(v) : v),
  amountSchema,
);

// ── Read-only / query tools (server-executed; never move funds) ──────────────

export const getBalancesSchema = z.object({
  chain: z
    .number()
    .int()
    .nullable()
    .describe("Chain ID to query, or null for ALL of the user's active chains"),
});

export const getTransactionStatusSchema = z.object({
  chain: chainIdSchema,
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/, "Must be a 0x transaction hash"),
});

export const checkAttestationSchema = z.object({
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).describe("Source-chain transaction hash to check"),
  // P26 fix: the published OpenAI parameters mark chain optional (default
  // Sepolia) and the handler applies `?? 11155111` — the zod REQUIRED it,
  // so a schema-following model call failed validation. Aligned all three.
  chain: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("EVM chain ID of the source tx. Optional — defaults to Sepolia 11155111 this phase"),
});

export const waitForAttestationSchema = z.object({
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  chain: chainIdSchema.optional(),
  maxWaitSeconds: z.number().int().min(10).max(900).default(600).describe("Maximum seconds to wait (default 600)"),
});

export const listContactsSchema = z.object({});
export const listChainsSchema = z.object({});
export const listRecentActionsSchema = z.object({
  limit: z.number().int().min(1).max(50).default(10),
});
export const attestcoinNetworkStatusSchema = z.object({});

// ── Fund-moving tools (client-executed via the connected wallet) ─────────────

export const transferSchema = z.object({
  chain: chainIdSchema,
  recipient: addressSchema.describe("Recipient 0x address (resolve names against contacts first)"),
  token: tokenSchema,
  amount: amountHuman.describe("Human-readable amount to send, e.g. '50' or '0.01'"),
  memo: optionalMemo,
});

export const batchTransferSchema = z.object({
  chain: chainIdSchema,
  transfers: z
    .array(
      z.object({
        recipient: addressSchema,
        token: tokenSchema,
        amount: amountHuman,
        memo: optionalMemo,
      }),
    )
    .min(1)
    .max(20),
});

// ── Contract tools (client-executed; ALWAYS confirmation-gated) ──────────────

export const deployContractSchema = z.object({
  mode: z.enum(["template", "custom"]).describe("template = vetted library contract with parameters; custom = Solidity source the agent wrote"),
  template: z
    .enum(["erc20", "escrow", "multisig", "conditional_release", "crosschain_swap_source", "crosschain_swap_destination"])
    .nullish()
    .describe("Template key (mode=template): erc20 | escrow | multisig deploy anywhere enabled; conditional_release / crosschain_swap_* are Attestcoin ASCs — CREDITCOIN ONLY (the BlockProver precompile 0x0FD2 exists only there)"),
  chain: chainIdSchema,
  constructorArgs: z.record(z.unknown()).nullish().describe("Constructor arguments for the chosen template"),
  source: z
    .string()
    .max(120_000)
    .nullish()
    .describe("Full Solidity source (mode=custom). pragma solidity ^0.8.23. The user will see this source + a plain-English summary and must explicitly confirm before deployment."),
  sourceName: z.string().max(60).nullish().describe("Short name for the custom contract, e.g. 'TokenVesting'"),
});

// ── Attestcoin flow tools (multi-step, client-executed, funds class) ─────────

export const createConditionalReleaseSchema = z.object({
  /** The Sepolia tx that must be proven for funds to release. */
  sourceTxHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).nullish().describe("The Sepolia transaction hash whose verified inclusion gates the release. If the condition is a FUTURE payment, set null and give conditionDescription."),
  conditionDescription: z.string().max(300).nullish().describe("Plain-language description of the release condition, e.g. 'Alice pays the 25 USDC invoice on Sepolia'"),
  sourceChain: chainIdSchema.default(11155111).describe("Source chain where the condition tx lives (Attestcoin source: Sepolia 11155111 this phase)"),
  beneficiary: addressSchema,
  amount: amountHuman.describe("Amount of tCTC to escrow on Creditcoin Testnet"),
  token: z.literal("tCTC").default("tCTC"),
  timeoutHours: z.number().int().min(1).max(720).default(72).describe("Hours after which the escrow auto-refunds the depositor if unreleased"),
});

export const executeConditionalReleaseSchema = z.object({
  contractAddress: addressSchema.describe("The ASC address on Creditcoin Testnet (ConditionalRelease for financing flows, CrossChainSwapDestination for swap releases)"),
  sourceTxHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).describe("The Sepolia tx to prove"),
  mode: z
    .enum(["conditional_release", "swap_release"])
    .default("conditional_release")
    .describe("conditional_release → ConditionalRelease.release (financing flow); swap_release → CrossChainSwapDestination.releaseWithProof (cross-chain swap flow)"),
});

export const crossChainSwapSchema = z.object({
  /** Source: lock ETH on Sepolia. Destination: release tCTC on Creditcoin Testnet at a fixed rate. */
  lockAmount: amountHuman.describe("Amount of ETH to lock on Sepolia"),
  rateTctcPerEth: z
    .number()
    .int()
    .positive()
    .describe("Exchange rate in tCTC per 1 ETH, fixed at lock time (positive integer — fractional rates are rejected, they would be silently rounded on-chain)"),
  destinationAddress: addressSchema.nullish().describe("tCTC recipient on Creditcoin (null = the user's own address)"),
  sourceAddress: addressSchema.nullish().describe("ETH locker on Sepolia (null = the user's own address)"),
});

// ── Attestcoin protocol inspection tools (N32 — doc-grounded, read-only) ─────

const sourceTxHashSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/)
  .describe("Source-chain transaction hash (Attestcoin source: Sepolia 11155111 or Ethereum 1)");

const sourceChainOptSchema = z
  .number()
  .int()
  .optional()
  .describe("EVM chain ID of the source tx (default Sepolia 11155111; Ethereum mainnet 1 also supported)");

export const decodeSourceTransactionSchema = z.object({
  txHash: sourceTxHashSchema,
  chain: sourceChainOptSchema,
});

export const verifyProofReadonlySchema = z.object({
  txHash: sourceTxHashSchema,
  chain: sourceChainOptSchema,
});

export const estimateVerificationCostSchema = z.object({
  txHash: sourceTxHashSchema,
  chain: sourceChainOptSchema,
});

export const getAttestationBoundsSchema = z.object({
  txHash: sourceTxHashSchema,
  chain: sourceChainOptSchema,
});

export const submitProofOnchainSchema = z.object({
  txHash: sourceTxHashSchema,
  chain: sourceChainOptSchema,
});

// ── Recurring / automation (config class) ────────────────────────────────────

export const createRecurringPaymentSchema = z.object({
  recipient: addressSchema,
  token: tokenSchema,
  amount: amountSchema,
  chain: chainIdSchema,
  cadence: z.enum(["daily", "weekly", "biweekly", "monthly"]).describe("How often the payment executes while the app is open and wallet connected"),
  intervalHours: z
    .number()
    .int()
    .min(1)
    .max(2160)
    .nullish()
    .describe("CUSTOM schedules: interval in hours (1–2160). When set, this overrides cadence — e.g. 6 = every 6 hours. Omit for presets or sub-hour intervals (use intervalSeconds)."),
  intervalSeconds: z
    .number()
    .int()
    .min(10)
    .max(86_400)
    .nullish()
    .describe("CUSTOM sub-hour schedules (P17): interval in SECONDS (10–86400) — e.g. 30 = every 30 seconds, 600 = every 10 minutes. Overrides cadence and intervalHours. Real funds move on each execution — avoid very short intervals unless the user explicitly asked."),
  memo: optionalMemo,
  maxExecutions: z.number().int().min(1).max(1000).nullish().describe("Stop after N executions, or null to run until disabled"),
});

// ── N24: app-control tools (contacts + recurring schedule management) ────────
export const createContactSchema = z.object({
  label: z.string().min(1).max(64).describe("Display name for the contact, e.g. 'Alice Chen'"),
  address: addressSchema.describe("The contact's 0x EVM address"),
  note: z.string().max(200).nullish().describe("Optional note about the contact, omit if none"),
});

export const listRecurringPaymentsSchema = z.object({
  includeInactive: z.boolean().nullish().describe("Include completed/cancelled schedules (default: active only)"),
});

export const cancelRecurringPaymentSchema = z.object({
  scheduleId: z.string().min(1).max(64).describe("The id of the recurring schedule to cancel (from list_recurring_payments)"),
});

// ── P20: automation-rule tools (config class — the closed set's rule CRUD) ───
export const createAutomationRuleSchema = z.object({
  name: z.string().min(2).max(60).describe("Short rule name, e.g. 'Low ETH alert'"),
  triggerType: z.enum(["balance_above", "balance_below", "attestation_ready", "schedule"]).describe("When the rule fires: a wallet balance crossing a threshold, an Attestcoin attestation landing for a payment, or a time schedule"),
  triggerConfig: z.record(z.unknown()).describe("Trigger parameters: {chainId, token, threshold} for balance_above/below; {paymentId} for attestation_ready; {everyMinutes: 1-1440} for schedule"),
  action: z.record(z.unknown()).describe("What the rule does: {kind: 'notify', message} for a notification, or {kind: 'transfer', chainId, token, recipient, amount} for a payment (every transfer still requires the wallet signature when it fires)"),
});

export const updateAutomationRuleSchema = z.object({
  ruleId: z.string().min(1).max(64).describe("The rule id from list_automation_rules"),
  name: z.string().min(2).max(60).nullish(),
  active: z.boolean().nullish().describe("Arm (true) or disarm (false) the rule"),
  triggerType: z.enum(["balance_above", "balance_below", "attestation_ready", "schedule"]).nullish(),
  triggerConfig: z.record(z.unknown()).nullish(),
  action: z.record(z.unknown()).nullish(),
});

export const deleteAutomationRuleSchema = z.object({
  ruleId: z.string().min(1).max(64).describe("The rule id to DELETE (from list_automation_rules). Deletion is permanent and requires the user's confirmation."),
});

export const listAutomationRulesSchema = z.object({
  includeInactive: z.boolean().nullish().describe("Include disarmed rules (default: armed only)"),
});

// ── THE REGISTRY (closed set — extend only by explicit design, never from user input) ──

import { getChainByChainId } from "@/lib/chains/registry";

function chainShort(chain: number | undefined): string {
  return chain ? (getChainByChainId(chain)?.shortName ?? `chain ${chain}`) : "";
}

export const TOOL_REGISTRY: Record<string, ToolDef> = {
  get_balances: {
    name: "get_balances",
    description:
      "Read the user's live wallet balances (native token + known ERC-20s) on one chain or across all their active chains. Use before transfers to check sufficiency, or when the user asks 'how much do I have'. Read-only.",
    parameters: {
      type: "object",
      properties: {
        chain: { type: ["integer", "null"], description: "Chain ID to query, or null for all active chains" },
      },
      required: [],
      additionalProperties: false,
    },
    zod: getBalancesSchema,
    executor: "server",
    risk: "read",
  },
  get_transaction_status: {
    name: "get_transaction_status",
    description:
      "Check an on-chain transaction: mined?, block, confirmations, success/revert, and — for supported source chains — its Attestcoin attestation state. Read-only.",
    parameters: {
      type: "object",
      properties: {
        chain: { type: "integer", description: "EVM chain ID of the transaction" },
        txHash: { type: "string", description: "0x transaction hash" },
      },
      required: ["chain", "txHash"],
      additionalProperties: false,
    },
    zod: getTransactionStatusSchema,
    executor: "server",
    risk: "read",
  },
  check_attestation_status: {
    name: "check_attestation_status",
    description:
      "Check whether Attestcoin can prove a source-chain transaction yet: attested height vs the tx's block, proof availability, and the on-chain BlockProver verdict if a proof exists. Read-only. Use before execute_conditional_release and when users ask if a payment is verified.",
    parameters: {
      type: "object",
      properties: {
        txHash: { type: "string", description: "Source-chain 0x transaction hash" },
        chain: { type: ["integer", "null"], description: "EVM chain ID of the source tx (default Sepolia 11155111)" },
      },
      required: ["txHash"],
      additionalProperties: false,
    },
    zod: checkAttestationSchema,
    executor: "server",
    risk: "read",
  },
  wait_for_attestation: {
    name: "wait_for_attestation",
    description:
      "Wait (bounded) until Attestcoin has attested the block containing a source-chain transaction, so a proof can be generated. Typical lag is minutes. Emits live progress. Call this before execute_conditional_release / swap release when check_attestation_status says 'pending'.",
    parameters: {
      type: "object",
      properties: {
        txHash: { type: "string" },
        chain: { type: "integer" },
        maxWaitSeconds: { type: "integer", description: "Max wait, default 600s" },
      },
      required: ["txHash"],
      additionalProperties: false,
    },
    zod: waitForAttestationSchema,
    executor: "server",
    risk: "read",
  },
  attestcoin_network_status: {
    name: "attestcoin_network_status",
    description:
      "Live Attestcoin Protocol network status: supported source chains, attested heights, source heads, lag, current Creditcoin block. Use when asked about the oracle/attestation freshness. Read-only.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    zod: attestcoinNetworkStatusSchema,
    executor: "server",
    risk: "read",
  },
  list_contacts: {
    name: "list_contacts",
    description: "List the user's saved contacts (name, address, notes). Use to resolve recipient names. Read-only.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    zod: listContactsSchema,
    executor: "server",
    risk: "read",
  },
  list_chains: {
    name: "list_chains",
    description:
      "List the chains active for this user (IDs, names, native tokens, known tokens, testnet/mainnet, features). Use when unsure which chain fits a request. Read-only.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    zod: listChainsSchema,
    executor: "server",
    risk: "read",
  },
  list_recent_actions: {
    name: "list_recent_actions",
    description:
      "Show the agent's recent action log (what was done, when, outcome, tx hashes and proof references). Use for 'what did you do' / 'show my history' questions. Read-only.",
    parameters: {
      type: "object",
      properties: { limit: { type: "integer", description: "Max rows (default 10)" } },
      required: [],
      additionalProperties: false,
    },
    zod: listRecentActionsSchema,
    executor: "server",
    risk: "read",
  },
  transfer: {
    name: "transfer",
    description:
      "Send funds (native or ERC-20) from the user's connected wallet to a recipient on a supported chain. This actually moves funds — the wallet will ask for a signature, which is the confirmation: state what you're sending (amount, token, chain, recipient) before calling.",
    parameters: {
      type: "object",
      properties: {
        chain: { type: "integer", description: "Target EVM chain ID" },
        recipient: { type: "string", description: "Recipient 0x address" },
        token: { type: "string", description: "Token symbol or 0x ERC-20 address" },
        amount: { type: "string", description: "Decimal amount string, e.g. '50'" },
        memo: { type: ["string", "null"], description: "Optional memo" },
      },
      required: ["chain", "recipient", "token", "amount"],
      additionalProperties: false,
    },
    zod: transferSchema,
    executor: "client",
    risk: "funds",
    traceTitle: (a) => `Transfer ${String(a.amount)} ${String(a.token)} on ${chainShort(a.chain as number)}`,
  },
  batch_transfer: {
    name: "batch_transfer",
    description:
      "Send multiple transfers in one instruction (up to 20), executed sequentially on the same chain. Each payment gets its own wallet signature.",
    parameters: {
      type: "object",
      properties: {
        chain: { type: "integer", description: "Target EVM chain ID for all transfers" },
        transfers: {
          type: "array",
          description: "List of transfers: recipient, token, amount, optional memo",
          items: {
            type: "object",
            properties: {
              recipient: { type: "string" },
              token: { type: "string" },
              amount: { type: "string" },
              memo: { type: ["string", "null"] },
            },
            required: ["recipient", "token", "amount"],
            additionalProperties: false,
          },
        },
      },
      required: ["chain", "transfers"],
      additionalProperties: false,
    },
    zod: batchTransferSchema,
    executor: "client",
    risk: "funds",
    traceTitle: (a) => `Batch of ${Array.isArray(a.transfers) ? a.transfers.length : "?"} transfers on ${chainShort(a.chain as number)}`,
  },
  deploy_contract: {
    name: "deploy_contract",
    description:
      "Deploy a contract from the user's wallet. Two paths: (a) template — a vetted contract (ERC-20, escrow, multisig, or the Attestcoin ASC templates) with constructor parameters; (b) custom — Solidity source you wrote for the request. Deployment ALWAYS requires explicit user confirmation showing the source (or template + params) and a plain-English summary — this can never be skipped or delegated. ASC templates (conditional_release, crosschain_swap_*) only work on Creditcoin chains (the BlockProver precompile exists only there).",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["template", "custom"] },
        template: { type: ["string", "null"], enum: ["erc20", "escrow", "multisig", "conditional_release", "crosschain_swap_source", "crosschain_swap_destination"] },
        chain: { type: "integer", description: "Deployment target chain ID" },
        constructorArgs: { type: ["object", "null"], description: "Constructor arguments keyed by name" },
        source: { type: ["string", "null"], description: "Full Solidity source (custom mode only)" },
        sourceName: { type: ["string", "null"], description: "Short contract name (custom mode)" },
      },
      required: ["mode", "chain"],
      additionalProperties: false,
    },
    zod: deployContractSchema,
    executor: "client",
    risk: "deploy",
    traceTitle: (a) => `Deploy ${a.mode === "template" ? String(a.template) : String(a.sourceName ?? "custom contract")} on ${chainShort(a.chain as number)}`,
  },
  create_conditional_release: {
    name: "create_conditional_release",
    description:
      "Create an Attestcoin-verified conditional release (escrow/financing): funds in tCTC are locked in a ConditionalRelease smart contract on Creditcoin Testnet, released to the beneficiary ONLY when a verified Attestcoin proof of the condition transaction on Sepolia is submitted on-chain. Deploys the contract and escrows the funds (two wallet transactions). If the condition tx hasn't happened yet, give conditionDescription and sourceTxHash=null.",
    parameters: {
      type: "object",
      properties: {
        sourceTxHash: { type: ["string", "null"], description: "Sepolia tx gating the release (null if condition is future)" },
        conditionDescription: { type: ["string", "null"], description: "Plain-language release condition" },
        sourceChain: { type: "integer", description: "Source chain (default Sepolia 11155111)" },
        beneficiary: { type: "string", description: "tCTC recipient when released" },
        amount: { type: "string", description: "tCTC amount to escrow" },
        token: { type: "string", enum: ["tCTC"] },
        timeoutHours: { type: "integer", description: "Auto-refund window in hours (default 72)" },
      },
      required: ["beneficiary", "amount"],
      additionalProperties: false,
    },
    zod: createConditionalReleaseSchema,
    executor: "client",
    risk: "funds",
    confirmationRequired: true,
    traceTitle: (a) => `Conditional release: escrow ${String(a.amount)} tCTC for ${String(a.beneficiary ?? "").slice(0, 10)}…`,
  },
  execute_conditional_release: {
    name: "execute_conditional_release",
    description:
      "Release funds gated by an Attestcoin-verified proof: fetches the proof for the gating Sepolia tx (wait_for_attestation first if not yet attested) and submits it to the ASC — verification and release happen atomically on-chain via the BlockProver precompile. mode=conditional_release for ConditionalRelease ASCs (financing); mode=swap_release for CrossChainSwapDestination ASCs (swaps).",
    parameters: {
      type: "object",
      properties: {
        contractAddress: { type: "string", description: "The ASC address on Creditcoin Testnet" },
        sourceTxHash: { type: "string", description: "The Sepolia tx to prove" },
        mode: { type: "string", enum: ["conditional_release", "swap_release"], description: "conditional_release (default) for ConditionalRelease ASCs; swap_release for CrossChainSwapDestination ASCs" },
      },
      required: ["contractAddress", "sourceTxHash"],
      additionalProperties: false,
    },
    zod: executeConditionalReleaseSchema,
    executor: "client",
    risk: "funds",
    traceTitle: () => "Execute conditional release with proof",
  },
  cross_chain_swap: {
    name: "cross_chain_swap",
    description:
      "Attestcoin-secured cross-chain swap: locks ETH on Sepolia, and releases tCTC on Creditcoin Testnet at a rate fixed at lock time, once the lock is verified by Attestcoin proof on-chain. NOT a same-chain AMM trade — the protocol is the security. Multi-step: deploy (if needed) → fund destination side → lock → wait for attestation → proof-backed release. The destination side must be pre-funded (by the user acting as liquidity provider in this phase).",
    parameters: {
      type: "object",
      properties: {
        lockAmount: { type: "string", description: "ETH amount to lock on Sepolia" },
        rateTctcPerEth: { type: "integer", description: "tCTC per 1 ETH, fixed at lock time (positive integer)" },
        destinationAddress: { type: ["string", "null"], description: "tCTC recipient (null = user)" },
        sourceAddress: { type: ["string", "null"], description: "ETH locker (null = user)" },
      },
      required: ["lockAmount", "rateTctcPerEth"],
      additionalProperties: false,
    },
    zod: crossChainSwapSchema,
    executor: "client",
    risk: "funds",
    confirmationRequired: true,
    traceTitle: (a) => `Cross-chain swap: lock ${String(a.lockAmount)} ETH → release ${String(a.rateTctcPerEth ?? "?")} tCTC/ETH`,
  },
  // ── P20: automation-rule tools (closed set CRUD + listing) ───────────────
  create_automation_rule: {
    name: "create_automation_rule",
    description:
      "Create an automation rule ('when X happens, do Y'): triggers are a wallet balance crossing a threshold, an Attestcoin attestation landing for a payment, or a time schedule (every N minutes while the app is open). Actions are a notification or a transfer (transfers still require the wallet signature when the rule fires — the rule itself never moves funds silently). Rules evaluate while the app is open; missed schedule ticks run at next app open. Use when the user says 'alert me when…', 'when my balance…', 'every N minutes do…'.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short rule name (2-60 chars)" },
        triggerType: { type: "string", enum: ["balance_above", "balance_below", "attestation_ready", "schedule"] },
        triggerConfig: { type: "object", description: "{chainId, token, threshold} | {paymentId} | {everyMinutes}" },
        action: { type: "object", description: "{kind:'notify', message} | {kind:'transfer', chainId, token, recipient, amount}" },
      },
      required: ["name", "triggerType", "triggerConfig", "action"],
      additionalProperties: false,
    },
    zod: createAutomationRuleSchema,
    executor: "server",
    risk: "config",
    traceTitle: (a) => `Create automation rule "${String(a.name)}"`,
  },

  update_automation_rule: {
    name: "update_automation_rule",
    description:
      "Update an automation rule by id — rename, arm/disarm (active), or change its trigger/action (re-validated). Find the id with list_automation_rules first; the user should name the rule, not the raw id. A changed trigger re-arms the rule from scratch.",
    parameters: {
      type: "object",
      properties: {
        ruleId: { type: "string", description: "Rule id from list_automation_rules" },
        name: { type: ["string", "null"] },
        active: { type: ["boolean", "null"], description: "Arm (true) or disarm (false)" },
        triggerType: { type: ["string", "null"], enum: ["balance_above", "balance_below", "attestation_ready", "schedule"] },
        triggerConfig: { type: ["object", "null"] },
        action: { type: ["object", "null"] },
      },
      required: ["ruleId"],
      additionalProperties: false,
    },
    zod: updateAutomationRuleSchema,
    executor: "server",
    risk: "config",
    traceTitle: (a) => `Update automation rule ${String(a.ruleId).slice(0, 10)}…`,
  },

  delete_automation_rule: {
    name: "delete_automation_rule",
    description:
      "PERMANENTLY delete an automation rule by id. Requires the user's explicit confirmation (an in-app confirmation card is always shown before deletion). Prefer DISARMING (update_automation_rule with active=false) unless the user clearly said delete/remove. Find the id with list_automation_rules first.",
    parameters: {
      type: "object",
      properties: {
        ruleId: { type: "string", description: "Rule id to delete (from list_automation_rules)" },
      },
      required: ["ruleId"],
      additionalProperties: false,
    },
    zod: deleteAutomationRuleSchema,
    executor: "server",
    risk: "config",
    // P20 guardrail: destructive operations get the in-app confirmation card.
    confirmationRequired: true,
    traceTitle: (a) => `Delete automation rule ${String(a.ruleId).slice(0, 10)}…`,
  },

  list_automation_rules: {
    name: "list_automation_rules",
    description:
      "List the user's automation rules (armed by default): trigger, action, last fired, status. Ids LEAD each entry in brackets — copy the exact id for update/delete calls. Use for 'what automation rules do I have' or before changing one.",
    parameters: {
      type: "object",
      properties: {
        includeInactive: { type: ["boolean", "null"], description: "Include disarmed rules (default: armed only)" },
      },
      additionalProperties: false,
    },
    zod: listAutomationRulesSchema,
    executor: "server",
    risk: "read",
    traceTitle: () => "List automation rules",
  },

  get_app_status: {
    name: "get_app_status",
    description:
      "Read a compact snapshot of the ACP.ai app state: wallet connection, active chain, supported chains, pending recurring payments and armed automation rules, recent agent actions, and where the app's pages and settings live. Read-only. Use this to answer 'what's my setup / where do I find X / what just happened' questions instead of guessing.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    zod: z.object({}),
    executor: "server",
    risk: "read",
    traceTitle: () => "Read app status",
  },
  create_recurring_payment: {
    name: "create_recurring_payment",
    description:
      "Schedule a recurring payment (daily/weekly/biweekly/monthly, or any custom interval via intervalHours). Executes while the app is open and the wallet is connected; anything missed while away runs at next connect. Does NOT move funds now.",
    parameters: {
      type: "object",
      properties: {
        recipient: { type: "string", description: "Recipient 0x address" },
        token: { type: "string", description: "Token symbol" },
        amount: { type: "string", description: "Decimal amount per execution" },
        chain: { type: "integer", description: "Chain ID" },
        cadence: { type: "string", enum: ["daily", "weekly", "biweekly", "monthly"] },
        intervalHours: {
          type: ["integer", "null"],
          description: "CUSTOM schedules: interval in hours (1–2160), overrides cadence — e.g. 6 = every 6 hours. Omit for presets or sub-hour intervals (use intervalSeconds).",
        },
        intervalSeconds: {
          type: ["integer", "null"],
          description: "CUSTOM sub-hour schedules: interval in SECONDS (10–86400) — e.g. 30 = every 30 seconds, 600 = every 10 minutes. Overrides cadence and intervalHours.",
        },
        memo: { type: ["string", "null"] },
        maxExecutions: { type: ["integer", "null"] },
      },
      required: ["recipient", "token", "amount", "chain", "cadence"],
      additionalProperties: false,
    },
    zod: createRecurringPaymentSchema,
    executor: "server",
    risk: "config",
    traceTitle: (a) =>
      `Recurring ${
        a.intervalSeconds != null
          ? `every ${a.intervalSeconds}s`
          : a.intervalHours != null
            ? `every ${a.intervalHours}h`
            : String(a.cadence)
      } payment: ${String(a.amount)} ${String(a.token)}`,
  },

  // ── N24: app-control tools (contacts + schedule management) ─────────────────
  create_contact: {
    name: "create_contact",
    description:
      "Save a recipient to the user's address book (Contacts page) so future payments can use the name. Use when the user says 'save/remember this address as …' — typically after a first transfer. Never overwrites: a duplicate address is rejected (tell the user it already exists, with the saved name).",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string", description: "Display name for the contact" },
        address: { type: "string", description: "The contact's 0x EVM address" },
        note: { type: ["string", "null"], description: "Optional note, omit if none" },
      },
      required: ["label", "address"],
      additionalProperties: false,
    },
    zod: createContactSchema,
    executor: "server",
    risk: "config",
    traceTitle: (a) => `Save contact "${String(a.label)}"`,
  },

  list_recurring_payments: {
    name: "list_recurring_payments",
    description:
      "List the user's recurring payment schedules (active by default): amount, token, chain, cadence, next execution, executions/max, status. Use when the user asks 'what recurring payments do I have' or before cancelling one.",
    parameters: {
      type: "object",
      properties: {
        includeInactive: { type: ["boolean", "null"], description: "Include completed/cancelled schedules (default: active only)" },
      },
      additionalProperties: false,
    },
    zod: listRecurringPaymentsSchema,
    executor: "server",
    risk: "read",
    traceTitle: () => "List recurring payments",
  },

  cancel_recurring_payment: {
    name: "cancel_recurring_payment",
    description:
      "Cancel (deactivate) a recurring payment schedule by its id — STOPS FUTURE executions; it never moves funds and never touches already-executed payments. Use when the user says 'stop/cancel my <cadence> payment to …'. Find the id via list_recurring_payments first; the user should name the schedule by recipient/cadence, not raw id.",
    parameters: {
      type: "object",
      properties: {
        scheduleId: { type: "string", description: "The schedule id from list_recurring_payments" },
      },
      required: ["scheduleId"],
      additionalProperties: false,
    },
    zod: cancelRecurringPaymentSchema,
    executor: "server",
    risk: "config",
    traceTitle: () => "Cancel recurring payment",
  },

  // ── N32: direct Attestcoin protocol inspection/submission tools ─────────────
  decode_source_transaction: {
    name: "decode_source_transaction",
    description:
      "Decode a source-chain transaction through the Attestcoin EvmV1Decoder on Creditcoin: type, from, to, value, calldata preview, and the RECEIPT STATUS — the one thing the BlockProver precompile does NOT check (it proves inclusion, not success). Use when the user asks 'what exactly was in that transaction / did it succeed', or before relying on a proof for a release. Read-only.",
    parameters: {
      type: "object",
      properties: {
        txHash: { type: "string", description: "Source-chain 0x transaction hash" },
        chain: { type: "integer", description: "EVM chain ID of the source tx (default Sepolia 11155111)" },
      },
      required: ["txHash"],
      additionalProperties: false,
    },
    zod: decodeSourceTransactionSchema,
    executor: "server",
    risk: "read",
    traceTitle: () => "Decode source transaction",
  },
  verify_proof_readonly: {
    name: "verify_proof_readonly",
    description:
      "Ask the Creditcoin chain ITSELF whether a proof is valid: submits the Merkle + continuity proof to the BlockProver precompile (0x…0FD2) as a read-only eth_call — no signer, no gas, no state change. Returns the chain's verdict plus the transaction index. Use when the user wants the strongest possible confirmation that a source tx is provable, or to double-check before a release/swap. Read-only.",
    parameters: {
      type: "object",
      properties: {
        txHash: { type: "string", description: "Source-chain 0x transaction hash" },
        chain: { type: "integer", description: "EVM chain ID of the source tx (default Sepolia 11155111)" },
      },
      required: ["txHash"],
      additionalProperties: false,
    },
    zod: verifyProofReadonlySchema,
    executor: "server",
    risk: "read",
    traceTitle: () => "Verify proof on-chain (read-only)",
  },
  estimate_verification_cost: {
    name: "estimate_verification_cost",
    description:
      "Estimate the CTC gas cost of on-chain verification for a source transaction BEFORE submitting it, using the protocol's documented cost model (≈ 2.3e-5 + 2.9e-7 × continuity length) plus the live attestation bounds. Also flags stale proofs (10–100x more expensive when old) and advises verifying soon after finalization. Read-only.",
    parameters: {
      type: "object",
      properties: {
        txHash: { type: "string", description: "Source-chain 0x transaction hash" },
        chain: { type: "integer", description: "EVM chain ID of the source tx (default Sepolia 11155111)" },
      },
      required: ["txHash"],
      additionalProperties: false,
    },
    zod: estimateVerificationCostSchema,
    executor: "server",
    risk: "read",
    traceTitle: () => "Estimate verification cost",
  },
  get_attestation_bounds: {
    name: "get_attestation_bounds",
    description:
      "Show the attestation/checkpoint bracket around a source transaction's block: the closest attested bounds above and below it, whether the block is attested yet, and how far the chain has advanced. This is the protocol-native answer to 'why isn't my tx verified yet'. Read-only.",
    parameters: {
      type: "object",
      properties: {
        txHash: { type: "string", description: "Source-chain 0x transaction hash" },
        chain: { type: "integer", description: "EVM chain ID of the source tx (default Sepolia 11155111)" },
      },
      required: ["txHash"],
      additionalProperties: false,
    },
    zod: getAttestationBoundsSchema,
    executor: "server",
    risk: "read",
    traceTitle: () => "Read attestation bounds",
  },
  submit_proof_onchain: {
    name: "submit_proof_onchain",
    description:
      "Submit a source-chain transaction's proof for ON-CHAIN verification on Creditcoin (verifyAndEmitSingle): fetches the proof, signs with the app's Attestcoin submission account, and emits the TransactionVerified event on-chain. Requires the app's CREDITCOIN_SIGNER_KEY to be configured — the tool reports the exact unavailability and what to do when it is not. Needs explicit user confirmation (it spends real gas and creates a public on-chain verification record).",
    parameters: {
      type: "object",
      properties: {
        txHash: { type: "string", description: "Source-chain 0x transaction hash" },
        chain: { type: "integer", description: "EVM chain ID of the source tx (default Sepolia 11155111)" },
      },
      required: ["txHash"],
      additionalProperties: false,
    },
    zod: submitProofOnchainSchema,
    executor: "server",
    risk: "deploy", // confirmation-gated: real gas + public on-chain write via the app signer
    traceTitle: () => "Submit proof on-chain (verifyAndEmit)",
  },
};

export type ToolName = keyof typeof TOOL_REGISTRY;

export const TOOL_NAMES = Object.keys(TOOL_REGISTRY) as ToolName[];

/** OpenAI-format tool definitions for the model. */
export function openaiToolSpecs(): Array<Record<string, unknown>> {
  return Object.values(TOOL_REGISTRY).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function isKnownTool(name: string): boolean {
  return name in TOOL_REGISTRY;
}
