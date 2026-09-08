import { getChainByChainId } from "@/lib/chains/registry";

// ─────────────────────────────────────────────────────────────────────────────
// Server-side Blockscout V2 explorer client (C8, Phase 3 §10 wallet).
//
// Real ERC-20 discovery + on-chain activity for the Wallet tab. Every host in
// the map was live-verified from this sandbox (2026-09-06):
//   creditcoin-testnet.blockscout.com ✓   creditcoin.blockscout.com ✓
//   eth-sepolia.blockscout.com ✓         eth.blockscout.com ✓
//   arbitrum.blockscout.com ✓            explorer.optimism.io ✓ (301 target)
//   polygon.blockscout.com ✓             base/bsc: no free API → RPC fallback
//
// All calls run server-side (no CORS, no key), with a short in-memory cache so
// the Wallet tab's 30s refetch and multiple surfaces hitting the same address
// don't hammer public explorers.
// ─────────────────────────────────────────────────────────────────────────────

export interface ExplorerToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  /** Raw base-unit balance as a decimal string (BigInt-compatible). */
  rawBalance: string;
  logoUri: string | null;
  /** Live exchange rate (USD per token) as a decimal string, when the explorer has one. */
  exchangeRate: string | null;
  tokenType: string;
}

export interface ExplorerActivity {
  /**
   * Stable data-layer identity (N14 duplicate-key fix). Unique by
   * construction: kind + hash + direction + token + amount + recipient.
   * The Wallet tab's React keys are `oc-${id}` — never a bare hash, because
   * one tx legitimately produces several DISTINCT entries (native + token
   * sides, multi-token transfers).
   */
  id: string;
  kind: "tx" | "transfer";
  hash: string;
  direction: "in" | "out";
  timestamp: number | null;
  status: "ok" | "error" | "pending";
  method: string | null;
  /** For transfers: token symbol; for plain txs: the native currency symbol. */
  tokenSymbol: string | null;
  tokenDecimals: number | null;
  /** Raw base-unit amount as a decimal string. */
  rawAmount: string;
  from: string;
  to: string | null;
  /** Raw fee (base units) for plain txs. */
  fee: string | null;
}

/** Chains with a verified free Blockscout V2 API, keyed by chainId. */
const EXPLORER_API_BY_CHAIN: Record<number, string | null> = {
  102031: "https://creditcoin-testnet.blockscout.com",
  102030: "https://creditcoin.blockscout.com",
  11155111: "https://eth-sepolia.blockscout.com",
  1: "https://eth.blockscout.com",
  42161: "https://arbitrum.blockscout.com",
  10: "https://explorer.optimism.io",
  137: "https://polygon.blockscout.com",
  8453: null, // base.blockscout.com dead — RPC fallback in the tokens route
  56: null, // bscscan needs a key — RPC fallback
};

export function explorerApiBase(chainId: number): string | null {
  return EXPLORER_API_BY_CHAIN[chainId] ?? null;
}

// ── tiny TTL cache ───────────────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expires: number;
}

const CACHE = new Map<string, CacheEntry<unknown>>();

function cacheGet<T>(key: string): T | undefined {
  const hit = CACHE.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) {
    CACHE.delete(key);
    return undefined;
  }
  return hit.value as T;
}

function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  CACHE.set(key, { value, expires: Date.now() + ttlMs });
  // Keep the cache bounded (explorer responses can be large).
  if (CACHE.size > 64) {
    const oldest = CACHE.keys().next().value;
    if (oldest !== undefined) CACHE.delete(oldest);
  }
}

/** Test hook — wipe the cache between test cases. */
export function clearExplorerCache(): void {
  CACHE.clear();
}

// ── fetch plumbing ───────────────────────────────────────────────────────────

