import { type Address } from "viem";

// ─────────────────────────────────────────────────────────────────────────────
// Server/client-shared chain configs used by the generic payment flow.
// Phase 1 scaffold: minimal generic EVM chains (Ethereum Sepolia + Mainnet).
// TODO(phase-2): the Attestcoin Protocol integration will decide the real
// source-chain / settlement-chain topology — do not bake contracts in here yet.
// ─────────────────────────────────────────────────────────────────────────────

export interface ChainConfig {
  name: string;
  chainId: number;
  rpcUrl: string;
  /**
   * Known stablecoin contract for the chain, if any. USDC-style tokens resolve
   * here; when null the payment flow requires an explicit token address.
   */
  stablecoin: {
    address: Address;
    symbol: string;
    decimals: number;
  } | null;
  blockscoutUrl?: string;
}

export const CHAIN_CONFIGS: Record<string, ChainConfig> = {
  "ethereum-sepolia": {
    name: "ethereum-sepolia",
    chainId: 11155111,
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    stablecoin: null,
  },
  ethereum: {
    name: "ethereum",
    chainId: 1,
    rpcUrl: "https://ethereum-rpc.publicnode.com",
    stablecoin: {
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address,
      symbol: "USDC",
      decimals: 6,
    },
  },
} as const;

export const DEFAULT_CHAIN_NAME = "ethereum-sepolia";

export function getChainConfig(name: string | undefined): ChainConfig {
  const chainName = name ?? DEFAULT_CHAIN_NAME;
  const cfg = CHAIN_CONFIGS[chainName];
  if (!cfg) {
    throw new Error(`Unknown chain: ${chainName}`);
  }
  return cfg;
}

export function getChainByChainId(chainId: number): ChainConfig | undefined {
  return Object.values(CHAIN_CONFIGS).find((c) => c.chainId === chainId);
}
