import { getChainByChainId } from "@/lib/chains/registry";

// ─────────────────────────────────────────────────────────────────────────────
// Network-fee estimates for confirmation cards (brief §5 — the user should see
// what an action COSTS before approving it, not only after signing).
//
// Architecture (decision, logged in the worklog):
//   Server owns the DETERMINISTIC half — gas UNITS. It validated the tool args
//   and knows the exact tx shapes the client executors build (native transfer
//   21k, ERC-20 transfer 65k, deployments from solc's creation estimate).
//   Client owns the LIVE half — gas PRICE, fetched from the chain's RPC when
//   the card renders (react-query), so the number is fresh and survives chain
//   switches between runs.
//
//   fee = gasUnits × gasPrice. Everything is labeled "≈" — the wallet shows
//   the exact gas at signing (the executors never set gasLimit themselves).
//
// USD conversion uses the registry's nominal native price — the SAME source
// as the action-log USD valuation (consistency: an action "worth $3" that costs
// "$0.02 of gas" are quoted from one map, not two).
// ─────────────────────────────────────────────────────────────────────────────

export interface FeeBreakdownEntry {
  /** Short English label (server-built, like confirmation summaries). */
  label: string;
  /** Gas units for this tx (decimal string — bigint-safe over the wire). */
  gasUnits: string;
  /** Chain this tx runs on (multi-chain tools like the swap); defaults to the request's chain. */
  chainId?: number;
}

export interface FeeEstimate {
  /** Total gas units across all txs (decimal string). */
  gasUnits: string;
  /** Per-tx entries for multi-tx tools (batch, swap). */
  breakdown?: FeeBreakdownEntry[];
}

/** Plain native transfer (EIP-158 base cost). */
export const NATIVE_TRANSFER_GAS = 21_000n;
/** Standard ERC-20 transfer (USDC/USDT-class, transfer() to an EOA). */
export const ERC20_TRANSFER_GAS = 65_000n;
/** Unknown-address ERC-20 (defensive: covers odd receivers / non-standard tokens). */
export const UNKNOWN_ERC20_TRANSFER_GAS = 80_000n;
/**
 * Proof-verified release (execute_conditional_release / swap release).
 * Merkle+continuity verification through the inlined EvmV1Decoder plus the
 * release state change; solc reports "infinite" for the unbounded sibling
 * loop, so this is a nominal with the "≈" label and the wallet-exact caveat.
 */
export const RELEASE_GAS_NOMINAL = 400_000n;
/** Plain native transfer to a contract (the swap's destination funding tx). */
export const FUND_TRANSFER_GAS = 21_000n;

/** Gas units for one transfer-shaped tx, from its (already-validated) args. */
export function transferGasUnits(chainId: number, token: string): bigint {
  const chain = getChainByChainId(chainId);
  const sym = (token ?? "").toUpperCase();
  if (chain && sym === chain.nativeCurrency.symbol.toUpperCase()) return NATIVE_TRANSFER_GAS;
  if (chain && chain.tokens.some((tk) => tk.symbol.toUpperCase() === sym)) return ERC20_TRANSFER_GAS;
  if (/^0x[a-fA-F0-9]{40}$/.test(token ?? "")) return UNKNOWN_ERC20_TRANSFER_GAS;
  // Unresolved symbol → the executor treats it as an ERC-20 or fails loudly.
  return ERC20_TRANSFER_GAS;
}

export function buildTransferFeeEstimate(args: Record<string, unknown>): FeeEstimate {
  const chainId = typeof args.chain === "number" ? args.chain : 102031;
  const units = transferGasUnits(chainId, String(args.token ?? ""));
  return { gasUnits: units.toString() };
}

export function buildBatchFeeEstimate(args: Record<string, unknown>): FeeEstimate {
  const chainId = typeof args.chain === "number" ? args.chain : 102031;
  const transfers = Array.isArray(args.transfers) ? (args.transfers as Array<Record<string, unknown>>) : [];
  const entries: FeeBreakdownEntry[] = transfers.map((t, i) => ({
    label: `Transfer ${i + 1} · ${String(t.amount ?? "?")} ${String(t.token ?? "?")}`,
    gasUnits: transferGasUnits(chainId, String(t.token ?? "")).toString(),
  }));
  return sumFeeBreakdown(entries);
}

/** Deployment estimate straight from solc's creation gas (compile artifact). */
export function deployFeeEstimate(creationGas: string | null | undefined): FeeEstimate | null {
  const n = Number(creationGas ?? "");
  if (!Number.isFinite(n) || n <= 0) return null;
  return { gasUnits: String(Math.ceil(n)) };
}

/** Sum per-tx entries into a total (+ keep the breakdown for the card). */
export function sumFeeBreakdown(entries: FeeBreakdownEntry[]): FeeEstimate {
  let total = 0n;
  for (const e of entries) {
    try {
      total += BigInt(e.gasUnits);
    } catch {
      /* skip malformed */
    }
  }
  return entries.length > 1
    ? { gasUnits: total.toString(), breakdown: entries }
    : { gasUnits: total.toString() };
}

/**
 * Fee estimate for execute_conditional_release — a single release call.
 * (Nominal — see RELEASE_GAS_NOMINAL.)
 */
export function releaseFeeEstimate(): FeeEstimate {
  return { gasUnits: RELEASE_GAS_NOMINAL.toString() };
}