async function getJson<T>(url: string, timeoutMs = 9000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`explorer ${res.status} for ${new URL(url).host}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isValidAddress(addr: string): boolean {
  return ADDRESS_RE.test(addr);
}

// ── token balances ───────────────────────────────────────────────────────────

interface BsTokenBalancesItem {
  token: {
    address_hash: string;
    name: string | null;
    symbol: string | null;
    decimals: string | null;
    type: string | null;
    icon_url: string | null;
    exchange_rate: string | null;
    reputation: string | null;
  } | null;
  value: string | null;
}

/**
 * Heuristic spam-token filter. Testnet explorers host waves of airdropped
 * phishing tokens whose SYMBOL/NAME embed claim URLs ("$BTC https://… to
 * CLAIM", "appsei.icu"). The explorer doesn't flag them (reputation: ok), so
 * we screen obvious patterns: embedded URLs/hosts, over-long symbols, and
 * clickbait phrasing. Legit symbols are short alphanumerics.
 */
const URL_RE = /https?:\/\/|www\.|\.(com|net|io|icu|vip|xyz|app|link|lol|site|fun|eth)\b/i;

function looksLikeSpamToken(symbol: string, name: string): boolean {
  const sym = symbol.trim();
  if (sym.length > 24) return true;
  if (URL_RE.test(sym)) return true;
  if (/\bclaim\b|\bairdrop\b/i.test(sym)) return true;
  // Symbols wrapped in punctuation ("$420$", "*ET*", "$SCAMMER")
  if (/^[\W_]+[\w\W]*[\W_]+$/.test(sym) && /\$|\*|!/.test(sym)) return true;
  const stripped = sym.replace(/[^a-zA-Z0-9]/g, "");
  if (stripped.length > 0 && sym.length - stripped.length >= 3) return true;
  if (URL_RE.test(name)) return true;
  return false;
}

/**
 * All live ERC-20 holdings for an address on a chain (balance > 0, ERC-20
 * only — NFT holdings are a future surface). Throws on transport/API failure
 * so the route can fall back to known-token RPC reads.
 */
export async function fetchExplorerTokenBalances(
  chainId: number,
  address: string,
): Promise<ExplorerToken[]> {
  const base = explorerApiBase(chainId);
  if (!base) throw new Error(`no explorer API for chain ${chainId}`);

  const cacheKey = `tokens:${chainId}:${address.toLowerCase()}`;
  const cached = cacheGet<ExplorerToken[]>(cacheKey);
  if (cached) return cached;

  const items = await getJson<BsTokenBalancesItem[]>(
    `${base}/api/v2/addresses/${address}/token-balances`,
  );

  const tokens: ExplorerToken[] = [];
  for (const item of items ?? []) {
    const tok = item.token;
    if (!tok || tok.type !== "ERC-20") continue;
    const value = item.value ?? "0";
    if (!value || value === "0" || /^0+\.?0*$/.test(value)) continue;
    const symbol = tok.symbol ?? "???";
    if (symbol === "???" || symbol === "") continue;
    // Phishing airdrops + explorer-flagged scams stay out of the asset list.
    if (looksLikeSpamToken(symbol, tok.name ?? symbol)) continue;
    if ((tok.reputation ?? "").toLowerCase() === "scam") continue;
    tokens.push({
      address: tok.address_hash,
      symbol,
      name: tok.name ?? symbol,
      decimals: Number(tok.decimals ?? "18") || 18,
      rawBalance: value,
      logoUri: tok.icon_url,
      exchangeRate: tok.exchange_rate,
      tokenType: tok.type,
    });
  }

  cacheSet(cacheKey, tokens, 45_000);
  return tokens;
}

// ── on-chain activity (native txs + token transfers merged) ─────────────────

interface BsAddress {
  hash: string | null;
}

interface BsTxItem {
  hash: string;
  from: BsAddress | null;
  to: BsAddress | null;
  value: string | null;
  timestamp: string | null;
  result: string | null; // "success" | "error" | "pending" (v2)
  status: string | null; // "ok" | "error" (older instances)
  method: string | null;
  fee: { type: string | null; value: string | null } | null;
}

interface BsTokenTransferItem {
  transaction_hash: string | null;
  from: BsAddress | null;
  to: BsAddress | null;
  timestamp: string | null;
  method: string | null;
  token: {
    address_hash: string;
    symbol: string | null;
    decimals: string | null;
    type: string | null;
  } | null;
  total: { value: string | null; decimals: number | null } | null;
}

interface BsListResponse<T> {
  items: T[] | null;
}

function parseTs(ts: string | null): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts.endsWith("Z") ? ts : `${ts}Z`);
  return Number.isFinite(ms) ? ms : null;
}

function parseTxStatus(item: BsTxItem): ExplorerActivity["status"] {
  const r = (item.result ?? "").toLowerCase();
  if (r === "success" || r === "ok") return "ok";
  if (r === "error" || r === "failed") return "error";
  if (r === "pending") return "pending";
  const s = (item.status ?? "").toUpperCase();
  if (s === "OK") return "ok";
  if (s === "ERROR") return "error";
  return "pending";
}

/**
 * Recent on-chain activity for an address: native transactions plus ERC-20
 * token transfers, merged and sorted newest-first. Single page per source
 * (~50 + ~50 entries) — the Wallet tab paginates client-side.
 */
export async function fetchExplorerActivity(
  chainId: number,
  address: string,
): Promise<ExplorerActivity[]> {
  const base = explorerApiBase(chainId);
  if (!base) throw new Error(`no explorer API for chain ${chainId}`);

  const cacheKey = `activity:${chainId}:${address.toLowerCase()}`;
  const cached = cacheGet<ExplorerActivity[]>(cacheKey);
  if (cached) return cached;

  const lower = address.toLowerCase();
  const chain = getChainByChainId(chainId);
  const nativeSymbol = chain?.nativeCurrency.symbol ?? "ETH";

  // Fire both requests; a failure in either source degrades gracefully (the
  // other still returns). Total failure throws to the route's error path.
  const [txsRes, transfersRes] = await Promise.allSettled([
    getJson<BsListResponse<BsTxItem>>(`${base}/api/v2/addresses/${address}/transactions`),
    getJson<BsListResponse<BsTokenTransferItem>>(
      `${base}/api/v2/addresses/${address}/token-transfers`,
    ),
  ]);
  if (txsRes.status === "rejected" && transfersRes.status === "rejected") {
    throw new Error(`explorer unreachable for ${new URL(base).host}`);
  }

  const out: ExplorerActivity[] = [];

  // Token-transfer entries FIRST (with composite identities), so plain-tx
  // entries for the same (hash, direction) can be dropped as redundant:
  // an ERC-20 send otherwise shows twice (once as the tx row, once as the
  // transfer row) — that duplication was the N14 duplicate-key bug.
  const transferCovers = new Set<string>();

  if (transfersRes.status === "fulfilled") {
    const seen = new Set<string>();
    for (const tr of transfersRes.value.items ?? []) {
      if (!tr.transaction_hash) continue;
      const tok = tr.token;
      if (tok && tok.type && tok.type !== "ERC-20") continue; // NFT transfers later
      const from = tr.from?.hash ?? "";
      const to = tr.to?.hash ?? null;
      const decimals = tr.total?.decimals ?? (Number(tok?.decimals ?? "18") || 18);
      const symbol = tok?.symbol ?? "?";
      const rawAmount = tr.total?.value ?? "0";
      const direction = from.toLowerCase() === lower ? "out" : "in";
      // Composite identity: distinct transfers in one tx stay distinct;
      // true duplicates (same token/amount/recipient) collapse.
      const id = `tr-${tr.transaction_hash}-${direction}-${symbol}-${rawAmount}-${to ?? ""}`;
      if (seen.has(id)) continue;
      seen.add(id);
      transferCovers.add(`${tr.transaction_hash}-${direction}`);
      out.push({
        id,
        kind: "transfer",
        hash: tr.transaction_hash,
        direction,
        timestamp: parseTs(tr.timestamp),
        status: "ok", // token transfers in a confirmed block
        method: tr.method,
        tokenSymbol: symbol,
        tokenDecimals: decimals,
        rawAmount,
        from,
        to,
        fee: null,
      });
    }
  }

  if (txsRes.status === "fulfilled") {
    const seen = new Set<string>();
    for (const tx of txsRes.value.items ?? []) {
      const from = tx.from?.hash ?? "";
      const to = tx.to?.hash ?? null;
      const direction = from.toLowerCase() === lower ? "out" : "in";
      // Redundant row: a token-transfer entry already represents this
      // (hash, direction) — showing both duplicates the user's action.
      if (transferCovers.has(`${tx.hash}-${direction}`)) continue;
      const id = `tx-${tx.hash}-${direction}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        kind: "tx",
        hash: tx.hash,
        direction,
        timestamp: parseTs(tx.timestamp),
        status: parseTxStatus(tx),
        method: tx.method,
        tokenSymbol: nativeSymbol,
        tokenDecimals: chain?.nativeCurrency.decimals ?? 18,
        rawAmount: tx.value ?? "0",
        from,
        to,
        fee: tx.fee?.value ?? null,
      });
    }
  }

  out.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  const trimmed = out.slice(0, 80);
  cacheSet(cacheKey, trimmed, 30_000);
  return trimmed;
}
