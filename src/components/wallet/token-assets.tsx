"use client";

import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Coins,
  RefreshCw,
  ChevronDown,
  Copy,
  Check,
  ExternalLink,
  ArrowUpRight,
  Repeat,
  Compass,
  Send,
  CircleAlert,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n";
import { getChainByChainId } from "@/lib/chains/registry";
import { useAskAgent } from "@/lib/use-ask-agent";
import { cn } from "@/lib/utils";
import { useTokenBalances } from "@/lib/use-token-balances";

// ─────────────────────────────────────────────────────────────────────────────
// TokenAssets (C8): the Wallet tab's asset list — REAL discovery of every
// live ERC-20 holding (Blockscout V2 server-side) plus the native token, with
// live USD prices/logos where the explorer has them, per-token detail rows,
// and agent hand-off quick actions. Replaces Phase 2's two hardcoded rows.
// ─────────────────────────────────────────────────────────────────────────────

interface TokenRow {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  balanceHuman: string;
  /** Live explorer-provided USD price (Blockscout exchange_rate) — the only
   * USD figure rendered in the wallet. NOMINAL prices are gone (P4/P6):
   * a token without a live explorer price shows no fiat figure at all. */
  priceUsd: number | null;
  usdValue: number | null;
  logoUri: string | null;
  inRegistry: boolean;
  isNative?: boolean;
}

function TokenLogo({ logoUri, symbol, size = "md" }: { logoUri: string | null; symbol: string; size?: "md" | "lg" }) {
  const [failed, setFailed] = useState(false);
  const dim = size === "lg" ? "h-10 w-10" : "h-9 w-9";
  if (logoUri && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- remote explorer CDN, no optimizer
      <img
        src={logoUri}
        alt={`${symbol} logo`}
        width={36}
        height={36}
        loading="lazy"
        onError={() => setFailed(true)}
        className={cn(dim, "shrink-0 rounded-full bg-surface-2 object-cover ring-1 ring-border")}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        dim,
        "flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-surface-2 to-surface-3 text-[11px] font-bold text-foreground/70 ring-1 ring-border",
      )}
    >
      {symbol.slice(0, 2).toUpperCase()}
    </span>
  );
}

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-surface-2/30 px-3.5 py-3">
      <span className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-surface-3" />
      <div className="flex-1 space-y-1.5">
        <span className="block h-3 w-20 animate-pulse rounded bg-surface-3" />
        <span className="block h-2.5 w-28 animate-pulse rounded bg-surface-3/70" />
      </div>
      <div className="space-y-1.5 text-right">
        <span className="block h-3 w-16 animate-pulse rounded bg-surface-3" />
        <span className="block h-2.5 w-12 animate-pulse rounded bg-surface-3/70" />
      </div>
    </div>
  );
}

