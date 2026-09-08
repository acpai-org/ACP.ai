"use client";

import { memo, useCallback, useEffect, useState } from "react";
import { useBalance } from "wagmi";
import { formatUnits } from "viem";
import { Check, Layers } from "lucide-react";
import { CHAIN_REGISTRY } from "@/lib/wagmi/chains";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// ChainBreakdown — R10 Feature C.
//
// The wallet page used to show ONLY the active chain's native balance; seeing
// another chain meant switching to it. This card queries the native balance on
// EVERY registry chain at once (public RPC reads — no signing, one probe
// component per chain so the hook count is static) and breaks it down:
//
//   symbol groups (tCTC / CTC / ETH / POL) → segmented share bar (width =
//   that chain's slice of the symbol's total) + one row per chain with the
//   balance and share %, clickable to switch chains.
//
// Honesty invariants (N21/P6 lineage):
//  - NO cross-symbol totals, NO fiat valuation — segments only ever compare
//    the SAME native symbol across chains, which is a real on-chain fact.
//  - A chain whose RPC fails shows "—", never 0 (a failed read is not a
//    zero balance).
//  - Probes reset on account change so a stale address's numbers never
//    render for the new one.
// ─────────────────────────────────────────────────────────────────────────────

interface ProbeOk {
  status: "ok";
  value: string; // human-formatted via formatUnits at report time
  symbol: string;
}
type ProbeResult = ProbeOk | { status: "error" } | { status: "loading" };

/** One invisible useBalance probe per chain (static hook count — the
 *  registry is a module constant). */
const BalanceProbe = memo(function BalanceProbe({
  chainId,
  address,
  onResult,
}: {
  chainId: number;
  address: `0x${string}`;
  onResult: (chainId: number, result: ProbeResult) => void;
}) {
  const query = useBalance({ chainId, address });

  useEffect(() => {
    if (query.isPending) return;
    if (query.isError || !query.data) {
      onResult(chainId, { status: "error" });
      return;
    }
    const { value, decimals, symbol } = query.data;
    onResult(chainId, {
      status: "ok",
      value: formatUnits(value, decimals),
      symbol: symbol,
    });
  }, [query.isPending, query.isError, query.data, chainId, onResult]);

  return null;
});

/** Segment opacity ladder — the active chain reads solid, others fade by
 *  rank. Distinct WITHOUT introducing new hues (theme-safe, no blue). */
const SEGMENT_TONES = [
  "bg-primary/85",
  "bg-primary/65",
  "bg-primary/48",
  "bg-primary/35",
  "bg-primary/25",
  "bg-primary/18",
];

