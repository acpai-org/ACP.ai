"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "motion/react";
import Link from "next/link";
import {
  ArrowDownLeft,
  ArrowUpRight,
  PenLine,
  ChevronDown,
  ExternalLink,
  Activity as ActivityIcon,
  CircleAlert,
  Loader2,
  Repeat,
  Receipt,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n";
import { getChainByChainId } from "@/lib/chains/registry";
import { networkName } from "@/lib/wagmi/chains";
import { useContacts } from "@/lib/api";
import { payeeKey } from "@/lib/contacts/rollup";
import { shortenAddress } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAskAgent } from "@/lib/use-ask-agent";

// ─────────────────────────────────────────────────────────────────────────────
// ActivityLog (C8): the Wallet tab's unified history — on-chain transactions
// and token transfers (explorer API) MERGED with the local agent-signature
// log (every action the wallet signed through the agent), newest-first, with
// filter chips and expandable detail per entry.
// ─────────────────────────────────────────────────────────────────────────────

interface OnchainEntry {
  /** Server-assigned unique identity (N14 duplicate-key fix). */
  id: string;
  kind: "tx" | "transfer";
  hash: string;
  direction: "in" | "out";
  timestamp: number | null;
  status: "ok" | "error" | "pending";
  method: string | null;
  tokenSymbol: string | null;
  amountHuman: string | null;
  from: string;
  to: string | null;
  feeHuman: string | null;
  explorerUrl: string | null;
}

interface AgentEntry {
  id: string;
  tool: string;
  status: string;
  createdAt: number;
  result: { summary?: string; txHash?: string } | null;
  params: Record<string, unknown> | null;
}

interface MergedEntry {
  id: string;
  source: "onchain" | "agent";
  timestamp: number | null;
  onchain?: OnchainEntry;
  agent?: AgentEntry;
}

type ActivityFilter = "all" | "onchain" | "agent";

function timeAgo(ts: number | null): string {
  if (ts == null) return "—";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`;
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)}d`;
  return new Date(ts).toLocaleDateString();
}

