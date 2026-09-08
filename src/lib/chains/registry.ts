import { defineChain, type Chain } from "viem";
import {
  mainnet as viemMainnet,
  sepolia as viemSepolia,
  base as viemBase,
  arbitrum as viemArbitrum,
  optimism as viemOptimism,
  polygon as viemPolygon,
  bsc as viemBsc,
} from "viem/chains";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 chain registry — the single source of truth for every chain the app
// knows about. Nothing else in the codebase may hardcode chain details: wallet
// wiring, RPC clients, the chain switcher, the agent's tools, and the Attestcoin
// flows all read from here. Adding a chain later = one entry here.
//
// Verified sources (2026-09-04, live):
//   Creditcoin Testnet  id 102031  tCTC  rpc.cc3-testnet.creditcoin.network
//   Creditcoin Mainnet  id 102030  CTC   mainnet3.creditcoin.network
//   chainKey semantics (Attestcoin testnet env): Sepolia=1, Ethereum=3.
// ─────────────────────────────────────────────────────────────────────────────

export interface TokenEntry {
  symbol: string;
  name: string;
  decimals: number;
  address: `0x${string}`;
  /** Nominal USD price used for action-log valuation (no live oracle in v1). */
}

export interface ChainDef {
  /** Stable slug key (used in DB prefs, tool args). */
  key: string;
  chainId: number;
  name: string;
  shortName: string;
  testnet: boolean;
  /** Public JSON-RPC endpoints (HTTP). First entry is primary. */
  rpcUrls: string[];
  /** Block explorer base URL (no trailing slash). */
  explorerUrl: string | null;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  /**
   * Can contracts be deployed here by default? Mainnets additionally require
   * the per-user opt-in (settings) — enforced in the deploy tool, not here.
   */
  deployAllowed: boolean;
  /** Role in the Attestcoin Protocol flows (null = not an Attestcoin chain). */
  attestcoin: {
    /** chainKey for this chain as an Attestcoin SOURCE (testnet environment). */
    sourceChainKey?: number;
    /** Destination chain for Attestcoin-verified releases (the ASC chain). */
    ascDestination?: boolean;
  } | null;
  /** Known ERC-20 tokens the agent can resolve by symbol on this chain. */
  tokens: TokenEntry[];
  /** Letter shown in the chain tile (UI). */
  tileLetter: string;
  /** Hex for the chain tile background. */
  tileColor: string;
}

export const CHAIN_REGISTRY: ChainDef[] = [
  {
    key: "creditcoin-testnet",
    chainId: 102031,
    name: "Creditcoin Testnet (CC3)",
    shortName: "Creditcoin TN",
    testnet: true,
    rpcUrls: ["https://rpc.cc3-testnet.creditcoin.network"],
    explorerUrl: "https://creditcoin-testnet.blockscout.com",
    nativeCurrency: { name: "Testnet CTC", symbol: "tCTC", decimals: 18 },
    deployAllowed: true,
    attestcoin: { ascDestination: true },
    tokens: [],
    tileLetter: "C",
    tileColor: "#0891b2",
  },
  {
    key: "creditcoin",
    chainId: 102030,
    name: "Creditcoin Mainnet (CC3)",
    shortName: "Creditcoin",
    testnet: false,
    rpcUrls: ["https://mainnet3.creditcoin.network", "https://creditcoin.drpc.org"],
    explorerUrl: "https://creditcoin.blockscout.com",
    nativeCurrency: { name: "Creditcoin", symbol: "CTC", decimals: 18 },
    deployAllowed: true,
    attestcoin: null,
    tokens: [],
    tileLetter: "C",
    tileColor: "#0e7490",
  },
  {
    key: "ethereum-sepolia",
    chainId: 11155111,
    name: "Ethereum Sepolia",
    shortName: "Sepolia",
    testnet: true,
    rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.drpc.org"],
    explorerUrl: "https://sepolia.etherscan.io",
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    deployAllowed: true,
    attestcoin: { sourceChainKey: 1 },
    tokens: [
      {
        // Circle's canonical testnet USDC (verified on-chain: symbol USDC,
        // 6 decimals). Without this entry the product's own suggested prompt
        // ("Send 12.5 USDC …") fails at execution with "Unknown token".
        symbol: "USDC",
        name: "USD Coin (Sepolia)",
        decimals: 6,
        address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      },
    ],
    tileLetter: "S",
    tileColor: "#0ea5e9",
  },
  {
    key: "ethereum",
    chainId: 1,
    name: "Ethereum",
    shortName: "Ethereum",
    testnet: false,
    rpcUrls: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"],
    explorerUrl: "https://etherscan.io",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    deployAllowed: false,
    attestcoin: { sourceChainKey: 3 },
    tokens: [
      {
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      },
      {
        symbol: "USDT",
        name: "Tether USD",
        decimals: 6,
        address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      },
    ],
    tileLetter: "E",
    tileColor: "#627eea",
  },
  {
    key: "base",
    chainId: 8453,
    name: "Base",
    shortName: "Base",
    testnet: false,
    rpcUrls: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
    explorerUrl: "https://basescan.org",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    deployAllowed: false,
    attestcoin: null,
    tokens: [
      {
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      },
    ],
    tileLetter: "B",
    tileColor: "#0052ff",
  },
  {
    key: "arbitrum",
    chainId: 42161,
    name: "Arbitrum One",
    shortName: "Arbitrum",
    testnet: false,
    rpcUrls: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"],
    explorerUrl: "https://arbiscan.io",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    deployAllowed: false,
    attestcoin: null,
    tokens: [
      {
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      },
    ],
    tileLetter: "A",
    tileColor: "#28a0f0",
  },
  {
    key: "optimism",
    chainId: 10,
    name: "OP Mainnet",
    shortName: "OP",
    testnet: false,
    rpcUrls: ["https://optimism-rpc.publicnode.com", "https://mainnet.optimism.io"],
    explorerUrl: "https://optimistic.etherscan.io",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    deployAllowed: false,
    attestcoin: null,
    tokens: [
      {
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
      },
    ],
    tileLetter: "O",
    tileColor: "#ff0420",
  },
  {
    key: "polygon",
    chainId: 137,
    name: "Polygon PoS",
    shortName: "Polygon",
    testnet: false,
    rpcUrls: ["https://polygon-bor-rpc.publicnode.com", "https://polygon-rpc.com"],
    explorerUrl: "https://polygonscan.com",
    nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
    deployAllowed: false,
    attestcoin: null,
    tokens: [
      {
        symbol: "USDC",
        name: "USD Coin (native)",
        decimals: 6,
        address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      },
      {
        symbol: "USDT",
        name: "Tether USD",
        decimals: 6,
        address: "0xc2132D05D31c914a90C53B0d1Bd1DAcFCDc9BBcB",
      },
    ],
    tileLetter: "P",
    tileColor: "#8247e5",
  },
  {
    key: "bnb",
    chainId: 56,
    name: "BNB Smart Chain",
    shortName: "BNB",
    testnet: false,
    rpcUrls: ["https://bsc-dataseed.bnbchain.org", "https://bsc-dataseed1.defibit.io"],
    explorerUrl: "https://bscscan.com",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    deployAllowed: false,
    attestcoin: null,
    tokens: [
      {
        symbol: "USDT",
        name: "Binance-Peg USD-T",
        decimals: 18,
        address: "0x55d398326f99059fF775485246999027B3197955",
      },
      {
        symbol: "USDC",
        name: "Binance-Peg USDC",
        decimals: 18,
        address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
      },
    ],
    tileLetter: "N",
    tileColor: "#f0b90b",
  },
];