export function ChainBreakdown({
  address,
  activeChainId,
  onSwitch,
}: {
  address: `0x${string}`;
  activeChainId: number;
  onSwitch: (chainId: number) => void;
}) {
  const { t } = useI18n();
  const [results, setResults] = useState<Record<number, ProbeResult>>({});

  // Account switch: the parent remounts this component with `key={address}`
  // — state resets with the component, so a stale address's numbers never
  // render for the new one (and no setState-in-effect is needed).

  const onResult = useCallback((chainId: number, result: ProbeResult) => {
    setResults((prev) => {
      const cur = prev[chainId];
      if (cur && cur.status === result.status) {
        if (result.status !== "ok" || cur.status !== "ok") return prev;
        if (cur.value === result.value && cur.symbol === result.symbol) return prev;
      }
      return { ...prev, [chainId]: result };
    });
  }, []);

  // Symbol groups in registry order (Creditcoin family first — the app's
  // home chains), each with rows in registry order.
  const groups = (() => {
    const order: string[] = [];
    const bySymbol = new Map<string, typeof CHAIN_REGISTRY>();
    for (const def of CHAIN_REGISTRY) {
      const sym = def.nativeCurrency.symbol;
      if (!bySymbol.has(sym)) {
        bySymbol.set(sym, []);
        order.push(sym);
      }
      bySymbol.get(sym)!.push(def);
    }
    return order.map((symbol) => {
      const chains = bySymbol.get(symbol)!;
      const rows = chains.map((def) => {
        const r = results[def.chainId];
        const balance = r?.status === "ok" ? Number(r.value) : null;
        return { def, result: r ?? ({ status: "loading" } as ProbeResult), balance };
      });
      const total = rows.reduce((acc, row) => acc + (row.balance ?? 0), 0);
      return { symbol, rows, total };
    });
  })();

  return (
    <div className="glass-panel p-5 space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Layers className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            {t("wallet.chainBreakdown")}
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            {t("wallet.chainBreakdownDesc")}
          </p>
        </div>
      </div>

      {/* invisible probes — one per registry chain */}
      {CHAIN_REGISTRY.map((def) => (
        <BalanceProbe
          key={def.chainId}
          chainId={def.chainId}
          address={address}
          onResult={onResult}
        />
      ))}

      <div className="space-y-5">
        {groups.map((group) => {
          const okRows = group.rows.filter((r) => r.balance !== null);
          const groupTotal = group.total;
          return (
            <section key={group.symbol} aria-label={group.symbol}>
              {/* group header: symbol + total across chains holding it */}
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-2">
                  {group.symbol}
                </span>
                <span className="font-mono text-xs tabular-nums text-muted">
                  {okRows.length > 0
                    ? `${groupTotal.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${group.symbol}`
                    : t("wallet.rowUnavailable")}
                </span>
              </div>

              {/* segmented share bar — same-symbol slices only (honest by
                  construction). Active chain reads solid. */}
              <div
                className="mt-2 flex h-2.5 w-full overflow-hidden rounded-full bg-surface-2 ring-1 ring-border/60"
                role="img"
                aria-label={t("wallet.shareBarLabel", {
                  symbol: group.symbol,
                  total: groupTotal.toLocaleString(undefined, { maximumFractionDigits: 4 }),
                })}
              >
                {okRows.map((row, i) => {
                  if (groupTotal <= 0 || !row.balance) return null;
                  const pct = (row.balance / groupTotal) * 100;
                  const isActive = row.def.chainId === activeChainId;
                  return (
                    <div
                      key={row.def.chainId}
                      title={`${row.def.name}: ${row.balance.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${group.symbol} (${pct.toFixed(0)}%)`}
                      style={{ width: `${pct}%` }}
                      className={cn(
                        "h-full flex-none transition-[width] duration-500",
                        isActive ? "bg-primary" : SEGMENT_TONES[i % SEGMENT_TONES.length],
                      )}
                    />
                  );
                })}
              </div>

              {/* one row per chain — click to make it the active chain */}
              <div className="mt-2 space-y-1.5">
                {group.rows.map((row) => {
                  const isActive = row.def.chainId === activeChainId;
                  const pct =
                    row.balance !== null && groupTotal > 0
                      ? (row.balance / groupTotal) * 100
                      : null;
                  return (
                    <button
                      key={row.def.chainId}
                      type="button"
                      onClick={() => !isActive && onSwitch(row.def.chainId)}
                      aria-current={isActive ? "true" : undefined}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-all duration-200",
                        isActive
                          ? "border-primary/40 bg-primary/10"
                          : "border-border bg-surface-2/40 cursor-pointer hover:border-primary/30 hover:bg-surface-2/70",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "h-2 w-2 shrink-0 rounded-full",
                          isActive ? "bg-primary" : "bg-primary/40",
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-foreground">
                          {row.def.name}
                        </p>
                        <p className="text-[11px] text-muted-3">
                          {t("wallet.chainIdWithId", { chainId: row.def.chainId })}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        {row.result.status === "loading" ? (
                          <span className="shimmer inline-block h-4 w-20 rounded-md" />
                        ) : row.result.status === "error" ? (
                          <span
                            title={t("wallet.rowUnavailable")}
                            className="font-mono text-[13px] tabular-nums text-muted-3"
                          >
                            —
                          </span>
                        ) : (
                          <>
                            <p className="font-mono text-[13px] tabular-nums text-foreground">
                              {row.balance!.toLocaleString(undefined, {
                                maximumFractionDigits: 4,
                              })}
                            </p>
                            {pct !== null ? (
                              <p className="text-[10px] tabular-nums text-muted-3">
                                {pct <= 0.05 ? "<0.1" : pct.toFixed(1)}%
                              </p>
                            ) : null}
                          </>
                        )}
                      </div>
                      {isActive ? (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/20 px-2 py-0.5 text-[10px] font-medium text-primary">
                          <Check className="h-3 w-3" /> {t("wallet.active")}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      <p className="text-[11px] leading-relaxed text-muted-3">
        {t("wallet.breakdownNote")}
      </p>
    </div>
  );
}