export function TokenAssets({
  chainId,
  nativeBalanceHuman,
  nativeSymbol,
  nativeName,
  onSwap,
}: {
  chainId: number;
  nativeBalanceHuman: string;
  nativeSymbol: string;
  nativeName: string;
  onSwap: (fromSymbol: string) => void;
}) {
  const { t } = useI18n();
  const askAgent = useAskAgent();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const { data, isLoading, isError, refetch, isFetching } = useTokenBalances();

  const chain = getChainByChainId(chainId);
  const explorerBase = chain?.explorerUrl ?? null;

  const rows = useMemo<TokenRow[]>(() => {
    const native: TokenRow = {
      address: "",
      symbol: nativeSymbol,
      name: nativeName,
      decimals: chain?.nativeCurrency.decimals ?? 18,
      balanceHuman: nativeBalanceHuman,
      priceUsd: null,
      usdValue: null,
      logoUri: null,
      inRegistry: true,
      isNative: true,
    };
    // Dedupe by contract address (defensive: same-symbol clones are common
    // on testnets; duplicate rows would collide React keys and double-count).
    const seen = new Set<string>();
    const tokens: TokenRow[] = (data ?? [])
      .filter((d) => {
        if (seen.has(d.address)) return false;
        seen.add(d.address);
        return true;
      })
      .map((d) => ({
        address: d.address,
        symbol: d.symbol,
        name: d.name,
        decimals: d.decimals,
        balanceHuman: d.balanceHuman ?? d.balance,
        priceUsd: d.priceUsd ?? null,
        usdValue: d.usdValueNum ?? null,
        logoUri: d.logoUri ?? null,
        inRegistry: Boolean(d.inRegistry),
      }));
    // Priced tokens first (by USD desc), then unpriced by symbol.
    tokens.sort((a, b) => {
      const av = a.usdValue ?? -1;
      const bv = b.usdValue ?? -1;
      if (av !== bv) return bv - av;
      return a.symbol.localeCompare(b.symbol);
    });
    return [native, ...tokens];
  }, [data, nativeBalanceHuman, nativeSymbol, nativeName, chain]);

  const visible = showAll ? rows : rows.slice(0, 14);

  const copyAddress = (addr: string) => {
    navigator.clipboard?.writeText(addr);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const sendViaAgent = (row: TokenRow) => {
    askAgent(
      t("wallet.sendPrompt", { symbol: row.symbol, balance: row.balanceHuman, chain: chain?.name ?? `Chain ${chainId}` }),
    );
  };

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Coins className="h-4 w-4 text-muted" aria-hidden />
        <h2 className="text-sm font-semibold text-foreground">{t("wallet.assets")}</h2>
        {data ? (
          <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted-2">
            {rows.length - 1 > 0 ? t("wallet.tokenCount", { count: rows.length - 1 }) : null}
          </span>
        ) : null}
        {data?.[0]?.source ? (
          <span
            className="flex items-center gap-1 text-[10px] text-muted-3"
            title={data[0].source === "explorer" ? t("wallet.sourceExplorerTip") : t("wallet.sourceKnownTip")}
          >
            <Compass className="h-3 w-3 text-primary/60" aria-hidden />
            {data[0].source === "explorer" ? t("wallet.sourceExplorer") : t("wallet.sourceKnown")}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => void refetch()}
          className="hit-slop ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-muted-2 transition-colors hover:bg-surface-3 hover:text-foreground cursor-pointer"
          title={t("wallet.refreshAssets")}
          aria-label={t("wallet.refreshAssets")}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} aria-hidden />
        </button>
      </div>

      {isError ? (
        <button
          type="button"
          onClick={() => void refetch()}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-danger/30 bg-danger/5 px-3 py-3 text-xs text-danger transition-colors hover:bg-danger/10 cursor-pointer"
        >
          <CircleAlert className="h-3.5 w-3.5" />
          {t("wallet.assetsErrorRetry")}
        </button>
      ) : isLoading ? (
        <div className="space-y-2" aria-busy>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : (
        <div className="acp-scroll max-h-[26rem] space-y-1.5 overflow-y-auto pr-1">
          {visible.map((row, i) => {
            const key = row.isNative ? `native-${row.symbol}` : row.address;
            const isOpen = expanded === key;
            const explorerTokenUrl =
              !row.isNative && explorerBase ? `${explorerBase}/token/${row.address}` : null;
            return (
              <motion.div
                key={key}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i * 0.02, 0.2), duration: 0.18 }}
                className={cn(
                  "rounded-xl border border-foreground/10 bg-foreground/[0.03] transition-colors hover:border-foreground/20",
                  isOpen && "border-primary/25 bg-primary/[0.04]",
                )}
              >
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : key)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center gap-3 px-3.5 py-3 text-left cursor-pointer"
                >
                  <TokenLogo logoUri={row.logoUri} symbol={row.symbol} />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                      {row.symbol}
                      {row.isNative ? (
                        <span className="rounded bg-surface-3 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-muted-2">
                          {t("wallet.native")}
                        </span>
                      ) : null}
                    </p>
                    <p className="truncate text-[11px] text-muted-2">{row.name}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-mono text-sm font-semibold tabular-nums text-foreground">
                      {row.balanceHuman}
                    </p>
                    {row.usdValue != null ? (
                      <p className="font-mono text-[11px] tabular-nums text-muted-2">
                        ${row.usdValue.toLocaleString("en-US", { maximumFractionDigits: 2 })}
                      </p>
                    ) : row.priceUsd != null && Number(row.balanceHuman) > 0 ? (
                      <p className="font-mono text-[11px] tabular-nums text-muted-3">—</p>
                    ) : null}
                  </div>
                  <ChevronDown
                    className={cn("h-3.5 w-3.5 shrink-0 text-muted-3 transition-transform", isOpen && "rotate-180")}
                    aria-hidden
                  />
                </button>

                <AnimatePresence initial={false}>
                  {isOpen ? (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.18 }}
                      className="overflow-hidden"
                    >
                      <div className="space-y-2.5 border-t border-foreground/10 px-3.5 py-2.5">
                        {!row.isNative ? (
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-3">
                              {t("wallet.contract")}
                            </span>
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate font-mono text-[10px] text-foreground/70" title={row.address}>
                                {row.address.slice(0, 10)}…{row.address.slice(-8)}
                              </span>
                              <button
                                type="button"
                                onClick={() => copyAddress(row.address)}
                                aria-label={t("common.copy")}
                                className="rounded-md p-1 text-muted-3 transition-colors hover:bg-surface-3 hover:text-foreground cursor-pointer"
                              >
                                {copied ? (
                                  <Check className="h-3 w-3 text-success" />
                                ) : (
                                  <Copy className="h-3 w-3" />
                                )}
                              </button>
                              {explorerTokenUrl ? (
                                <a
                                  href={explorerTokenUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="rounded-md p-1 text-primary transition-colors hover:bg-primary/10 cursor-pointer"
                                  title={t("trace.explorer")}
                                >
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-3">
                            {t("wallet.decimals")}
                          </span>
                          <span className="font-mono text-[10px] text-foreground/70">{row.decimals}</span>
                        </div>
                        {row.priceUsd != null ? (
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-3">
                              {t("wallet.price")}
                            </span>
                            <span className="font-mono text-[10px] text-foreground/70">
                              ${row.priceUsd.toLocaleString("en-US", { maximumFractionDigits: 6 })}
                            </span>
                          </div>
                        ) : null}
                        {row.isNative ? null : (
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-3">
                              {t("wallet.agentResolution")}
                            </span>
                            <span
                              className={cn(
                                "rounded-full px-2 py-0.5 text-[9px] font-medium",
                                row.inRegistry
                                  ? "bg-success/10 text-success"
                                  : "bg-surface-2 text-muted-2",
                              )}
                            >
                              {row.inRegistry ? t("wallet.resolvableBySymbol") : t("wallet.needsFullAddress")}
                            </span>
                          </div>
                        )}

                        <div className="flex flex-wrap gap-1.5 pt-0.5">
                          <button
                            type="button"
                            onClick={() => sendViaAgent(row)}
                            className="flex items-center gap-1.5 rounded-lg bg-primary/10 px-2.5 py-1.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20 cursor-pointer"
                          >
                            <Send className="h-3 w-3" />
                            {t("wallet.askSend", { symbol: row.symbol })}
                          </button>
                          <button
                            type="button"
                            onClick={() => onSwap(row.symbol)}
                            className="flex items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1.5 text-[11px] font-medium text-foreground/80 transition-colors hover:bg-surface-3 cursor-pointer"
                          >
                            <Repeat className="h-3 w-3" />
                            {t("wallet.askSwap", { symbol: row.symbol })}
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </motion.div>
            );
          })}

          {rows.length > 14 ? (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border px-3 py-2 text-[11px] text-muted-2 transition-colors hover:border-primary/40 hover:text-primary cursor-pointer"
            >
              <ArrowUpRight className="h-3 w-3" aria-hidden />
              {showAll
                ? t("wallet.showLess")
                : t("wallet.showMore", { count: rows.length - 14 })}
            </button>
          ) : null}
        </div>
      )}
    </Card>
  );
}