export function ActivityLog({ address, chainId }: { address: string; chainId: number }) {
  const { t } = useI18n();
  const askAgent = useAskAgent();
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const onchainQuery = useQuery<{ source: string; entries: OnchainEntry[] }>({
    queryKey: ["wallet-activity", chainId, address],
    queryFn: async () => {
      const res = await fetch(`/api/wallet/activity?chainId=${chainId}&address=${address}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("activity fetch failed");
      return res.json();
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const agentQuery = useQuery<{ actions: AgentEntry[] }>({
    queryKey: ["agent-action-log", "wallet-activity"],
    queryFn: async () => {
      const res = await fetch("/api/agent/actions?limit=25", { cache: "no-store" });
      if (!res.ok) throw new Error("action log fetch failed");
      return res.json();
    },
    refetchInterval: 20_000,
  });

  // R15 (repeat affordance): resolve known payees to their address-book label
  // so a Pay-again prompt reads "Coffee Buddy", not just 0x9f8a… Shared
  // ["contacts"] query key — one local read, cached across pages.
  const { data: contacts } = useContacts();
  const contactLabelByAddress = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of contacts ?? []) map.set(payeeKey(c.address), c.label);
    return map;
  }, [contacts]);

  const merged = useMemo<MergedEntry[]>(() => {
    const list: MergedEntry[] = [];
    for (const e of onchainQuery.data?.entries ?? []) {
      list.push({ id: `oc-${e.id}`, source: "onchain", timestamp: e.timestamp, onchain: e });
    }
    for (const a of agentQuery.data?.actions ?? []) {
      list.push({ id: `ag-${a.id}`, source: "agent", timestamp: a.createdAt, agent: a });
    }
    list.sort((x, y) => (y.timestamp ?? 0) - (x.timestamp ?? 0));
    return list.slice(0, 40);
  }, [onchainQuery.data, agentQuery.data]);

  const filtered = useMemo(() => {
    if (filter === "all") return merged;
    return merged.filter((e) => (filter === "onchain" ? e.source === "onchain" : e.source === "agent"));
  }, [merged, filter]);

  const counts = useMemo(
    () => ({
      onchain: merged.filter((e) => e.source === "onchain").length,
      agent: merged.filter((e) => e.source === "agent").length,
    }),
    [merged],
  );

  const chain = getChainByChainId(chainId);
  const nativeSymbol = chain?.nativeCurrency.symbol ?? "ETH";

  const FILTERS: { value: ActivityFilter; key: string; count?: number }[] = [
    { value: "all", key: "payments.all", count: merged.length },
    { value: "onchain", key: "wallet.filterOnchain", count: counts.onchain },
    { value: "agent", key: "wallet.filterAgent", count: counts.agent },
  ];

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ActivityIcon className="h-4 w-4 text-muted" aria-hidden />
        <h2 className="text-sm font-semibold text-foreground">{t("wallet.activity")}</h2>
        <span className="text-[10px] text-muted-2">{t("wallet.activitySubtitle")}</span>
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            aria-pressed={filter === f.value}
            className={cn(
              "flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60",
              filter === f.value
                ? "bg-primary/15 text-primary ring-1 ring-inset ring-primary/30"
                : "glass-item text-muted hover:text-foreground",
            )}
          >
            {t(f.key as never)}
            {f.count != null && f.count > 0 ? (
              <span className="rounded bg-surface-3/80 px-1 text-[9px] tabular-nums text-muted-2">{f.count}</span>
            ) : null}
          </button>
        ))}
      </div>

      {onchainQuery.isError && !agentQuery.data?.actions?.length ? (
        <button
          type="button"
          onClick={() => void onchainQuery.refetch()}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-danger/30 bg-danger/5 px-3 py-3 text-xs text-danger transition-colors hover:bg-danger/10 cursor-pointer"
        >
          <CircleAlert className="h-3.5 w-3.5" />
          {t("wallet.activityErrorRetry")}
        </button>
      ) : filtered.length === 0 ? (
        <div className="py-8 text-center">
          <p className="text-xs text-muted-2">{t("wallet.activityEmpty")}</p>
          <button
            type="button"
            onClick={() =>
              askAgent(
                t("wallet.activityAskAgent", { chain: chain?.name ?? `Chain ${chainId}` }),
              )
            }
            className="mt-2 text-[11px] font-medium text-primary transition-colors hover:text-primary-hover cursor-pointer"
          >
            {t("wallet.activityTryPrompt")}
          </button>
        </div>
      ) : (
        <div className="acp-scroll max-h-[28rem] space-y-1.5 overflow-y-auto pr-1">
          {filtered.map((e, i) => {
            const isOpen = expandedId === e.id;
            const isPending = e.source === "onchain" ? e.onchain!.status === "pending" : false;
            const liveStatus =
              e.source === "agent"
                ? e.agent!.status
                : e.onchain!.status === "ok"
                  ? "succeeded"
                  : e.onchain!.status === "error"
                    ? "failed"
                    : "pending";
            const isAgentLive =
              e.source === "agent" &&
              ["pending", "awaiting_confirmation", "awaiting_signature", "broadcast", "running"].includes(
                e.agent!.status,
              );
            return (
              <motion.div
                key={e.id}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: Math.min(i * 0.02, 0.2), duration: 0.18 }}
                className={cn(
                  "rounded-xl border border-foreground/10 bg-foreground/[0.03] transition-colors",
                  isOpen && "border-primary/25 bg-primary/[0.04]",
                  liveStatus === "failed" && "border-danger/20",
                  isPending && "border-warning/25 bg-warning/[0.04]",
                )}
              >
                <button
                  type="button"
                  onClick={() => setExpandedId(isOpen ? null : e.id)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left cursor-pointer"
                >
                  {e.source === "agent" ? (
                    isAgentLive ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden />
                    ) : (
                      <span
                        className={cn(
                          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
                          e.agent!.status === "declined"
                            ? "bg-surface-2 text-muted-2"
                            : "bg-primary/10 text-primary",
                        )}
                      >
                        <PenLine className="h-3 w-3" aria-hidden />
                      </span>
                    )
                  ) : (
                    <span
                      className={cn(
                        "flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
                        e.onchain!.direction === "in"
                          ? "bg-success/10 text-success"
                          : "bg-surface-2 text-foreground/70",
                      )}
                    >
                      {e.onchain!.direction === "in" ? (
                        <ArrowDownLeft className="h-3 w-3" aria-hidden />
                      ) : (
                        <ArrowUpRight className="h-3 w-3" aria-hidden />
                      )}
                    </span>
                  )}

                  <div className="min-w-0 flex-1">
                    {e.source === "onchain" ? (
                      <p className="truncate text-xs font-medium text-foreground/90">
                        {e.onchain!.kind === "transfer"
                          ? e.onchain!.amountHuman
                            ? t("wallet.transferOf", {
                                amount: e.onchain!.amountHuman,
                                symbol: e.onchain!.tokenSymbol ?? "?",
                              })
                            : t("wallet.tokenTransfer")
                          : e.onchain!.amountHuman
                            ? t("wallet.transferOf", {
                                amount: e.onchain!.amountHuman,
                                symbol: e.onchain!.tokenSymbol ?? nativeSymbol,
                              })
                            : t("wallet.contractCall")}
                        {e.onchain!.method ? (
                          <span className="ml-1.5 rounded bg-surface-3 px-1 py-px font-mono text-[9px] text-muted-2">
                            {e.onchain!.method}
                          </span>
                        ) : null}
                      </p>
                    ) : (
                      <p className="truncate text-xs font-medium text-foreground/90">
                        {t(`trace.tool${agentToolLabel(e.agent!.tool)}` as never)}
                        <span className="ml-1.5 text-[10px] font-normal text-muted-2">
                          {t("wallet.agentSignature")}
                        </span>
                      </p>
                    )}
                    <p className="text-[10px] text-muted-3">
                      {e.source === "agent" && e.agent!.result?.summary ? (
                        <span className="line-clamp-1">{e.agent!.result.summary}</span>
                      ) : (
                        timeAgo(e.timestamp)
                      )}
                    </p>
                  </div>

                  <span
                    className={cn(
                      "shrink-0 rounded-md px-1.5 py-0.5 text-[9px] font-semibold",
                      liveStatus === "succeeded"
                        ? "bg-success/10 text-success"
                        : liveStatus === "failed"
                          ? "bg-danger/10 text-danger"
                          : liveStatus === "declined"
                            ? "bg-surface-2 text-muted-2"
                            : "bg-primary/10 text-primary",
                    )}
                  >
                    {e.source === "agent"
                      ? t(`actions.status.${e.agent!.status}` as never)
                      : e.onchain!.status === "ok"
                        ? t("wallet.txConfirmed")
                        : e.onchain!.status === "error"
                          ? t("wallet.txFailed")
                          : t("wallet.txPending")}
                  </span>
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-3">
                    {timeAgo(e.timestamp)}
                  </span>
                  <ChevronDown
                    className={cn("h-3 w-3 shrink-0 text-muted-3 transition-transform", isOpen && "rotate-180")}
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
                      <div className="space-y-1.5 border-t border-foreground/10 px-3 py-2.5 text-[10px]">
                        {e.source === "onchain" ? (
                          <>
                            <DetailRow
                              label={t("wallet.txHash")}
                              value={`${e.onchain!.hash.slice(0, 14)}…${e.onchain!.hash.slice(-10)}`}
                              mono
                              link={e.onchain!.explorerUrl}
                            />
                            <DetailRow label={t("wallet.fromAddr")} value={short(e.onchain!.from)} mono />
                            {e.onchain!.to ? (
                              <DetailRow label={t("wallet.toAddr")} value={short(e.onchain!.to)} mono />
                            ) : null}
                            {e.onchain!.feeHuman ? (
                              <DetailRow
                                label={t("wallet.txFee")}
                                value={`${e.onchain!.feeHuman} ${nativeSymbol}`}
                                mono
                              />
                            ) : null}
                            {e.timestamp ? (
                              <DetailRow label={t("actions.detailTime")} value={new Date(e.timestamp).toLocaleString()} />
                            ) : null}
                            {/* R18 (WHO lens): out-flows with a known
                                recipient deep-link into the payments page
                                filtered to that address — the same
                                ?contact= lens the contacts rollup uses. Offered
                                for ANY status (the lens is address-based, not
                                tx-based). Sits beside Pay-again when both
                                apply; alone on pending rows. */}
                            {e.onchain!.direction === "out" && e.onchain!.to ? (
                              <div className="mt-1 flex gap-1.5">
                                {e.onchain!.amountHuman && e.onchain!.status !== "pending" ? (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      askAgent(
                                        t("payments.payAgainPrompt", {
                                          amount: e.onchain!.amountHuman!,
                                          token: e.onchain!.tokenSymbol ?? nativeSymbol,
                                          name:
                                            contactLabelByAddress.get(payeeKey(e.onchain!.to!)) ??
                                            shortenAddress(e.onchain!.to!),
                                          address: e.onchain!.to!,
                                          chain: networkName(chainId),
                                        }),
                                      )
                                    }
                                    className="flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-primary/25 bg-primary/10 px-3 py-1.5 text-[11px] font-medium text-primary transition-all duration-200 hover:border-primary/45 hover:bg-primary/20 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                                  >
                                    <Repeat className="h-3 w-3" aria-hidden />
                                    {t("payments.payAgain")}
                                  </button>
                                ) : null}
                                <Link
                                  href={`/payments?contact=${encodeURIComponent(e.onchain!.to)}`}
                                  aria-label={t("payments.contactFilterLabel", {
                                    name:
                                      contactLabelByAddress.get(payeeKey(e.onchain!.to)) ??
                                      shortenAddress(e.onchain!.to),
                                  })}
                                  title={t("payments.contactFilterLabel", {
                                    name:
                                      contactLabelByAddress.get(payeeKey(e.onchain!.to)) ??
                                      shortenAddress(e.onchain!.to),
                                  })}
                                  className="flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border/70 bg-surface-2/40 px-3 py-1.5 text-[11px] font-medium text-muted-2 transition-all duration-200 hover:border-primary/40 hover:text-primary hover:bg-primary/5 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                                >
                                  <Receipt className="h-3 w-3" aria-hidden />
                                  {t("wallet.viewPayments")}
                                </Link>
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <>
                            <DetailRow label={t("actions.detailTime")} value={new Date(e.agent!.createdAt).toLocaleString()} />
                            {e.agent!.result?.summary ? (
                              <p className="wrap-anywhere break-words leading-relaxed text-foreground/60">{e.agent!.result.summary}</p>
                            ) : null}
                            {e.agent!.result?.txHash ? (
                              <DetailRow
                                label={t("wallet.txHash")}
                                value={`${e.agent!.result.txHash.slice(0, 14)}…${e.agent!.result.txHash.slice(-10)}`}
                                mono
                                link={
                                  chain?.explorerUrl
                                    ? `${chain.explorerUrl}/tx/${e.agent!.result.txHash}`
                                    : null
                                }
                              />
                            ) : null}
                            {e.agent!.params ? (
                              <pre className="acp-scroll max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-md p-1.5 code-surface font-mono text-[9px] leading-relaxed text-foreground/60">
                                {JSON.stringify(e.agent!.params, null, 1)}
                              </pre>
                            ) : null}
                          </>
                        )}
                      </div>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </motion.div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function DetailRow({
  label,
  value,
  mono,
  link,
}: {
  label: string;
  value: string;
  mono?: boolean;
  link?: string | null;
}) {
  const { t } = useI18n();
  return (
    <p className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wider text-foreground/30">{label}</span>
      <span className="flex min-w-0 items-center gap-1 text-right">
        <span className={cn("truncate text-foreground/60", mono && "font-mono")}>{value}</span>
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-primary hover:text-primary-hover"
            title={t("trace.explorer")}
          >
            <ExternalLink className="h-2.5 w-2.5" />
          </a>
        ) : null}
      </span>
    </p>
  );
}

function short(addr: string): string {
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function agentToolLabel(tool: string): string {
  const map: Record<string, string> = {
    transfer: "Transfer",
    batch_transfer: "Batch",
    deploy_contract: "Deploy",
    create_conditional_release: "Escrow",
    execute_conditional_release: "Release",
    cross_chain_swap: "Swap",
    create_recurring_payment: "Recurring",
    recurring_payment: "Recurring",
    automation_rule: "Automation",
    get_balances: "Balances",
    get_transaction_status: "TxStatus",
    check_attestation_status: "CheckAttestation",
    wait_for_attestation: "WaitAttestation",
    attestcoin_network_status: "AttestcoinStatus",
    list_contacts: "Contacts",
    list_chains: "Chains",
    list_recent_actions: "Actions",
    get_app_status: "AppStatus",
  };
  return map[tool] ?? "";
}
