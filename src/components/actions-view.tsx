"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "motion/react";
import {
  Check,
  ChevronDown,
  CircleDot,
  Clock,
  Download,
  ExternalLink,
  Loader2,
  ShieldAlert,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { FinderSearch } from "@/components/finder-search";
import { useTxLifecycle } from "@/lib/agent/tx-lifecycle";
import { getChainByChainId } from "@/lib/chains/registry";
import { cc3ExplorerTxUrl, sourceExplorerTxUrl } from "@/lib/attestcoin/cc3-links";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// ActionsView (C7, Phase 3 §5/§10.3): the agent action log as the product's
// audit-trail surface — live-updating on every action and every lifecycle
// transition (C3's tx-lifecycle overlay), full detail per entry (timestamp,
// tool, chain, status, params, result summary, tx hash + explorer link, proof
// refs), finder search + status filters. Rendered on the Actions tab.
// ─────────────────────────────────────────────────────────────────────────────

interface ActionRow {
  id: string;
  runId: string | null;
  callId: string | null;
  tool: string;
  status: string;
  chainId: number | null;
  riskClass: string;
  confirmationRequired: boolean;
  params: Record<string, unknown> | null;
  result: { ok?: boolean; summary?: string; txHash?: string } | null;
  sourceTxHash: string | null;
  cc3TxHash: string | null;
  attestRoot: string | null;
  createdAt: number;
}

interface ActionsFeed {
  actions: ActionRow[];
  /** N27.1: server-side Attestcoin environment — powers CC3 explorer links. */
  cc3Env?: "testnet" | "mainnet";
}

const STATUS_STYLE: Record<string, string> = {
  succeeded: "text-success bg-success/10",
  failed: "text-danger bg-danger/10",
  declined: "text-muted-2 bg-surface-2",
  interrupted: "text-warning bg-warning/10",
  running: "text-primary bg-primary/10",
  pending: "text-muted-2 bg-surface-2",
  awaiting_confirmation: "text-warning bg-warning/10",
  awaiting_signature: "text-primary bg-primary/10",
  broadcast: "text-primary bg-primary/10",
  confirming: "text-primary bg-primary/10",
  unknown: "text-warning bg-warning/15",
  dispatched: "text-primary/80 bg-primary/5",
};

const LIVE_SPIN: Set<string> = new Set(["awaiting_signature", "broadcast", "confirming", "running", "pending"]);

type StatusFilter = "all" | "succeeded" | "failed" | "declined" | "inflight";

const STATUS_FILTERS: { value: StatusFilter; key: string }[] = [
  { value: "all", key: "payments.all" },
  { value: "succeeded", key: "actions.status.succeeded" },
  { value: "failed", key: "actions.status.failed" },
  { value: "declined", key: "actions.status.declined" },
  { value: "inflight", key: "actions.filterInflight" },
];

function statusMatchesFilter(status: string, filter: StatusFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "succeeded":
      return status === "succeeded";
    case "failed":
      return status === "failed" || status === "unknown" || status === "interrupted";
    case "declined":
      return status === "declined";
    case "inflight":
      return LIVE_SPIN.has(status);
  }
}

