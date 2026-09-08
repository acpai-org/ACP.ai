"use client";

import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { createPublicClient, http, formatUnits } from "viem";
import { getChainByChainId, VIEM_CHAINS } from "@/lib/chains/registry";
import type { ConfirmationRequest } from "@/lib/agent/events";

// ─────────────────────────────────────────────────────────────────────────────
// Live half of the confirmation-card fee estimate (brief §5).
//
// The server sends deterministic gas UNITS (fee-estimate.ts); this hook fetches
// the LIVE gas price for each chain the action touches — the same registry RPC
// endpoints the receipt pollers already use from the browser — and combines:
//
//   fee = Σ per-tx (gasUnits × that chain's gasPrice)
//
// Multi-chain tools (the swap: Sepolia lock + Creditcoin deploy/fund/release)
// are priced PER CHAIN — never one chain's price times another chain's units.
// USD uses the registry's nominal native prices, the SAME map the action log
// denomination uses (one price source, not two). Everything stays labeled "≈":
// the wallet shows the exact gas at signing (executors never set gasLimit).
//
// Entry counts are tiny (≤4) and chain sets are stable per request, so the
// per-render derivation below is trivial — no memo gymnastics needed.
// ─────────────────────────────────────────────────────────────────────────────

/** 3 significant digits, exponent-safe (locale formatter expands 4.6e-7 → 0.00000046). */
function sig(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return value.toLocaleString("en-US", { maximumSignificantDigits: 3 });
}

function gasPriceQueryOptions(chainId: number) {
  return {
    queryKey: ["gas-price", chainId],
    staleTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const chain = getChainByChainId(chainId);
      if (!chain || chain.rpcUrls.length === 0) throw new Error("no rpc");
      const client = createPublicClient({
        chain: VIEM_CHAINS[chainId] ?? undefined,
        transport: http(chain.rpcUrls[0], { timeout: 10_000 }),
      });
      return client.getGasPrice();
    },
  };
}

export interface FeeEntryView {
  label: string;
  gasUnits: bigint;
  chainId: number;
  /** Formatted native fee when the price resolved, else null. */
  feeNative: string | null;
  symbol: string;
}

export interface FeeEstimateView {
  state: "none" | "loading" | "partial" | "ready" | "unavailable";
  entries: FeeEntryView[];
  /** Total fee per native symbol, e.g. { ETH: "0.00013", tCTC: "0.0021" } (ready/partial). */
  totals: Record<string, string>;
}

export function useFeeEstimate(request: ConfirmationRequest): FeeEstimateView {
  const { feeEstimate, chainId: requestChainId } = request;

  // Resolve tx entries: the breakdown when present, else one single-tx entry.
  const entries = useMemo(() => {
    if (!feeEstimate || requestChainId == null) return [] as Array<{ label: string; gasUnits: bigint; chainId: number }>;
    const raw = (feeEstimate.breakdown && feeEstimate.breakdown.length > 0
      ? feeEstimate.breakdown
      : [{ label: "", gasUnits: feeEstimate.gasUnits, chainId: requestChainId }]) as Array<{
      label: string;
      gasUnits: string;
      chainId?: number;
    }>;
    const out: Array<{ label: string; gasUnits: bigint; chainId: number }> = [];
    for (const e of raw) {
      try {
        const units = BigInt(e.gasUnits);
        if (units > 0n) out.push({ label: e.label, gasUnits: units, chainId: e.chainId ?? requestChainId });
      } catch {
        /* skip malformed */
      }
    }
    return out;
  }, [feeEstimate, requestChainId]);

  const uniqueChainIds = useMemo(
    () => [...new Set(entries.map((e) => e.chainId))],
    [entries],
  );

  const gasPriceQueries = useQueries({
    queries: uniqueChainIds.map((id) => gasPriceQueryOptions(id)),
  });
  // useQueries is positional; uniqueChainIds order is stable, so index join is safe.

  // Price map (bigint | null per chain; null = failed/unavailable).
  const priceByChain = new Map<number, bigint | null>();
  let anyPending = false;
  uniqueChainIds.forEach((id, i) => {
    const q = gasPriceQueries[i];
    if (!q || q.isPending) anyPending = true;
    priceByChain.set(id, q && !q.isError && q.data != null ? (q.data as bigint) : null);
  });

  const entryViews: FeeEntryView[] = entries.map((e) => {
    const chain = getChainByChainId(e.chainId);
    const price = priceByChain.get(e.chainId) ?? null;
    const feeNative =
      price != null && chain
        ? sig(Number(formatUnits(e.gasUnits * price, chain.nativeCurrency.decimals)))
        : null;
    return {
      label: e.label,
      gasUnits: e.gasUnits,
      chainId: e.chainId,
      feeNative,
      symbol: chain?.nativeCurrency.symbol ?? "",
    };
  });

  if (entries.length === 0) return { state: "none", entries: [], totals: {} };
  if (anyPending) return { state: "loading", entries: entryViews, totals: {} };

  const pricedChains = uniqueChainIds.filter((id) => priceByChain.get(id) != null);
  if (pricedChains.length === 0) {
    return { state: "unavailable", entries: entryViews, totals: {} };
  }

  // Totals per native symbol (P6: no USD conversion — fees are quoted in the
  // chains' own native tokens; there is no real fiat source for them).
  const totals: Record<string, string> = {};
  const totalsNum: Record<string, number> = {};
  for (const e of entryViews) {
    const chain = getChainByChainId(e.chainId);
    if (!chain) continue;
    const price = priceByChain.get(e.chainId);
    if (price == null) continue; // partial: this chain unpriced
    const feeNum = Number(formatUnits(e.gasUnits * price, chain.nativeCurrency.decimals));
    if (!Number.isFinite(feeNum)) continue;
    totalsNum[chain.nativeCurrency.symbol] = (totalsNum[chain.nativeCurrency.symbol] ?? 0) + feeNum;
  }
  for (const [sym, n] of Object.entries(totalsNum)) totals[sym] = sig(n);

  const state: FeeEstimateView["state"] = pricedChains.length === uniqueChainIds.length ? "ready" : "partial";
  return { state, entries: entryViews, totals };
}
