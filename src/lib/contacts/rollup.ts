import { getAddress } from "viem";

// ─────────────────────────────────────────────────────────────────────────────
// Contact payment rollup (R13-A): a client-side join between the payments
// history and the address book, grouped by RECIPIENT address. The payments
// page and the contacts page share the TanStack Query cache (same
// ["payments"] key), so this join costs one local API read, not two.
//
// Pure data-shaping only — no React, no fetch, no Date.now (callers pass the
// payments array straight from the query cache; `now` is a render-time input
// owned by the component). Safe against malformed stored addresses: the
// normalizer falls back to lowercase comparison when checksumming throws.
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal payment shape the rollup needs (structurally satisfied by PaymentRow). */
export interface RollupPayment {
  id: string;
  recipientAddress: string;
  recipientLabel: string | null;
  amountHuman: string;
  token: string;
  memo: string | null;
  status: string;
  chainId: number;
  createdAt: number;
}

export interface SettledTokenTotal {
  token: string;
  count: number;
  /** Sum of settled amountHuman values for this token, display-formatted. */
  total: string;
}

export interface ContactRollup {
  /** Total payments whose recipient matches the contact's address. */
  total: number;
  /** Subset of total with a terminal-success status. */
  settled: number;
  /** Subset of total in a non-terminal state (signing/settling/sent/…). */
  inFlight: number;
  /** Newest payment by createdAt (any status), null when total === 0. */
  last: RollupPayment | null;
  /** Up to `limit` newest payments, newest first (default 3). */
  recent: RollupPayment[];
  /**
   * R14 (settled totals): per-token sums over SETTLED payments only — the
   * honesty rule (N21/P6) forbids cross-symbol totals, so one entry per
   * distinct token, sorted by settled count desc then token asc. Empty when
   * no settled payments exist for this payee.
   */
  settledTotals: SettledTokenTotal[];
}

/** Statuses that mean money moved and the flow is complete. */
const SETTLED_STATUSES = new Set(["settled"]);

/** In-flight family — mirrors the payments page's isPendingStatus predicate. */
const IN_FLIGHT_STATUSES = new Set([
  "pending",
  "signing",
  "settling",
  "sent",
  "approving",
  "deploying",
]);

/**
 * Canonical grouping key for an address: checksummed when the stored value is
 * a well-formed address, else the raw lowercase string (defensive — a legacy
 * or corrupted row must never crash the card render).
 */
export function payeeKey(address: string): string {
  try {
    return getAddress(address);
  } catch {
    return address.toLowerCase();
  }
}

/**
 * Sum settled amountHuman values per token. Amounts are the app's own
 * decimal strings; values that fail to parse (legacy/corrupted rows) are
 * COUNTED but skipped from the sum rather than crashing the card. The sum
 * is formatted with at most 6 decimals, trailing zeros trimmed.
 */
export function settledTotalsByToken(payments: readonly RollupPayment[]): SettledTokenTotal[] {
  const byToken = new Map<string, { count: number; sum: number }>();
  for (const p of payments) {
    if (!SETTLED_STATUSES.has(p.status)) continue;
    const bucket = byToken.get(p.token) ?? { count: 0, sum: 0 };
    bucket.count++;
    const value = Number(p.amountHuman);
    if (Number.isFinite(value)) bucket.sum += value;
    byToken.set(p.token, bucket);
  }
  return [...byToken.entries()]
    .map(([token, { count, sum }]) => ({ token, count, total: formatAmount(sum) }))
    .sort((a, b) => b.count - a.count || a.token.localeCompare(b.token));
}

/** Decimal-safe display formatting for an amount sum (≤6 dp, trimmed). */
function formatAmount(sum: number): string {
  // toFixed(6) keeps small sums out of exponent form; trailing zeros (and a
  // trailing dot) are trimmed so "87.000000" renders as "87", "87.500000" as
  // "87.5". Values below 1e-6 round to "0" — honest display of a dust sum.
  let s = sum.toFixed(6);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

/**
 * Group payments by recipient and reduce each group to a rollup.
 * Sort order inside a group is createdAt DESC, newest first. Payments are
 * never mutated (sorted copies).
 */
export function rollupsByPayee(
  payments: readonly RollupPayment[],
  limit = 3,
): Map<string, ContactRollup> {
  const byPayee = new Map<string, RollupPayment[]>();
  for (const p of payments) {
    const key = payeeKey(p.recipientAddress);
    const bucket = byPayee.get(key);
    if (bucket) bucket.push(p);
    else byPayee.set(key, [p]);
  }

  const out = new Map<string, ContactRollup>();
  for (const [key, group] of byPayee) {
    const sorted = [...group].sort((a, b) => b.createdAt - a.createdAt);
    let settled = 0;
    let inFlight = 0;
    for (const p of sorted) {
      if (SETTLED_STATUSES.has(p.status)) settled++;
      else if (IN_FLIGHT_STATUSES.has(p.status)) inFlight++;
    }
    out.set(key, {
      total: sorted.length,
      settled,
      inFlight,
      last: sorted[0] ?? null,
      recent: sorted.slice(0, Math.max(0, limit)),
      settledTotals: settledTotalsByToken(sorted),
    });
  }
  return out;
}

/** Status → semantic tone for the rollup's status dot (shared with rows). */
export function rollupStatusTone(status: string): "success" | "warning" | "danger" | "primary" | "muted" {
  if (SETTLED_STATUSES.has(status)) return "success";
  if (status === "failed" || status === "declined" || status === "rejected") return "danger";
  if (IN_FLIGHT_STATUSES.has(status)) return "warning";
  if (status === "attested") return "primary";
  return "muted";
}
