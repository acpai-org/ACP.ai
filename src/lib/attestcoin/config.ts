// ─────────────────────────────────────────────────────────────────────────────
// Attestcoin Protocol network configuration (server-side).
//
// Endpoints are from the authoritative developer docs
// ("Attestcoin Protocol Chains - Environments"):
//   CC3 Mainnet:  rpc.cc3-mainnet.creditcoin.network
//                 proofbuilder.cc3-mainnet-usc.creditcoin.network
//                 dashboard.cc3-mainnet-usc.creditcoin.network
//   CC3 Testnet:  rpc.cc3-testnet.creditcoin.network
//                 proof-gen-api.cc3-testnet.creditcoin.network
//                 dashboard.cc3-testnet.creditcoin.network
//
// The environment (testnet by default) is selected via ATTESTCOIN_NETWORK.
// Proof *submission* (Block Prover Precompile, 0x0FD2) needs a funded
// Creditcoin account and is intentionally NOT wired yet:
// TODO(phase-2): on-chain verification submission once a signer exists.
// ─────────────────────────────────────────────────────────────────────────────

export type AttestcoinEnv = "testnet" | "mainnet";

export interface AttestcoinEndpoints {
  /** HTTPS JSON-RPC endpoint of the Creditcoin chain (the SDK uses HTTP, not WSS). */
  rpcUrl: string;
  /** Hosted proof-builder REST base (serves /api/v1/n/{chainKey}/{txHash}). */
  proofBuilderUrl: string;
  /** ASC dashboard (human-facing). */
  dashboardUrl: string;
  /** Decoder contract on Creditcoin (for ABI-decoding verified tx bytes). */
  decoderAddress: string;
  /** ChainInfo precompile (supported chains, attested heights). */
  chainInfoPrecompile: string;
  /** Block Prover precompile (on-chain proof verification). Phase-2. */
  blockProverPrecompile: string;
}

const ENDPOINTS: Record<AttestcoinEnv, AttestcoinEndpoints> = {
  mainnet: {
    rpcUrl: "https://rpc.cc3-mainnet.creditcoin.network",
    proofBuilderUrl: "https://proofbuilder.cc3-mainnet-usc.creditcoin.network",
    dashboardUrl: "https://dashboard.cc3-mainnet-usc.creditcoin.network",
    decoderAddress: "0x9D094C9f22B10FCf842c2fC6A0981630A4F94B5C",
    chainInfoPrecompile: "0x0000000000000000000000000000000000000fd3",
    blockProverPrecompile: "0x0000000000000000000000000000000000000FD2",
  },
  testnet: {
    rpcUrl: "https://rpc.cc3-testnet.creditcoin.network",
    proofBuilderUrl: "https://proof-gen-api.cc3-testnet.creditcoin.network",
    dashboardUrl: "https://dashboard.cc3-testnet.creditcoin.network",
    decoderAddress: "0x731c345d79Fb8BbDC541f9DF3b6317585F849F9f",
    chainInfoPrecompile: "0x0000000000000000000000000000000000000fd3",
    blockProverPrecompile: "0x0000000000000000000000000000000000000FD2",
  },
};

/**
 * Static source-chain metadata.
 *
 * ⚠ C2/G1: the chainKey column below holds TESTNET assignments only
 * (Sepolia→1, Ethereum→3 — mainnet Ethereum is chainKey 1). The authoritative
 * evmChainId↔chainKey mapping is derived LIVE from the ChainInfo precompile
 * in ./chains.ts; this list contributes the display name + head RPC (keyed by
 * evmChainId — those are env-independent) and acts as a fallback ONLY on
 * testnet while the live map hasn't loaded. Never extend the keys by hand.
 */
export interface SourceChainInfo {
  chainKey: number;
  /** EVM chain id as used inside the app (payments store this in their row). */
  evmChainId: number;
  name: string;
  /** Public RPC used to read the chain head (lag calculation). */
  headRpcUrl: string;
}

export const SOURCE_CHAINS: SourceChainInfo[] = [
  {
    chainKey: 1,
    evmChainId: 11155111,
    name: "Ethereum Sepolia",
    headRpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  },
  {
    chainKey: 3,
    evmChainId: 1,
    name: "Ethereum",
    headRpcUrl: "https://ethereum-rpc.publicnode.com",
  },
];

// sourceChainByEvmId / sourceChainByKey now live in ./chains.ts (live
// ChainInfo-derived resolution — see the G1 note above).

export function attestcoinEnv(): AttestcoinEnv {
  const raw = process.env.ATTESTCOIN_NETWORK?.toLowerCase();
  return raw === "mainnet" ? "mainnet" : "testnet";
}

export function attestcoinEndpoints(): AttestcoinEndpoints {
  return ENDPOINTS[attestcoinEnv()];
}

/** Hard ceiling for any single upstream network call. */
export const ATTESTCOIN_TIMEOUT_MS = 10_000;
