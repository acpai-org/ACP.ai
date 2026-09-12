import { JsonRpcProvider } from "ethers";
import { chainInfo as chainInfoModule } from "@gluwa/usc-sdk";
import { attestcoinEndpoints, attestcoinEnv, SOURCE_CHAINS, type SourceChainInfo } from "./config";

// ─────────────────────────────────────────────────────────────────────────────
// Live Attestcoin Protocol network status (server-side only).
//
// Reads the ChainInfo precompile (0x0FD3) on Creditcoin for the latest
// attested height of each supported source chain and pairs it with the
// source chain's own head to compute attestation lag. Fetched fresh on
// every call — caching is disabled app-wide, and attestation lag is exactly
// the kind of mutable state a cached copy would freeze.
// ─────────────────────────────────────────────────────────────────────────────

export interface ChainStatus {
  chainKey: number;
  evmChainId: number;
  name: string;
  /** Latest source-chain block attested on Creditcoin. */
  attestedHeight: number | null;
  /** Digest of the attested block. */
  attestedHash: string | null;
  /** Source-chain head at query time. */
  sourceHead: number | null;
  /** sourceHead − attestedHeight (null when either side is unknown). */
  lag: number | null;
  /** True when the RPC reported a live attestation for the chain. */
  hasAttestations: boolean;
}

export interface AttestcoinStatus {
  env: "testnet" | "mainnet";
  /** Current Creditcoin block height. */
  cc3Block: number | null;
  /** Per-source-chain attestation state. */
  chains: ChainStatus[];
  fetchedAt: number;
  /** True when every upstream call succeeded. */
  healthy: boolean;
}

interface ProviderCache {
  env: string;
  creditcoin: JsonRpcProvider;
  chainInfo: chainInfoModule.PrecompileChainInfoProvider;
  heads: Map<number, JsonRpcProvider>;
}

let providers: ProviderCache | null = null;

function getProviders(): ProviderCache {
  const env = attestcoinEnv();
  if (providers && providers.env === env) return providers;
  const { rpcUrl } = attestcoinEndpoints();
  const creditcoin = new JsonRpcProvider(rpcUrl, undefined, {
    staticNetwork: true,
    batchStallTime: 200,
  });
  providers = {
    env,
    creditcoin,
    chainInfo: new chainInfoModule.PrecompileChainInfoProvider(creditcoin),
    heads: new Map(),
  };
  return providers;
}

function headProvider(chain: SourceChainInfo): JsonRpcProvider {
  const p = getProviders();
  let provider = p.heads.get(chain.chainKey);
  if (!provider) {
    provider = new JsonRpcProvider(chain.headRpcUrl, undefined, { staticNetwork: true });
    p.heads.set(chain.chainKey, provider);
  }
  return provider;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(fallback);
      });
  });
}

/** Fetch fresh status — no cache. Throws only on total failure (returns healthy=false rows otherwise). */
export async function fetchAttestcoinStatus(): Promise<AttestcoinStatus> {
  const { chainInfo, creditcoin } = getProviders();
  const chains = (await withTimeout(chainInfo.getSupportedChains(), 10_000, [])).map((raw) => {
    // ChainInfo.chainName comes back as a 0x-prefixed hex string ("0x5365706f6c6961…").
    let name = raw.chainName ?? "";
    if (name.startsWith("0x")) {
      try {
        name = Buffer.from(name.slice(2), "hex").toString("utf8");
      } catch {
        name = `chain ${raw.chainKey}`;
      }
    }
    return { chainKey: raw.chainKey, evmChainId: raw.chainId, name: name.trim() };
  });

  const cc3Block = await withTimeout(creditcoin.getBlockNumber(), 10_000, null as number | null);

  const rows = await Promise.all(
    chains.map(async (c): Promise<ChainStatus> => {
      // Static metadata (name + head RPC) keyed by evmChainId — env-independent;
      // chainKey/evmChainId themselves come from the live ChainInfo response.
      const meta = SOURCE_CHAINS.find((s) => s.evmChainId === c.evmChainId);
      const tracked: SourceChainInfo | null = meta
        ? { chainKey: c.chainKey, evmChainId: c.evmChainId, name: meta.name, headRpcUrl: meta.headRpcUrl }
        : null;
      const attested = await withTimeout(
        chainInfo.getLatestAttestedHeightAndHash(c.chainKey),
        10_000,
        null,
      );
      const head = tracked
        ? await withTimeout(headProvider(tracked).getBlockNumber(), 10_000, null as number | null)
        : null;
      const lag =
        head !== null && attested?.height != null && head >= attested.height
          ? head - attested.height
          : null;
      return {
        chainKey: c.chainKey,
        evmChainId: c.evmChainId,
        // Prefer the name from our tracked registry (cleaner); fall back to the decoded on-chain name.
        name: tracked?.name ?? c.name,
        attestedHeight: attested?.height ?? null,
        attestedHash: attested?.hash ?? null,
        sourceHead: head,
        lag,
        hasAttestations: attested?.exists ?? false,
      };
    }),
  );

  const healthy = cc3Block !== null && rows.every((r) => r.hasAttestations);

  return {
    env: attestcoinEnv(),
    cc3Block,
    chains: rows.sort((a, b) => a.chainKey - b.chainKey),
    fetchedAt: Date.now(),
    healthy,
  };
}

