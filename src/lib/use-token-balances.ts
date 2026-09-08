"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccount, useChainId } from "wagmi";

// ─────────────────────────────────────────────────────────────────────────────
// useTokenBalances (C8 rewrite): REAL ERC-20 discovery through
// /api/wallet/tokens (server-side Blockscout V2 with RPC fallback for chains
// without a free explorer API).
//
// Back-compat: the public DiscoveredToken shape ({address, symbol, name,
// decimals, balance(base units), usdValue, logoUri, chainId}) is unchanged —
// the pollers/chat/recurring views keep working — enriched with live price and
// formatted fields for the Wallet tab.
// ─────────────────────────────────────────────────────────────────────────────

export interface DiscoveredToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  /** Base-unit balance as a decimal string (BigInt-compatible). */
  balance: string;
  /** Total USD value as a plain string ("0" when unpriced — back-compat). */
  usdValue: string;
  logoUri?: string;
  chainId?: number;
  // ── C8 enrichments ──
  /** Pre-formatted human balance (server-computed). */
  balanceHuman?: string;
  /** Live USD price per token when the explorer provides one. */
  priceUsd?: number | null;
  /** Total USD value as a number when priced. */
  usdValueNum?: number | null;
  /** Discovery source: "explorer" = full on-chain scan, "known" = registry tokens. */
  source?: "explorer" | "known";
  /** True when the agent can resolve this token by symbol (registry entry). */
  inRegistry?: boolean;
}

interface TokensResponse {
  source: "explorer" | "known";
  tokens: {
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    rawBalance: string;
    balanceHuman: string;
    logoUri: string | null;
    priceUsd: number | null;
    usdValue: number | null;
    inRegistry: boolean;
  }[];
}

const QUERY_KEY = "wallet-token-balances";

export function useTokenBalances(override?: { chainId?: number }) {
  const { address, isConnected } = useAccount();
  const activeChainId = useChainId();
  // N12: an explicit chain override lets forms (e.g. the recurring schedule
  // creator) list the user's holdings for a chain OTHER than the wallet's
  // currently-active one. No override → the wallet's active chain.
  const chainId = override?.chainId ?? activeChainId;

  const enabled = Boolean(isConnected && address && chainId);

  return useQuery<DiscoveredToken[]>({
    queryKey: [QUERY_KEY, chainId, address],
    queryFn: async () => {
      if (!address || !chainId) return [];
      const res = await fetch(
        `/api/wallet/tokens?chainId=${chainId}&address=${address}`,
        { cache: "no-store" },
      );
      if (!res.ok) return [];
      const json = (await res.json()) as TokensResponse;
      return json.tokens.map((t) => ({
        address: t.address,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
        balance: t.rawBalance,
        usdValue: t.usdValue != null ? String(t.usdValue.toFixed(2)) : "0",
        logoUri: t.logoUri ?? undefined,
        chainId,
        balanceHuman: t.balanceHuman,
        priceUsd: t.priceUsd,
        usdValueNum: t.usdValue,
        source: json.source,
        inRegistry: t.inRegistry,
      }));
    },
    enabled,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}