export function ActionsView({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [exported, setExported] = useState(false);

  // Live lifecycle overlay (C3): executor-driven transitions re-render rows
  // instantly and nudge the API query to refetch the persisted state.
  const liveEntries = useTxLifecycle((st) => st.entries);
  const liveCount = Object.keys(liveEntries).length;
  useEffect(() => {
    if (liveCount > 0) void queryClient.invalidateQueries({ queryKey: ["agent-action-log"] });
  }, [liveCount, queryClient]);
  const liveByCall = useMemo(() => {
    const m = new Map<string, { status: string; txHash?: string; chainId?: number; error?: string }>();
    for (const e of Object.values(liveEntries)) {
      if (e.status === "requested") m.set(e.callId, { status: "awaiting_signature" });
      else if (e.status === "signed" || e.status === "broadcast")
        m.set(e.callId, { status: "broadcast", txHash: e.txHash, chainId: e.chainId });
      else if (e.status === "confirmed") m.set(e.callId, { status: "succeeded", txHash: e.txHash, chainId: e.chainId });
      else if (e.status === "rejected") m.set(e.callId, { status: "declined" });
      else if (e.status === "timeout") m.set(e.callId, { status: "failed", error: "timeout" });
      else if (e.status === "unknown") m.set(e.callId, { status: "unknown", txHash: e.txHash, chainId: e.chainId });
      else if (e.status === "failed") m.set(e.callId, { status: "failed" });
    }
    return m;
  }, [liveEntries]);

  const { data } = useQuery<ActionsFeed>({
    queryKey: ["agent-action-log"],
    queryFn: async () => {
      const res = await fetch(`/api/agent/actions?limit=${compact ? 15 : 60}`, { cache: "no-store" });
      if (!res.ok) throw new Error("action log fetch failed");
      return res.json();
    },
    refetchInterval: compact ? 20_000 : 8_000,
  });

  const actions = useMemo(() => data?.actions ?? [], [data]);
  // N27.1: CC3 explorer deep links (server-side environment truth).
  const cc3Env = data?.cc3Env;

  // Search matches tool name, status, result summary, params JSON, hashes.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return actions.filter((a) => {
      const live = a.callId ? liveByCall.get(a.callId) : undefined;
      const rowStatus = live?.status ?? a.status;
      if (!statusMatchesFilter(rowStatus, filter)) return false;
      if (!q) return true;
      const hay = [
        a.tool,
        rowStatus,
        a.result?.summary ?? "",
        a.result?.txHash ?? "",
        a.sourceTxHash ?? "",
        a.cc3TxHash ?? "",
        a.attestRoot ?? "",
        a.params ? JSON.stringify(a.params) : "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [actions, search, filter, liveByCall]);

  /** Export the full log (up to the API's 200-row max) as a JSON audit file. */
  const exportLog = async () => {
    try {
      const res = await fetch("/api/agent/actions?limit=200", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { actions: ActionRow[] };
      const payload = {
        acpActionLog: 1,
        exportedAt: new Date().toISOString(),
        actions: json.actions,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `acp-action-log-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExported(true);
      setTimeout(() => setExported(false), 1500);
    } catch {
      // no-op — export is best-effort
    }
  };

  const stats = useMemo(() => {
    let succeeded = 0;
    let inflight = 0;
    let failed = 0;
    for (const a of actions) {
      const live = a.callId ? liveByCall.get(a.callId) : undefined;
      const st = live?.status ?? a.status;
      if (st === "succeeded") succeeded++;
      else if (LIVE_SPIN.has(st)) inflight++;
      else if (st === "failed" || st === "unknown" || st === "interrupted" || st === "declined") failed++;
    }
    return { succeeded, inflight, failed, total: actions.length };
  }, [actions, liveByCall]);

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Clock className="h-4 w-4 text-muted" aria-hidden />
        <h2 className="text-sm font-semibold text-foreground">{t("actions.title")}</h2>
        {stats.total > 0 ? (
          <span className="flex items-center gap-1.5 text-[10px] text-muted-2">
            <span className="rounded-md bg-success/10 px-1.5 py-0.5 font-semibold text-success">{stats.succeeded} {t("actions.status.succeeded")}</span>
            {stats.inflight > 0 ? (
              <span className="flex items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 font-semibold text-primary">
                <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden />
                {stats.inflight} {t("actions.filterInflight")}
              </span>
            ) : null}
            {stats.failed > 0 ? (
              <span className="rounded-md bg-danger/10 px-1.5 py-0.5 font-semibold text-danger">{stats.failed}</span>
            ) : null}
          </span>
        ) : (
          <span className="text-[10px] text-muted-2">{t("actions.subtitle")}</span>
        )}
        {actions.length > 0 ? (
          <button
            type="button"
            onClick={() => void exportLog()}
            className="hit-slop ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-muted-2 transition-colors hover:bg-surface-3 hover:text-foreground"
            title={t("actions.export")}
            aria-label={t("actions.export")}
          >
            {exported ? <Check className="h-3.5 w-3.5 text-success" aria-hidden /> : <Download className="h-3.5 w-3.5" aria-hidden />}
          </button>
        ) : null}
      </div>

      {!compact ? (
        <div className="mb-3 space-y-2">
          <FinderSearch
            value={search}
            onChange={setSearch}
            placeholder={t("actions.searchPlaceholder")}
            ariaLabel={t("actions.searchPlaceholder")}
          />
          <div className="flex flex-wrap gap-1.5">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setFilter(f.value)}
                aria-pressed={filter === f.value}
                className={cn(
                  "flex min-h-9 items-center rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60",
                  filter === f.value
                    ? "bg-primary/15 text-primary ring-1 ring-inset ring-primary/30"
                    : "glass-item text-muted hover:text-foreground",
                )}
              >
                {t(f.key as never)}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {filtered.length === 0 ? (
        actions.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-2">{t("actions.empty")}</p>
        ) : (
          <p className="py-4 text-center text-xs text-muted-2">{t("actions.noMatches")}</p>
        )
      ) : (
        <div className={cn("acp-scroll space-y-1.5 overflow-y-auto pr-1", compact ? "max-h-80" : "max-h-[60vh]")}>
          {filtered.map((a, i) => {
            const live = a.callId ? liveByCall.get(a.callId) : undefined;
            const rowStatus = live?.status ?? a.status;
            const rowTxHash = a.result?.txHash ?? live?.txHash;
            const rowChainId = live?.chainId ?? a.chainId;
            const chain = rowChainId ? getChainByChainId(rowChainId) : undefined;
            const explorer = rowTxHash && chain?.explorerUrl ? `${chain.explorerUrl}/tx/${rowTxHash}` : null;
            const isLive = LIVE_SPIN.has(rowStatus);
            const isExpanded = expandedId === a.id;
            const hasDetail = Boolean(a.params || a.cc3TxHash || a.attestRoot || a.sourceTxHash || a.runId);
            return (
              <motion.div
                key={a.id}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: Math.min(i * 0.03, 0.25), duration: 0.2 }}
                className={cn(
                  "rounded-xl border border-foreground/10 bg-foreground/[0.03] px-3 py-2 transition-colors",
                  isLive && "border-primary/25 bg-primary/[0.04]",
                  rowStatus === "unknown" && "border-warning/30 bg-warning/[0.05]",
                  hasDetail && "cursor-pointer hover:border-foreground/20",
                )}
                onClick={hasDetail ? () => setExpandedId(isExpanded ? null : a.id) : undefined}
                role={hasDetail ? "button" : undefined}
                aria-expanded={hasDetail ? isExpanded : undefined}
              >
                <div className="flex items-center gap-2">
                  {isLive ? (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" aria-hidden />
                  ) : (
                    <span
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        rowStatus === "succeeded" ? "bg-success/70"
                        : rowStatus === "failed" || rowStatus === "unknown" ? "bg-danger/70"
                        : rowStatus === "declined" ? "bg-muted-2/60"
                        : "bg-muted-2/40",
                      )}
                      aria-hidden
                    />
                  )}
                  <span
                    className={cn(
                      "rounded-md px-1.5 py-0.5 text-[10px] font-semibold",
                      STATUS_STYLE[rowStatus] ?? "text-muted-2 bg-surface-2",
                    )}
                  >
                    {t(`actions.status.${rowStatus}` as never)}
                  </span>
                  <span className="text-xs font-medium text-foreground/90">{t(`trace.tool${toolLabel(a.tool)}` as never)}</span>
                  {chain ? (
                    <span className={cn("hidden text-[10px] font-medium sm:inline", chain.testnet ? "text-amber-600 dark:text-amber-300" : "text-emerald-600 dark:text-emerald-300")}>
                      {chain.shortName}
                    </span>
                  ) : null}
                  {a.confirmationRequired ? (
                    <span title={t("actions.confirmationAsked")} className="flex items-center">
                      <ShieldAlert className="h-3 w-3 text-warning/70" aria-hidden />
                    </span>
                  ) : null}
                  <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-2">
                    {timeShort(a.createdAt)}
                    {hasDetail ? (
                      <ChevronDown
                        className={cn("h-3 w-3 transition-transform", isExpanded && "rotate-180")}
                        aria-hidden
                      />
                    ) : null}
                  </span>
                </div>
                {a.result?.summary ? (
                  <p className={cn("mt-1 wrap-anywhere break-words text-[11px] leading-relaxed text-muted", !isExpanded && "line-clamp-2")}>
                    {a.result.summary}
                  </p>
                ) : null}
                {(rowTxHash || a.cc3TxHash || a.attestRoot) ? (
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
                    {rowTxHash ? (
                      <span className="font-mono text-foreground/40">
                        {chain?.shortName ?? ""} {rowTxHash.slice(0, 10)}…{rowTxHash.slice(-4)}
                      </span>
                    ) : null}
                    {a.cc3TxHash ? (
                      (() => {
                        const cc3Url = cc3ExplorerTxUrl(cc3Env, a.cc3TxHash);
                        const label = (
                          <>
                            <CircleDot className="h-2.5 w-2.5" aria-hidden />
                            CC {a.cc3TxHash.slice(0, 8)}…{a.cc3TxHash.slice(-4)}
                          </>
                        );
                        return cc3Url ? (
                          <a
                            href={cc3Url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title={t("actions.cc3ExplorerTip")}
                            className="inline-flex items-center gap-0.5 font-mono text-primary/70 underline decoration-primary/30 underline-offset-2 hover:text-primary hover:decoration-primary"
                          >
                            {label}
                          </a>
                        ) : (
                          <span className="flex items-center gap-0.5 font-mono text-primary/70">{label}</span>
                        );
                      })()
                    ) : null}
                    {a.attestRoot ? (
                      <span className="font-mono text-foreground/30" title={a.attestRoot}>
                        ⬡ {a.attestRoot.slice(0, 8)}…
                      </span>
                    ) : null}
                    {explorer ? (
                      <a
                        href={explorer}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-0.5 text-primary hover:text-primary-hover"
                      >
                        <ExternalLink className="h-2.5 w-2.5" aria-hidden />
                        {t("trace.explorer")}
                      </a>
                    ) : null}
                  </div>
                ) : null}
                {/* Expanded detail (C7): params, refs, timestamps — the full story. */}
                <AnimatePresence initial={false}>
                  {isExpanded ? (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.18 }}
                      className="overflow-hidden"
                    >
                      <div className="mt-2 space-y-1.5 rounded-lg border border-foreground/10 bg-foreground/[0.03] p-2.5 text-[10px]">
                        <DetailLine label={t("actions.detailTime")} value={new Date(a.createdAt).toLocaleString()} />
                        {a.runId ? <DetailLine label={t("actions.detailRun")} value={a.runId} mono /> : null}
                        {a.callId ? <DetailLine label={t("actions.detailCall")} value={a.callId} mono /> : null}
                        {a.sourceTxHash ? (
                          (() => {
                            const srcUrl = sourceExplorerTxUrl(a.chainId, a.sourceTxHash);
                            if (!srcUrl) return <DetailLine label={t("actions.detailSourceTx")} value={a.sourceTxHash} mono />;
                            return (
                              <p className="flex items-baseline justify-between gap-3">
                                <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wider text-foreground/30">{t("actions.detailSourceTx")}</span>
                                <a
                                  href={srcUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex min-w-0 items-center gap-1 truncate font-mono text-primary/80 underline decoration-primary/30 underline-offset-2 hover:text-primary"
                                >
                                  {a.sourceTxHash}
                                  <ExternalLink className="h-2.5 w-2.5 shrink-0" aria-hidden />
                                </a>
                              </p>
                            );
                          })()
                        ) : null}
                        {a.riskClass ? <DetailLine label={t("actions.detailRisk")} value={a.riskClass} /> : null}
                        {a.params ? (
                          <div>
                            <p className="mb-0.5 text-[9px] font-semibold uppercase tracking-wider text-foreground/30">{t("actions.detailParams")}</p>
                            <pre className="acp-scroll max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md p-1.5 code-surface font-mono text-[9px] leading-relaxed text-foreground/60">
                              {JSON.stringify(a.params, null, 1)}
                            </pre>
                          </div>
                        ) : null}
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

function DetailLine({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <p className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wider text-foreground/30">{label}</span>
      <span className={cn("min-w-0 truncate text-right text-foreground/60", mono && "font-mono")}>{value}</span>
    </p>
  );
}

function toolLabel(tool: string): string {
  const map: Record<string, string> = {
    get_balances: "Balances",
    get_transaction_status: "TxStatus",
    check_attestation_status: "CheckAttestation",
    wait_for_attestation: "WaitAttestation",
    attestcoin_network_status: "AttestcoinStatus",
    list_contacts: "Contacts",
    create_contact: "SaveContact",
    list_chains: "Chains",
    list_recent_actions: "Actions",
    get_app_status: "AppStatus",
    transfer: "Transfer",
    batch_transfer: "Batch",
    deploy_contract: "Deploy",
    create_conditional_release: "Escrow",
    execute_conditional_release: "Release",
    cross_chain_swap: "Swap",
    create_recurring_payment: "Recurring",
    list_recurring_payments: "ListRecurring",
    cancel_recurring_payment: "CancelRecurring",
    recurring_payment: "Recurring",
    automation_rule: "Automation",
    create_automation_rule: "NewAutomation",
    update_automation_rule: "EditAutomation",
    delete_automation_rule: "DeleteAutomation",
    list_automation_rules: "ListAutomation",
    decode_source_transaction: "DecodeTx",
    verify_proof_readonly: "VerifyProof",
    estimate_verification_cost: "CostEstimate",
    get_attestation_bounds: "Bounds",
    submit_proof_onchain: "SubmitProof",
    // P24 app-level mutation rows (UI-initiated)
    payment_settle: "PaymentSettle",
    contact_create: "SaveContact",
    contact_update: "EditContact",
    contact_delete: "DeleteContact",
    recurring_create: "NewRecurring",
    recurring_update: "EditRecurring",
    recurring_delete: "DeleteRecurring",
    automation_create: "NewAutomation",
    automation_update: "EditAutomation",
    automation_delete: "DeleteAutomation",
    skill_create: "NewSkill",
    skill_update: "EditSkill",
    skill_delete: "DeleteSkill",
  };
  return map[tool] ?? "";
}

function timeShort(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`;
  return new Date(ts).toLocaleDateString();
}
