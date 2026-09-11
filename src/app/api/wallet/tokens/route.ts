import { NextResponse } from "next/server";
import { createPublicClient, http, formatUnits, erc20Abi, type Address } from "viem";
import { getChainByChainId } from "@/lib/chains/registry";
import {
  explorerApiBase,
  fetchExplorerTokenBalances,
  isValidAddress,
} from "@/lib/wallet/explorer";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/wallet/tokens?chainId=&address=  (C8 — real ERC-20 discovery)
//
// Explorer-first: full on-chain discovery via the Blockscout V2 API (all live
// holdings, real exchange rates, token logos). Fallback for chains without a
// free explorer API (Base/BNB) or when the explorer is unreachable: live RPC
// balanceOf reads for the registry-known tokens — honest scope, surfaced to
// the UI as source:"known".
// ─────────────────────────────────────────────────────────────────────────────

export const revalidate = 0;
export const dynamic = "force-dynamic";

export interface WalletTokenDto {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  rawBalance: string;
  /** Human-formatted balance (computed once, server-side). */
  balanceHuman: string;
  logoUri: string | null;
  /** Live USD price per token when the explorer provides one. */
  priceUsd: number | null;
  /** Live USD value of the holding (price × balance), when priced. */
  usdValue: number | null;
  /** True when the token is also in the chain registry (agent-resolvable by symbol). */
  inRegistry: boolean;
}

function formatBalance(raw: string, decimals: number): string {
  try {
    const human = formatUnits(BigInt(raw.split(".")[0]), decimals);
    const num = Number(human);
    if (!Number.isFinite(num)) return human;
    if (num === 0) return "0";
    if (Math.abs(num) >= 1_000_000)
      return num.toLocaleString("en-US", { maximumFractionDigits: 0 });
    if (Math.abs(num) >= 1) return num.toLocaleString("en-US", { maximumFractionDigits: 4 });
    // Sub-1 amounts: up to 8 fraction digits, trailing zeros trimmed.
    return num
      .toLocaleString("en-US", { maximumFractionDigits: 8 })
      .replace(/(\.\d*?)0+$/, "$1")
      .replace(/\.$/, "");
  } catch {
    return raw;
  }
}

async function knownTokenBalances(
  chainId: number,
  address: string,
): Promise<WalletTokenDto[]> {
  const chain = getChainByChainId(chainId);
  if (!chain || chain.tokens.length === 0) return [];
  const client = createPublicClient({ transport: http(chain.rpcUrls[0]) });
  const lower = address.toLowerCase();
  const out: WalletTokenDto[] = [];
  for (const tok of chain.tokens) {
    if (tok.address.toLowerCase() === lower) continue;
    try {
      const balance = (await client.readContract({
        address: tok.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address as Address],
      })) as bigint;
      if (balance === 0n) continue;
      out.push({
        address: tok.address,
        symbol: tok.symbol,
        name: tok.name,
        decimals: tok.decimals,
        rawBalance: balance.toString(),
        balanceHuman: formatBalance(balance.toString(), tok.decimals),
        logoUri: null,
        priceUsd: null,
        usdValue: null,
        inRegistry: true,
      });
    } catch {
      // RPC read failed for this token — skip it (chain may not index it)
    }
  }
  return out;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const chainIdRaw = searchParams.get("chainId");
  const address = searchParams.get("address") ?? "";

  const chainId = Number(chainIdRaw);
  if (!Number.isFinite(chainId) || !getChainByChainId(chainId)) {
    return NextResponse.json({ error: "unsupported chain" }, { status: 400 });
  }
  if (!isValidAddress(address)) {
    return NextResponse.json({ error: "invalid address" }, { status: 400 });
  }

  // Explorer path — full discovery with real prices + logos.
  if (explorerApiBase(chainId)) {
    try {
      const explorerTokens = await fetchExplorerTokenBalances(chainId, address);
      const chain = getChainByChainId(chainId)!;
      const registrySet = new Set(chain.tokens.map((t) => t.address.toLowerCase()));
      const tokens: WalletTokenDto[] = explorerTokens.map((t) => {
        const price = t.exchangeRate != null ? Number(t.exchangeRate) : null;
        const balanceNum = (() => {
          try {
            return Number(formatUnits(BigInt(t.rawBalance), t.decimals));
          } catch {
            return NaN;
          }
        })();
        const usd =
          price != null && Number.isFinite(balanceNum)
            ? price * balanceNum
            : null;
        return {
          address: t.address,
          symbol: t.symbol,
          name: t.name,
          decimals: t.decimals,
          rawBalance: t.rawBalance,
          balanceHuman: formatBalance(t.rawBalance, t.decimals),
          logoUri: t.logoUri,
          priceUsd: price != null && Number.isFinite(price) ? price : null,
          usdValue: usd != null && Number.isFinite(usd) ? usd : null,
          inRegistry: registrySet.has(t.address.toLowerCase()),
        };
      });
      return NextResponse.json(
        { source: "explorer", tokens },
        { headers: { "cache-control": "no-store" } },
      );
    } catch {
      // fall through to known-token fallback
    }
  }

  // Fallback path — live balances for registry-known tokens only.
  const known = await knownTokenBalances(chainId, address);
  return NextResponse.json(
    { source: "known", tokens: known },
    { headers: { "cache-control": "no-store" } },
  );
}
