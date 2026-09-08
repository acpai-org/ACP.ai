import { getChainByChainId } from "@/lib/chains/registry";

// ─────────────────────────────────────────────────────────────────────────────
// CC3 (Creditcoin chain) deep links — N27.1: every Attestcoin record the app
// shows must be VIEWABLE. The chain registry carries the doc-verified
// Blockscout explorer hosts per environment:
//   testnet → creditcoin-testnet.blockscout.com (chainId 102031)
//   mainnet → creditcoin.blockscout.com         (chainId 102030)
// This module is client-safe (registry imports viem only) so the Actions log,
// the payment attestation card, and the agent's server-side tool results all
// derive links from ONE source of truth.
// ─────────────────────────────────────────────────────────────────────────────

export type Cc3Env = "testnet" | "mainnet";

/** CC3 chain id for the configured Attestcoin environment (registry-truth). */
export function cc3ChainId(env: Cc3Env): number {
  return env === "mainnet" ? 102030 : 102031;
}

/** Blockscout transaction URL on the CC3 chain for the given environment. */
export function cc3ExplorerTxUrl(env: Cc3Env | string | undefined, txHash: string): string | null {
  const chain = getChainByChainId(cc3ChainId(env === "mainnet" ? "mainnet" : "testnet"));
  return chain?.explorerUrl ? `${chain.explorerUrl}/tx/${txHash}` : null;
}

/** Source-chain explorer tx URL (any registry chain; null when unknown). */
export function sourceExplorerTxUrl(chainId: number | null | undefined, txHash: string): string | null {
  if (!chainId) return null;
  const chain = getChainByChainId(chainId);
  return chain?.explorerUrl ? `${chain.explorerUrl}/tx/${txHash}` : null;
}