// ── Lookups ──────────────────────────────────────────────────────────────────

const BY_ID = new Map<number, ChainDef>(CHAIN_REGISTRY.map((c) => [c.chainId, c]));
const BY_KEY = new Map<string, ChainDef>(CHAIN_REGISTRY.map((c) => [c.key, c]));

export function getChainByChainId(chainId: number): ChainDef | undefined {
  return BY_ID.get(chainId);
}

export function getChainByKey(key: string): ChainDef | undefined {
  return BY_KEY.get(key);
}

/** Resolve a chain from ANY of: registry key, chainId as number, chainId as string. */
export function resolveChainArg(value: string | number): ChainDef | undefined {
  if (typeof value === "number") return BY_ID.get(value);
  const raw = value.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return BY_ID.get(Number(raw));
  return BY_KEY.get(raw.toLowerCase());
}

export const ALL_CHAIN_IDS = CHAIN_REGISTRY.map((c) => c.chainId);

/** Attestcoin destination chain (where ASCs live) for the current phase. */
export function attestcoinDestinationChain(): ChainDef {
  const c = CHAIN_REGISTRY.find((x) => x.attestcoin?.ascDestination);
  if (!c) throw new Error("No Attestcoin destination chain configured");
  return c;
}

/** Attestcoin SOURCE chains readable in the current environment (testnet env). */
export function attestcoinSourceChains(): ChainDef[] {
  return CHAIN_REGISTRY.filter((c) => typeof c.attestcoin?.sourceChainKey === "number");
}

// ── viem chains (wallet wiring) ──────────────────────────────────────────────

const creditcoinTestnetViem = defineChain({
  id: 102031,
  name: "Creditcoin Testnet (CC3)",
  nativeCurrency: { name: "Testnet CTC", symbol: "tCTC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.cc3-testnet.creditcoin.network"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://creditcoin-testnet.blockscout.com" } },
});

const creditcoinMainnetViem = defineChain({
  id: 102030,
  name: "Creditcoin Mainnet (CC3)",
  nativeCurrency: { name: "Creditcoin", symbol: "CTC", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://mainnet3.creditcoin.network", "https://creditcoin.drpc.org"] },
  },
  blockExplorers: { default: { name: "Blockscout", url: "https://creditcoin.blockscout.com" } },
});

/** viem Chain objects keyed by chainId, in registry order. */
export const VIEM_CHAINS: Record<number, Chain> = {
  102031: creditcoinTestnetViem,
  102030: creditcoinMainnetViem,
  1: viemMainnet,
  11155111: viemSepolia,
  8453: viemBase,
  42161: viemArbitrum,
  10: viemOptimism,
  137: viemPolygon,
  56: viemBsc,
};

