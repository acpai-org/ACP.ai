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
/** N1 fix: after a FAILED refresh, hold off re-fetching for this long. Without
 * this, a down/slow Creditcoin RPC meant every caller re-fired a fresh fetch
 * (each with ethers' default 300s timeout) — wedging poller ticks and every
 * attestcoin API route behind an in-flight hang. */
const MAP_FAIL_BACKOFF_MS = 30_000;
/** Hard deadline for the chain-map refresh eth_call (matches ATTESTCOIN_TIMEOUT_MS). */
const MAP_FETCH_TIMEOUT_MS = 10_000;

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
  /** Env the in-flight fetch targets (null = none) — correct single-flight
   * joining even on cold boot, where `env` (last SUCCESS) is still "". */
  inFlightEnv: string | null;
  /** Generation counter for the in-flight fetch — lets the finally-block
   * clear only ITS OWN slot without referencing the promise variable
   * (TS use-before-assign + replaced-flight safety in one). */
  inFlightGen: number;
  /** Env of the last failed/empty attempt ("" = none) — gates the fail backoff. */
  failEnv: string;
  failedAt: number;
}

const globalForChains = globalThis as unknown as {
  __acpSourceChainMap?: ChainMapState;
};

function mapState(): ChainMapState {
  globalForChains.__acpSourceChainMap ??= { env: "", at: 0, entries: [], inFlight: null, inFlightEnv: null, inFlightGen: 0, failEnv: "", failedAt: 0 };
  return globalForChains.__acpSourceChainMap;
}

async function fetchSupportedChains(): Promise<LiveChainEntry[]> {
  const { rpcUrl } = attestcoinEndpoints();
  const provider = new JsonRpcProvider(rpcUrl, undefined, {
    staticNetwork: true,
    batchStallTime: 200,
  });
  try {
    const chainInfo = new chainInfoModule.PrecompileChainInfoProvider(provider);
    // N1 fix: race the eth_call with a hard deadline — ethers' FetchRequest
    // default timeout is 300s, which would hold every awaiting caller (poller
    // tick, attestcoin routes) hostage during a Creditcoin RPC hiccup.
    const raw = await Promise.race([
      chainInfo.getSupportedChains(),
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error("chain-info fetch timed out")), MAP_FETCH_TIMEOUT_MS);
        t.unref?.();
      }),
    ]);
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
  } finally {
    try {
      provider.destroy();
    } catch {}
  }
}

/**
 * Refresh the live chain map if older than MAP_TTL_MS. Never throws — a failed
 * refresh leaves the previous map (or the empty initial map) in place, and
 * backs off for MAP_FAIL_BACKOFF_MS so a down RPC can't wedge every caller
 * behind a fresh hang (N1 fix).
 */
export async function ensureSourceChainMapFresh(): Promise<void> {
  const state = mapState();
  const env = attestcoinEnv();
  if (state.env === env && Date.now() - state.at < MAP_TTL_MS) return;
  // N1: a recent FAILURE (or an empty response) for THIS env holds off a new
  // fetch — the stale/empty map keeps serving. Without this, every caller
  // during an outage re-fired a fresh eth_call and single-flight made them
  // all wait for it.
  if (state.failEnv === env && state.failedAt > 0 && Date.now() - state.failedAt < MAP_FAIL_BACKOFF_MS) return;
  // Single-flight: concurrent callers for the SAME env share one fetch —
  // including on cold boot (inFlightEnv is set before any success is
  // recorded, unlike `env`).
  if (state.inFlight && state.inFlightEnv === env) {
    await state.inFlight;
    return;
  }
  const gen = ++mapState().inFlightGen;
  const flight: Promise<void> = (async () => {
    try {
      const entries = await fetchSupportedChains();
      if (entries.length > 0) {
        const s = mapState();
        s.env = env;
        s.at = Date.now();
        s.entries = entries;
        s.failEnv = "";
        s.failedAt = 0;
      } else {
        const s = mapState();
        s.failEnv = env;
        s.failedAt = Date.now();
      }
    } catch {
      // keep the stale map — callers fall back per the rules below; record
      // the failure so the backoff above prevents a re-fetch stampede.
      const s = mapState();
      s.failEnv = env;
      s.failedAt = Date.now();
    } finally {
      // Only clear OUR generation — a concurrent fetch for a different env
      // may have replaced the slot while we were in flight.
      const s = mapState();
      if (s.inFlightGen === gen) {
        s.inFlight = null;
        s.inFlightEnv = null;
      }
    }
  })();
  mapState().inFlight = flight;
  mapState().inFlightEnv = env;
  await flight;
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

/**
 * P3 fix (poller starvation): the evm-chain ids the current environment can
 * ever attest — the live ChainInfo map when loaded, else the static testnet
 * fallback ids. Used by the poller and batch-attest routes to filter
 * candidates IN SQL, so payments settled on untracked chains (Base, Polygon,
 * BSC…) can never occupy the candidate window and starve attestable rows.
 */
export function SOURCE_CHAINS_FALLBACK_IDS(): number[] {
  const live = liveSourceChainMap();
  if (live.length > 0) return live.map((c) => c.evmChainId);
  return SOURCE_CHAINS.map((c) => c.evmChainId);
}
