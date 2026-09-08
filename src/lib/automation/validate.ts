import {
  AUTOMATION_TRIGGER_TYPES,
  type AutomationActionConfig,
  type AutomationTriggerConfig,
  type AutomationTriggerType,
} from "@/lib/automation/types";
import { getChainByChainId } from "@/lib/chains/registry";

// ─────────────────────────────────────────────────────────────────────────────
// Automation rule validation (brief §8) — shared by POST /api/automation and
// PATCH /api/automation/[id]. The rules are deliberately strict: a rule that
// fires a transfer is a standing instruction, so its trigger and action must
// be resolvable NOW (known chain, known-or-contract token, 0x recipient,
// positive amount) — the same fields the transfer tool schema enforces.
// ─────────────────────────────────────────────────────────────────────────────

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
/** Decimal amount — mirrors the transfer tool's amountHuman schema. */
const AMOUNT_RE = /^\d+(?:\.\d{1,18})?$/;
export const AUTOMATION_RULE_CAP = 20;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Is `token` resolvable on `chainId`? Known symbol, the native currency, or a 0x ERC-20 address. */
export function tokenResolvable(chainId: number, token: string): string | null {
  const chain = getChainByChainId(chainId);
  if (!chain) return `Unknown chain id ${chainId}.`;
  const raw = token.trim();
  if (!raw) return "Token is required.";
  const sym = raw.toUpperCase();
  if (sym === chain.nativeCurrency.symbol.toUpperCase()) return null;
  if (chain.tokens.some((tk) => tk.symbol.toUpperCase() === sym)) return null;
  if (ADDR_RE.test(raw)) return null;
  return `Unknown token "${raw}" on ${chain.name} — use a known symbol or a 0x contract address.`;
}

export function validateTriggerConfig(
  triggerType: AutomationTriggerType,
  raw: unknown,
): ValidationResult<AutomationTriggerConfig> {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "triggerConfig must be an object." };
  }
  const cfg = raw as Record<string, unknown>;

  if (triggerType === "balance_above" || triggerType === "balance_below") {
    const chainId = Number(cfg.chainId);
    if (!Number.isInteger(chainId) || !getChainByChainId(chainId)) {
      return { ok: false, error: "triggerConfig.chainId must be a supported chain id." };
    }
    const token = typeof cfg.token === "string" ? cfg.token.trim() : "";
    const tokenErr = tokenResolvable(chainId, token);
    if (tokenErr) return { ok: false, error: tokenErr };
    const threshold = Number(cfg.threshold);
    if (!Number.isFinite(threshold) || threshold <= 0) {
      return { ok: false, error: "triggerConfig.threshold must be a positive number." };
    }
    return { ok: true, value: { chainId, token, threshold } };
  }

  if (triggerType === "attestation_ready") {
    const paymentId = typeof cfg.paymentId === "string" ? cfg.paymentId.trim() : "";
    if (!paymentId || paymentId.length > 100) {
      return { ok: false, error: "triggerConfig.paymentId must be a payment id." };
    }
    return { ok: true, value: { paymentId } };
  }

  // schedule
  const everyMinutes = Number(cfg.everyMinutes);
  if (!Number.isInteger(everyMinutes) || everyMinutes < 1 || everyMinutes > 1440) {
    return { ok: false, error: "triggerConfig.everyMinutes must be an integer between 1 and 1440." };
  }
  return { ok: true, value: { everyMinutes } };
}

export function validateAction(raw: unknown): ValidationResult<AutomationActionConfig> {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "actionJson must be an object." };
  }
  const cfg = raw as Record<string, unknown>;
  const kind = cfg.kind;

  if (kind === "notify") {
    const message = typeof cfg.message === "string" ? cfg.message.trim() : "";
    if (message.length < 2 || message.length > 300) {
      return { ok: false, error: 'actionJson.message must be 2-300 characters (kind "notify").' };
    }
    return { ok: true, value: { kind: "notify", message } };
  }

  if (kind === "transfer") {
    const chainId = Number(cfg.chainId);
    if (!Number.isInteger(chainId) || !getChainByChainId(chainId)) {
      return { ok: false, error: "actionJson.chainId must be a supported chain id." };
    }
    const token = typeof cfg.token === "string" ? cfg.token.trim() : "";
    const tokenErr = tokenResolvable(chainId, token);
    if (tokenErr) return { ok: false, error: tokenErr };
    const recipient = typeof cfg.recipient === "string" ? cfg.recipient.trim() : "";
    if (!ADDR_RE.test(recipient)) {
      return { ok: false, error: "actionJson.recipient must be a valid 0x address." };
    }
    const amount = typeof cfg.amount === "string" ? cfg.amount.trim() : String(cfg.amount ?? "");
    if (!AMOUNT_RE.test(amount) || Number(amount) <= 0) {
      return { ok: false, error: "actionJson.amount must be a positive decimal amount." };
    }
    return { ok: true, value: { kind: "transfer", chainId, token, recipient, amount } };
  }

  return { ok: false, error: 'actionJson.kind must be "transfer" or "notify".' };
}

export function isTriggerType(raw: unknown): raw is AutomationTriggerType {
  return typeof raw === "string" && (AUTOMATION_TRIGGER_TYPES as readonly string[]).includes(raw);
}

/** Parse a stored row's JSON columns into the client-facing rule shape. Returns null on unparsable rows (defensive). */
export function serializeRule(row: {
  id: string;
  name: string;
  triggerType: string;
  triggerConfigJson: string;
  actionJson: string;
  active: boolean;
  lastFiredAt: number | null;
  lastStatus: string | null;
  createdAt: number;
}):
  | {
      id: string;
      name: string;
      triggerType: string;
      triggerConfig: unknown;
      action: unknown;
      active: boolean;
      lastFiredAt: number | null;
      lastStatus: string | null;
      createdAt: number;
    }
  | null {
  let triggerConfig: unknown;
  let action: unknown;
  try {
    triggerConfig = JSON.parse(row.triggerConfigJson);
    action = JSON.parse(row.actionJson);
  } catch {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    triggerType: row.triggerType,
    triggerConfig,
    action,
    active: row.active,
    lastFiredAt: row.lastFiredAt,
    lastStatus: row.lastStatus,
    createdAt: row.createdAt,
  };
}
