import { JsonRpcProvider } from "ethers";
import { chainInfo as chainInfoModule } from "@gluwa/usc-sdk";
import {
  attestcoinEndpoints,
  attestcoinEnv,
  SOURCE_CHAINS,
  type AttestcoinEnv,
  type SourceChainInfo,
} from "./config";

// ─────────────────────────────────────────────────────────────────────────────
// Live source-chain resolution (C2 / G1).
//
// The static SOURCE_CHAINS list pins TESTNET chain-key assignments
// (Sepolia→1, Ethereum→3). On mainnet Ethereum's chainKey is 1, so the static
// map would silently answer WRONG chain keys — every proof lookup would then
// query the wrong chain. The fix: derive the evmChainId↔chainKey mapping from
// the ChainInfo precompile (live, per-env) and use the static list only for
// labels/head-RPCs (keyed by evmChainId — those stay correct) and as a
// fallback while the live map hasn't loaded AND we're on testnet.
//
// The lookups stay synchronous (dozens of call sites); the live map is
// refreshed by `ensureSourceChainMapFresh()` which decision points (poller,
// proof routes, agent tools) await before resolving. A failed refresh keeps
// the stale map — honest degradation, never a wrong-chain answer on mainnet.
// ─────────────────────────────────────────────────────────────────────────────

const MAP_TTL_MS = 10 * 60_000;

export interface LiveChainEntry {
  chainKey: number;
  evmChainId: number;
  /** On-chain name (decoded from hex by the fetcher). */
  name: string;
}

interface ChainMapState {
  env: string;
  at: number;
  entries: LiveChainEntry[];
  inFlight: Promise<void> | null;
}

const globalForChains = globalThis as unknown as {
  __acpSourceChainMap?: ChainMapState;
};

function mapState(): ChainMapState {
  globalForChains.__acpSourceChainMap ??= { env: "", at: 0, entries: [], inFlight: null };
  return globalForChains.__acpSourceChainMap;
}

async function fetchSupportedChains(): Promise<LiveChainEntry[]> {
  const { rpcUrl } = attestcoinEndpoints();
  const provider = new JsonRpcProvider(rpcUrl, undefined, {
    staticNetwork: true,
    batchStallTime: 200,
  });
  const chainInfo = new chainInfoModule.PrecompileChainInfoProvider(provider);
  const raw = await chainInfo.getSupportedChains();
  const entries: LiveChainEntry[] = [];
  for (const c of raw) {
    if (typeof c.chainKey !== "number" || typeof c.chainId !== "number") continue;
    // ChainInfo.chainName comes back as a 0x-prefixed hex string (E3 in the
    // inventory) — decode it, but never let a bad name drop the chain.
    let name = c.chainName ?? "";
    if (name.startsWith("0x")) {
      try {
        name = Buffer.from(name.slice(2), "hex").toString("utf8");
      } catch {
        name = "";
      }
    }
    entries.push({ chainKey: c.chainKey, evmChainId: c.chainId, name: name.trim() });
  }
  return entries;
}

/**
 * Refresh the live chain map if older than MAP_TTL_MS. Never throws — a failed
 * refresh leaves the previous map (or the empty initial map) in place.
 */
export async function ensureSourceChainMapFresh(): Promise<void> {
  const state = mapState();
  const env = attestcoinEnv();
  if (state.env === env && Date.now() - state.at < MAP_TTL_MS) return;
  if (state.inFlight && state.env === env) {
    // Single-flight: concurrent callers share one fetch.
    await state.inFlight;
    return;
  }
  const fetch = (async () => {
    try {
      const entries = await fetchSupportedChains();
      if (entries.length > 0) {
        const s = mapState();
        s.env = env;
        s.at = Date.now();
        s.entries = entries;
      }
    } catch {
      // keep the stale map — callers fall back per the rules below
    } finally {
      mapState().inFlight = null;
    }
  })();
  mapState().inFlight = fetch;
  await fetch;
}

/** Pure resolution core — exported for unit tests. */
export function resolveSourceChain(
  evmChainId: number,
  env: AttestcoinEnv,
  live: LiveChainEntry[],
): SourceChainInfo | undefined {
  const liveEntry = live.find((c) => c.evmChainId === evmChainId);
  if (liveEntry) {
    // Static metadata (clean name + head RPC) is keyed by evmChainId and
    // remains correct even though its chainKey column may be env-wrong.
    const meta = SOURCE_CHAINS.find((c) => c.evmChainId === evmChainId);
    return {
      chainKey: liveEntry.chainKey,
      evmChainId,
      name: meta?.name ?? (liveEntry.name || `chain ${liveEntry.chainKey}`),
      headRpcUrl: meta?.headRpcUrl ?? attestcoinEndpoints().rpcUrl,
    };
  }
  // No live entry. The static fallback is only valid on TESTNET — the static
  // chain keys are testnet assignments and would be wrong on mainnet.
  if (env === "testnet") {
    return SOURCE_CHAINS.find((c) => c.evmChainId === evmChainId);
  }
  return undefined;
}

/** Resolve an EVM chain id to a Creditcoin source chain (sync — see header). */
export function sourceChainByEvmId(evmChainId: number): SourceChainInfo | undefined {
  const state = mapState();
  const env = attestcoinEnv();
  const live = state.env === env ? state.entries : [];
  return resolveSourceChain(evmChainId, env, live);
}

/** Resolve a Creditcoin chain key to a source chain (sync — see header). */
export function sourceChainByKey(chainKey: number): SourceChainInfo | undefined {
  const state = mapState();
  const env = attestcoinEnv();
  if (state.env === env) {
    const liveEntry = state.entries.find((c) => c.chainKey === chainKey);
    if (liveEntry) {
      const meta = SOURCE_CHAINS.find((c) => c.evmChainId === liveEntry.evmChainId);
      return {
        chainKey,
        evmChainId: liveEntry.evmChainId,
        name: meta?.name ?? (liveEntry.name || `chain ${chainKey}`),
        headRpcUrl: meta?.headRpcUrl ?? attestcoinEndpoints().rpcUrl,
      };
    }
    // A chainKey the precompile didn't report is NOT one of our source chains.
    return undefined;
  }
  if (env === "testnet") {
    return SOURCE_CHAINS.find((c) => c.chainKey === chainKey);
  }
  return undefined;
}

/** Snapshot of the live map (empty before the first successful refresh). */
export function liveSourceChainMap(): LiveChainEntry[] {
  const state = mapState();
  return state.env === attestcoinEnv() ? state.entries : [];
}
