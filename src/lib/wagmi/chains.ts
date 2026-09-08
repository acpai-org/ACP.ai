import type { AppKitNetwork } from "@reown/appkit/networks";
import {
  CHAIN_REGISTRY,
  VIEM_CHAINS,
  getChainByChainId,
  type ChainDef,
} from "@/lib/chains/registry";

// ─────────────────────────────────────────────────────────────────────────────
// Wallet wiring — DERIVED from src/lib/chains/registry.ts (single source of
// truth). Every registry chain goes into the AppKit/WagmiAdapter `networks`
// array so the WalletConnect session's eip155 namespace covers the whole set
// with ONE approval; injected wallets pre-add the two custom Creditcoin chains
// at connect time (see src/lib/wagmi/provision.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const networks: [AppKitNetwork, ...AppKitNetwork[]] = CHAIN_REGISTRY.map(
  (c) => VIEM_CHAINS[c.chainId] as unknown as AppKitNetwork,
) as [AppKitNetwork, ...AppKitNetwork[]];

export const NETWORKS_BY_ID: Record<number, AppKitNetwork> = Object.fromEntries(
  CHAIN_REGISTRY.map((c) => [c.chainId, VIEM_CHAINS[c.chainId] as unknown as AppKitNetwork]),
);

export const DEFAULT_CHAIN_ID = 102031; // Creditcoin Testnet — the Attestcoin chain

export function networkName(chainId?: number): string {
  if (!chainId) return "Not connected";
  return getChainByChainId(chainId)?.name ?? `Chain ${chainId}`;
}

export interface TokenInfo {
  address: `0x${string}` | null;
  decimals: number;
  symbol: string;
  name: string;
}

/** Known ERC-20 tokens per chain (registry-derived). Native tokens resolve to null address. */
export function getUsdc(chainId?: number): TokenInfo | null {
  if (!chainId) return null;
  const chain = getChainByChainId(chainId);
  const usdc = chain?.tokens.find((t) => t.symbol.toUpperCase() === "USDC");
  if (!usdc) return null;
  return { address: usdc.address, decimals: usdc.decimals, symbol: usdc.symbol, name: usdc.name };
}

/** Resolve a token symbol on a chain: known ERC-20 or the native currency. */
export function resolveTokenSymbol(chainId: number, symbol: string): TokenInfo | null {
  const chain = getChainByChainId(chainId);
  if (!chain) return null;
  const sym = symbol.toUpperCase();
  if (sym === chain.nativeCurrency.symbol.toUpperCase()) {
    return {
      address: null,
      decimals: chain.nativeCurrency.decimals,
      symbol: chain.nativeCurrency.symbol,
      name: chain.nativeCurrency.name,
    };
  }
  const token = chain.tokens.find((t) => t.symbol.toUpperCase() === sym);
  if (!token) return null;
  return { address: token.address, decimals: token.decimals, symbol: token.symbol, name: token.name };
}

function explorerBase(chainId: number): string | null {
  return getChainByChainId(chainId)?.explorerUrl ?? null;
}

export function explorerTxUrl(chainId: number, txHash: string): string {
  const base = explorerBase(chainId);
  return base ? `${base}/tx/${txHash}` : "#";
}

export function explorerAddressUrl(chainId: number, address: string): string {
  const base = explorerBase(chainId);
  return base ? `${base}/address/${address}` : "#";
}

export function rpcUrl(chainId?: number): string {
  const chain = chainId ? getChainByChainId(chainId) : undefined;
  return chain?.rpcUrls[0] ?? "https://rpc.cc3-testnet.creditcoin.network";
}

/** Registry passthroughs for UI components. */
export { CHAIN_REGISTRY, getChainByChainId };
export type { ChainDef };

// Back-compat alias (Phase 1 name).
export const BASE_NETWORKS = networks;
