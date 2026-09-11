import { NextResponse } from "next/server";
import { formatUnits } from "viem";
import { getChainByChainId } from "@/lib/chains/registry";
import {
  explorerApiBase,
  fetchExplorerActivity,
  isValidAddress,
} from "@/lib/wallet/explorer";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/wallet/activity?chainId=&address=  (C8 — on-chain activity)
//
// Merged native transactions + ERC-20 token transfers from the explorer,
// newest-first, with human-readable amounts and explorer links. The Wallet
// tab's activity section merges this feed with the local agent-signature log.
// Chains without an explorer API return an empty feed with source "none"
// (local signatures still render client-side).
// ─────────────────────────────────────────────────────────────────────────────

export const revalidate = 0;
export const dynamic = "force-dynamic";

export interface WalletActivityDto {
  /** Server-assigned unique identity (N14 duplicate-key fix). */
  id: string;
  kind: "tx" | "transfer";
  hash: string;
  direction: "in" | "out";
  timestamp: number | null;
  status: "ok" | "error" | "pending";
  method: string | null;
  tokenSymbol: string | null;
  tokenDecimals: number | null;
  /** Raw base-unit amount (decimal string). */
  rawAmount: string;
  /** Human-formatted amount, computed server-side. */
  amountHuman: string | null;
  from: string;
  to: string | null;
  /** Human-formatted fee, plain txs only. */
  feeHuman: string | null;
  explorerUrl: string | null;
}

function humanize(raw: string, decimals: number | null): string | null {
  if (!raw || raw === "0") return null;
  const d = decimals ?? 18;
  try {
    const human = formatUnits(BigInt(raw.split(".")[0]), d);
    const num = Number(human);
    if (!Number.isFinite(num)) return null;
    // Dust amounts (< 0.000001) read as noise — treated as 0-value calls.
    if (num === 0 || Math.abs(num) < 1e-6) return null;
    const text =
      Math.abs(num) >= 1000
        ? num.toLocaleString("en-US", { maximumFractionDigits: 2 })
        : num.toLocaleString("en-US", { maximumFractionDigits: 6 });
    return text;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const chainIdRaw = searchParams.get("chainId");
  const address = searchParams.get("address") ?? "";

  const chainId = Number(chainIdRaw);
  const chain = getChainByChainId(chainId);
  if (!Number.isFinite(chainId) || !chain) {
    return NextResponse.json({ error: "unsupported chain" }, { status: 400 });
  }
  if (!isValidAddress(address)) {
    return NextResponse.json({ error: "invalid address" }, { status: 400 });
  }

  if (!explorerApiBase(chainId)) {
    return NextResponse.json(
      { source: "none", entries: [] },
      { headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const activity = await fetchExplorerActivity(chainId, address);
    const entries: WalletActivityDto[] = activity.map((a) => ({
      id: a.id,
      kind: a.kind,
      hash: a.hash,
      direction: a.direction,
      timestamp: a.timestamp,
      status: a.status,
      method: a.method,
      tokenSymbol: a.tokenSymbol,
      tokenDecimals: a.tokenDecimals,
      rawAmount: a.rawAmount,
      amountHuman: humanize(a.rawAmount, a.tokenDecimals),
      from: a.from,
      to: a.to,
      feeHuman: a.kind === "tx" && a.fee ? humanize(a.fee, chain.nativeCurrency.decimals) : null,
      explorerUrl: `${chain.explorerUrl}/tx/${a.hash}`,
    }));
    return NextResponse.json(
      { source: "explorer", entries },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "explorer unreachable";
    return NextResponse.json({ error: message, entries: [] }, { status: 502 });
  }
}
