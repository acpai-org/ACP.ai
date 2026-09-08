// ─────────────────────────────────────────────────────────────────────────────
// Automation rule types (brief §8) — "when X happens, do Y".
// Client-safe shared shape: the API routes serialize DB rows into this form
// (parsed triggerConfig / action JSON), and the poller + settings card
// consume it. App-open semantics (queue-and-run) — same as recurring
// payments: nothing runs in the background; rules evaluate while the app is
// open and visible.
// ─────────────────────────────────────────────────────────────────────────────

export const AUTOMATION_TRIGGER_TYPES = [
  "balance_above",
  "balance_below",
  "attestation_ready",
  "schedule",
] as const;

export type AutomationTriggerType = (typeof AUTOMATION_TRIGGER_TYPES)[number];

/** balance_above | balance_below — token + threshold on a chain. */
export interface BalanceTriggerConfig {
  chainId: number;
  /** Token symbol (registry-known on that chain) or a 0x ERC-20 address. */
  token: string;
  /** Human-unit threshold (compared against the wallet balance). */
  threshold: number;
}

/** attestation_ready — a payment whose Attestcoin proof has landed. */
export interface AttestationTriggerConfig {
  paymentId: string;
}

/** schedule — every N minutes while the app is open. */
export interface ScheduleTriggerConfig {
  everyMinutes: number;
}

export type AutomationTriggerConfig =
  | BalanceTriggerConfig
  | AttestationTriggerConfig
  | ScheduleTriggerConfig;

/** transfer — dispatched through the agent loop (wallet signature applies). */
export interface TransferActionConfig {
  chainId: number;
  token: string;
  recipient: string;
  /** Human-unit amount, decimal string (mirrors the transfer tool schema). */
  amount: string;
  kind: "transfer";
}

/** notify — delivers a notification via the notifications surface. */
export interface NotifyActionConfig {
  kind: "notify";
  message: string;
}

export type AutomationActionConfig = TransferActionConfig | NotifyActionConfig;

export interface AutomationRule {
  id: string;
  name: string;
  triggerType: AutomationTriggerType;
  triggerConfig: AutomationTriggerConfig;
  action: AutomationActionConfig;
  active: boolean;
  lastFiredAt: number | null;
  lastStatus: string | null;
  createdAt: number;
}