// ── S5: short-TTL status snapshot ────────────────────────────────────────────
// QA (round 2) measured /api/attestcoin/status at 1.8–2.4s per request — it
// performs 1 + N attested-height eth_calls + N public source-RPC head reads,
// and it is polled every 60s per open Wallet panel AND enriched per intent
// card AND per proof-route call. The data's natural cadence is ~2 minutes
// (attestation cadence), so a 30s server-side snapshot changes nothing the
// user can perceive while cutting ~all redundant upstream calls. The route's
// ?force=1 (the panel's manual Refresh button) and the test's
// getAttestcoinStatus(true) bypass the cache entirely.
const STATUS_TTL_MS = 30_000;

interface StatusCacheState {
  env: string;
  at: number;
  snapshot: AttestcoinStatus | null;
  inFlight: Promise<AttestcoinStatus> | null;
  /** Generation counter — lets the finally-block clear only ITS OWN slot
   * without referencing the promise variable (TS definite-assignment). */
  inFlightGen: number;
}

const globalForStatus = globalThis as unknown as {
  __acpStatusCache?: StatusCacheState;
};

function statusCache(): StatusCacheState {
  globalForStatus.__acpStatusCache ??= { env: "", at: 0, snapshot: null, inFlight: null, inFlightGen: 0 };
  return globalForStatus.__acpStatusCache;
}

/** Live status with a 30s server-side snapshot (S5). `force` bypasses the
 *  cache — the wallet panel's Refresh button and live tests want fresh data.
 *  Concurrent callers share one in-flight fetch (single-flight). */
export async function getAttestcoinStatus(force = false): Promise<AttestcoinStatus> {
  const cache = statusCache();
  const env = attestcoinEnv();
  if (
    !force &&
    cache.env === env &&
    cache.snapshot &&
    Date.now() - cache.at < STATUS_TTL_MS
  ) {
    return cache.snapshot;
  }
  if (cache.inFlight && cache.env === env && !force) {
    // Share one in-flight fetch (page loads hit this from several routes).
    return cache.inFlight;
  }
  const gen = ++statusCache().inFlightGen;
  const flight: Promise<AttestcoinStatus> = (async () => {
    try {
      const snapshot = await fetchAttestcoinStatus();
      const s = statusCache();
      s.env = env;
      s.at = Date.now();
      s.snapshot = snapshot;
      return snapshot;
    } finally {
      // Only clear OUR generation — a force refresh may have replaced the slot.
      const s = statusCache();
      if (s.inFlightGen === gen) {
        s.inFlight = null;
      }
    }
  })();
  cache.inFlight = flight;
  cache.env = env;
  return flight;
}

// ── Attestation bounds (C2 / G6) ──────────────────────────────────────────────
// getContinuityBounds(chainKey, height) returns the attestation/checkpoint
// bracket around a height — the protocol-native answer to "why is my tx not
// attested yet": the tx sits between bound n and the next bound m; once the
// chain advances the bracket the tx flips to attested. Fetched fresh —
// isAttested flips for a given height, so a cached bracket can freeze it.

export interface AttestationBounds {
  parentHeight: number;
  parentHash: string;
  parentIsAttestation: boolean;
  childHeight: number;
  childHash: string;
  childIsAttestation: boolean;
  isAttested: boolean;
}

/**
 * The attestation/checkpoint bracket around a source-chain height, plus
 * isAttested for the height itself (G6). Never throws — null on failure.
 */
export async function getAttestationBounds(
  chainKey: number,
  height: number,
): Promise<AttestationBounds | null> {
  const { chainInfo } = getProviders();
  const raw = await withTimeout(chainInfo.getContinuityBounds(chainKey, height), 10_000, null);
  if (!raw) return null;
  const bounds: AttestationBounds = {
    parentHeight: raw.parentHeight,
    parentHash: raw.parentHash,
    parentIsAttestation: raw.parentIsAttestation,
    childHeight: raw.childHeight,
    childHash: raw.childHash,
    childIsAttestation: raw.childIsAttestation,
    isAttested: raw.isAttested,
  };
  return bounds;
}
