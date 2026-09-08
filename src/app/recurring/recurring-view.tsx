"use client";

import { useMemo, useState, useCallback, useEffect, memo } from "react";
import Link from "next/link";
import { useAccount, useBalance } from "wagmi";
import {
  CalendarClock,
  Plus,
  Loader2,
  Clock,
  Check,
  X,
  RefreshCw,
  AlertCircle,
  Trash2,
  Power,
  ShieldCheck,
  ChevronDown,
  Copy,
  Hash,
  Zap,
  Wand2,
  PlayCircle,
  Sparkles,
  Star,
  UserPlus,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { PageContainer } from "@/components/page-container";
import { Card, StatCard, EmptyState } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useRecurringSchedules, useDeleteRecurring, useFireRecurring, useUpdateRecurring, useContacts } from "@/lib/api";
import { useAskAgent } from "@/lib/use-ask-agent";
import { useRecurringSchedule } from "@/lib/use-recurring-schedule";
import { shortenAddress, timeAgo, timeUntil, formatFullDate } from "@/lib/format";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { CHAIN_REGISTRY, getChainByChainId } from "@/lib/chains/registry";
import { useAgentRun } from "@/lib/agent/use-agent-run";
import { useAiProvider } from "@/lib/ai/provider-store";
import { useTokenBalances } from "@/lib/use-token-balances";
import { dispatchAgentUserMessage, activeSessionBusy, chainDisplayName } from "@/lib/agent/agent-dispatch";
import {
  cadenceLabelParts,
  cadenceIntervalMs,
  validateCustomCadence,
  clampCustom,
  cadenceUnitBounds,
  CADENCE_UNITS,
  type CadencePreset,
  type CadenceUnit,
} from "@/lib/recurring/cadence";

// ── C37 cadence UI helpers ─────────────────────────────────────────────────
// Presets (daily/weekly/biweekly/monthly) + fully-custom intervals
// ("every 6 hours", "every 10 days") — labels localize via i18n, math and
// validation live in lib/recurring/cadence.ts.
type CadenceSelection =
  | { mode: "preset"; preset: CadencePreset }
  | { mode: "custom"; unit: CadenceUnit; n: number };

const PRESET_LABEL_KEYS: Record<CadencePreset, TranslationKey> = {
  daily: "recurring.daily",
  weekly: "recurring.weekly",
  biweekly: "recurring.biweekly",
  monthly: "recurring.monthly",
};

const PRESET_ORDER: CadencePreset[] = ["daily", "weekly", "biweekly", "monthly"];

const CUSTOM_UNIT_LABEL_KEYS: Record<CadenceUnit, TranslationKey> = {
  seconds: "recurring.everySeconds",
  minutes: "recurring.everyMinutes",
  hours: "recurring.everyHours",
  days: "recurring.everyDays",
};

function cadenceSelectionLabel(sel: CadenceSelection, t: (k: TranslationKey, params?: Record<string, string | number>) => string): string {
  if (sel.mode === "preset") return t(PRESET_LABEL_KEYS[sel.preset]);
  return t(CUSTOM_UNIT_LABEL_KEYS[sel.unit], { n: sel.n });
}

/** ANY stored cadence dialect → the localized human label. */
function cadenceLabel(cadence: string | number, t: (k: TranslationKey, params?: Record<string, string | number>) => string): string {
  const parts = cadenceLabelParts(cadence);
  if (parts.kind === "preset") return t(PRESET_LABEL_KEYS[parts.preset]);
  return t(CUSTOM_UNIT_LABEL_KEYS[parts.unit], { n: parts.n });
}

const LAST_STATUS_TONE: Record<string, { labelKey: TranslationKey; className: string }> = {
  dispatched: { labelKey: "recurring.statusDispatched", className: "bg-success/10 text-success" },
  deferred: { labelKey: "recurring.statusDeferred", className: "bg-warning/10 text-warning" },
  failed: { labelKey: "recurring.statusFailed", className: "bg-danger/10 text-danger" },
  fired: { labelKey: "recurring.statusFired", className: "bg-primary/10 text-primary" },
  complete: { labelKey: "recurring.complete", className: "bg-success/10 text-success" },
  paused: { labelKey: "recurring.statusPaused", className: "bg-muted/15 text-muted-2" },
};

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <span className="text-muted-2 shrink-0 text-xs">{label}</span>
      <span className="text-right text-xs">{children}</span>
    </div>
  );
}

function CopyableValue({ value, label }: { value: string; label?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="flex items-center gap-1 font-mono text-xs text-muted transition-colors hover:text-foreground"
      title={label ? `${t("common.copy")} ${label}` : t("common.copy")}
    >
      {shortenAddress(value)}
      <Copy className={cn("h-3 w-3 transition-opacity", copied ? "opacity-100 text-success" : "opacity-40")} />
    </button>
  );
}

const ScheduleRow = memo(function ScheduleRow({
  schedule,
  isExpanded,
  onToggle,
  onCancel,
  isCancelling,
  cancelingId,
  onDelete,
  deletingId,
  onRunNow,
  runningNowId,
  onResume,
  resumingId,
  now,
}: {
  schedule: RecurringScheduleDbType;
  isExpanded: boolean;
  onToggle: () => void;
  onCancel: (scheduleIdHash: string, dbId: string) => void;
  isCancelling: boolean;
  cancelingId: string | null;
  onDelete: (dbId: string) => void;
  deletingId: string | null;
  onRunNow: (schedule: RecurringScheduleDbType) => void;
  runningNowId: string | null;
  onResume: (schedule: RecurringScheduleDbType) => void;
  resumingId: string | null;
  now: number;
}) {
  const { t } = useI18n();
  const askAgent = useAskAgent();
  const cLabel = cadenceLabel(schedule.cadence, t);
  const chain = schedule.chainId != null ? getChainByChainId(schedule.chainId) : null;
  const statusTone = schedule.lastStatus ? LAST_STATUS_TONE[schedule.lastStatus] : null;
  const progressPct = schedule.maxExecutions > 0 ? Math.min(100, (schedule.executions / schedule.maxExecutions) * 100) : 0;
  const isComplete = schedule.executions >= schedule.maxExecutions;
  const isOverdue = schedule.active && !isComplete && schedule.nextFireAt * 1000 < now;
  const paidAmount = parseFloat(schedule.amountHuman) * schedule.executions;
  const totalAmount = parseFloat(schedule.amountHuman) * schedule.maxExecutions;
  const remainingAmount = totalAmount - paidAmount;

  return (
    <motion.div className="rounded-2xl overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="glass-item flex w-full items-center gap-3 p-4 text-left cursor-pointer transition-colors hover:bg-surface-2/50"
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary/20 to-primary/5 text-sm font-semibold text-primary ring-1 ring-inset ring-primary/20">
          {(schedule.recipientLabel ?? "?").charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium text-foreground">
              {schedule.recipientLabel ?? t("recurring.unknownRecipient")}
            </p>
            {schedule.active ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
                <Check className="h-3 w-3" /> {isComplete ? t("recurring.complete") : t("recurring.active")}
              </span>
            ) : isComplete ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
                <Check className="h-3 w-3" /> {t("recurring.complete")}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-muted/15 px-2 py-0.5 text-xs font-medium text-muted-2">
                <Power className="h-3 w-3" /> {t("recurring.paused")}
              </span>
            )}
            {isOverdue ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">
                <AlertCircle className="h-3 w-3" /> {t("recurring.overdue")}
              </span>
            ) : null}
            {chain ? (
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                  chain.testnet ? "bg-warning/10 text-warning" : "bg-success/10 text-success",
                )}
                title={chain.name}
              >
                {chain.shortName}
                {chain.testnet ? " · TN" : ""}
              </span>
            ) : null}
            {statusTone ? (
              <span className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium", statusTone.className)}>
                {t(statusTone.labelKey)}
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              <CalendarClock className="h-2.5 w-2.5" /> {cLabel}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <p className="truncate font-mono text-xs text-muted">{shortenAddress(schedule.recipientAddress)}</p>
          </div>
          {/* Progress bar */}
          <div className="mt-2 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2/60">
              <motion.div
                className={cn(
                  "h-full rounded-full transition-all",
                  isComplete ? "bg-success" : isOverdue ? "bg-danger" : "bg-primary",
                )}
                initial={false}
                animate={{ width: `${progressPct}%` }}
                transition={{ duration: 0.4, ease: "easeOut" }}
              />
            </div>
            <span className="text-[10px] font-mono text-muted-2 tabular-nums shrink-0">
              {schedule.executions}/{schedule.maxExecutions}
            </span>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-mono text-sm font-semibold text-foreground tabular-nums">
            {totalAmount.toFixed(2)}
          </p>
          <p className="text-xs text-muted-2">{schedule.token} {t("recurring.total")}</p>
          <p className="mt-0.5 text-[11px] text-muted-2">
            {schedule.active && !isComplete
              ? timeUntil(schedule.nextFireAt * 1000)
              : isComplete
                ? t("recurring.complete")
                : "—"}
          </p>
        </div>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted transition-transform duration-200",
            isExpanded && "rotate-180",
          )}
        />
      </button>

      <AnimatePresence initial={false}>
        {isExpanded ? (
          <motion.div
            key="details"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="border-t border-border/50 bg-surface-2/20 px-4 py-3">
              {/* Primary info grid */}
              <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                <DetailRow label={t("recurring.status")}>
                  {schedule.active ? (
                    <span className="text-success">{isComplete ? t("recurring.complete") : t("recurring.active")}</span>
                  ) : (
                    <span className="text-muted">{t("recurring.cancelled")}</span>
                  )}
                </DetailRow>
                <DetailRow label={t("recurring.cadenceLabel")}>
                  <span className="text-muted">{cLabel}</span>
                </DetailRow>
                <DetailRow label={t("recurring.cadenceSpecLabel")}>
                  <span className="font-mono text-[11px] text-muted-3">{String(schedule.cadence)}</span>
                </DetailRow>
                <DetailRow label={t("recurring.chainLabel")}>
                  {chain ? (
                    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium", chain.testnet ? "bg-warning/10 text-warning" : "bg-success/10 text-success")}>
                      {chain.name}
                      {chain.testnet ? " · TESTNET" : ""}
                    </span>
                  ) : (
                    <span className="text-warning">{t("recurring.chainUnset")}</span>
                  )}
                </DetailRow>
                {statusTone ? (
                  <DetailRow label={t("recurring.lastRunLabel")}>
                    <span className={cn("font-medium", statusTone.className)}>{t(statusTone.labelKey)}</span>
                  </DetailRow>
                ) : null}
                <DetailRow label={t("recurring.amountLabel")}>
                  <span className="font-mono text-muted">{schedule.amountHuman} {schedule.token}</span>
                </DetailRow>
                <DetailRow label={t("recurring.executionsLabel")}>
                  <span className="font-mono text-muted tabular-nums">
                    {schedule.executions} / {schedule.maxExecutions}
                  </span>
                </DetailRow>
                <DetailRow label={t("recurring.progressLabel")}>
                  <span className="font-mono text-muted tabular-nums">{progressPct.toFixed(0)}%</span>
                </DetailRow>
                <DetailRow label={t("recurring.nextPaymentLabel")}>
                  <span className={isOverdue ? "text-danger" : "text-muted"}>
                    {schedule.active && !isComplete
                      ? `${timeUntil(schedule.nextFireAt * 1000)} · ${formatFullDate(schedule.nextFireAt * 1000)}`
                      : "—"}
                  </span>
                </DetailRow>
                <DetailRow label={t("recurring.lastPaymentLabel")}>
                  <span className="text-muted">
                    {schedule.lastFireAt ? `${timeAgo(schedule.lastFireAt * 1000)} · ${formatFullDate(schedule.lastFireAt * 1000)}` : "—"}
                  </span>
                </DetailRow>
              </div>

              <div className="my-2 border-t border-border/40" />

              {/* Financial summary */}
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-lg bg-surface-2/30 px-3 py-2 text-center">
                  <p className="text-[10px] uppercase tracking-wider text-muted-2">{t("recurring.paidSoFar")}</p>
                  <p className="mt-0.5 font-mono text-sm font-semibold text-success tabular-nums">{paidAmount.toFixed(2)}</p>
                  <p className="text-[10px] text-muted-3">{schedule.token}</p>
                </div>
                <div className="rounded-lg bg-surface-2/30 px-3 py-2 text-center">
                  <p className="text-[10px] uppercase tracking-wider text-muted-2">{t("recurring.remainingLabel")}</p>
                  <p className="mt-0.5 font-mono text-sm font-semibold text-warning tabular-nums">{remainingAmount.toFixed(2)}</p>
                  <p className="text-[10px] text-muted-3">{schedule.token}</p>
                </div>
                <div className="rounded-lg bg-surface-2/30 px-3 py-2 text-center">
                  <p className="text-[10px] uppercase tracking-wider text-muted-2">{t("recurring.total")}</p>
                  <p className="mt-0.5 font-mono text-sm font-semibold text-foreground tabular-nums">{totalAmount.toFixed(2)}</p>
                  <p className="text-[10px] text-muted-3">{schedule.token}</p>
                </div>
              </div>

              <div className="my-2 border-t border-border/40" />

              {/* On-chain details */}
              <div className="flex items-center gap-1.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                <Hash className="h-3 w-3" />
                {t("recurring.scheduleId")}
              </div>
              <DetailRow label={t("recurring.scheduleId")}>
                <div className="flex items-center gap-2">
                  <CopyableValue value={schedule.scheduleIdHash} label={t("recurring.scheduleId")} />
                </div>
              </DetailRow>

              <DetailRow label={t("recurring.recipientAddr")}>
                <div className="flex items-center gap-2">
                  <CopyableValue value={schedule.recipientAddress} label={t("recurring.recipientAddr")} />
                </div>
              </DetailRow>

              {schedule.senderAddress ? (
                <DetailRow label={t("recurring.senderLabel")}>
                  <div className="flex items-center gap-2">
                    <CopyableValue value={schedule.senderAddress} label={t("recurring.senderLabel")} />
                  </div>
                </DetailRow>
              ) : null}

              <DetailRow label={t("recurring.tokenLabel")}>
                <span className="font-mono text-muted">{schedule.token}</span>
              </DetailRow>

              <DetailRow label={t("recurring.registeredAt")}>
                <span className="text-muted">{formatFullDate(schedule.createdAt)}</span>
              </DetailRow>

              {/* TODO(phase-2): show the Attestcoin Protocol attestation
                  reference for this schedule here once on-chain registration
                  is wired. */}

              {/* Actions */}
              <div className="my-2 border-t border-border/40" />
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {schedule.active && !isComplete ? (
                  <>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRunNow(schedule);
                      }}
                      disabled={runningNowId === schedule.id}
                      className="h-7 gap-1.5 text-xs"
                    >
                      {runningNowId === schedule.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Zap className="h-3 w-3" />
                      )}
                      {t("recurring.runNow")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCancel(schedule.scheduleIdHash, schedule.id);
                      }}
                      disabled={isCancelling && cancelingId === schedule.id}
                      className="h-7 gap-1.5 text-xs text-warning hover:text-warning"
                    >
                      {isCancelling && cancelingId === schedule.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Power className="h-3 w-3" />
                      )}
                      {t("recurring.pauseBtn")}
                    </Button>
                  </>
                ) : null}
                {!schedule.active && !isComplete ? (
                  <>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onResume(schedule);
                      }}
                      disabled={resumingId === schedule.id}
                      className="h-7 gap-1.5 text-xs"
                      title={t("recurring.resumeHint")}
                    >
                      {resumingId === schedule.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <PlayCircle className="h-3 w-3" />
                      )}
                      {t("recurring.resume")}
                    </Button>
                    <span className="text-[10px] text-muted-3">{t("recurring.resumeHint")}</span>
                  </>
                ) : null}
                <div className="flex-1" />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    askAgent(
                      t("recurring.askPrompt", {
                        amount: schedule.amountHuman,
                        token: schedule.token,
                        name: schedule.recipientLabel ?? shortenAddress(schedule.recipientAddress),
                        cadence: cLabel,
                      }),
                    );
                  }}
                  className="h-7 gap-1.5 border-primary/25 bg-primary/10 text-xs text-primary hover:bg-primary/20 hover:text-primary"
                  title={t("recurring.askAgent")}
                >
                  <Sparkles className="h-3 w-3" />
                  {t("recurring.askAgent")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(schedule.id);
                  }}
                  disabled={deletingId === schedule.id}
                  className="h-7 gap-1.5 text-xs text-danger hover:text-danger"
                >
                  {deletingId === schedule.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Trash2 className="h-3 w-3" />
                  )}
                  {t("recurring.delete")}
                </Button>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
});

interface RecurringScheduleDbType {
  id: string;
  recipientLabel: string | null;
  recipientAddress: string;
  token: string;
  tokenAddress: string | null;
  amountHuman: string;
  amountBaseUnits: string;
  cadence: string;
  chainId: number | null;
  nextFireAt: number;
  lastFireAt: number | null;
  executions: number;
  maxExecutions: number;
  active: boolean;
  lastStatus: string | null;
  scheduleIdHash: string;
  senderAddress: string | null;
  createdAt: number;
  userId: string | null;
}

export function RecurringView() {
  const { t } = useI18n();
  const { data: schedules, isLoading, isFetching, refetch } = useRecurringSchedules();
  const { register, cancel, isRegistering, isCancelling, canRegister } = useRecurringSchedule();
  const deleteRecurring = useDeleteRecurring();
  // R14 (example intents): quick-start contact chips for the zero-schedules
  // empty state — favorites first, then most recently used, capped at 2
  // (mirrors the payments page's quickContacts priority exactly).
  const askAgent = useAskAgent();
  const { data: contactsData } = useContacts();
  const quickContacts = useMemo(() => {
    const list = contactsData ?? [];
    return [...list]
      .sort((a, b) => {
        if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
        return b.lastUsed - a.lastUsed;
      })
      .slice(0, 2);
  }, [contactsData]);

  // ── Run-now plumbing (fires the schedule, then dispatches the transfer
  // through the agent loop — same gates as a chat send). ──
  const { address, isConnected } = useAccount();
  const { data: nativeBalance } = useBalance({ address });
  // Run-now holdings context uses the WALLET's active chain (what the user
  // holds RIGHT NOW); the form's chain-scoped list is separate (N12).
  const walletTokenBalances = useTokenBalances();
  const agentRun = useAgentRun();
  const { config, configured } = useAiProvider();
  const fireRecurring = useFireRecurring();
  const updateRecurring = useUpdateRecurring();

  const [showCreate, setShowCreate] = useState(false);
  const [recipientAddress, setRecipientAddress] = useState("");
  const [recipientLabel, setRecipientLabel] = useState("");
  const [amountHuman, setAmountHuman] = useState("");
  // N12: the payment token — "native" or a discovered ERC-20's address.
  const [tokenKey, setTokenKey] = useState<string>("native");
  // C37 cadence selection: a preset chip OR the custom (unit, n) pair.
  const [cadenceMode, setCadenceMode] = useState<"preset" | "custom">("preset");
  const [cadencePreset, setCadencePreset] = useState<CadencePreset>("monthly");
  const [customUnit, setCustomUnit] = useState<CadenceUnit>("days");
  const [customN, setCustomN] = useState(10);
  const [chainId, setChainId] = useState<number>(11155111);
  const [startDate, setStartDate] = useState(() => {
    // Local calendar date one week out (toISOString would drift a day in
    // non-UTC timezones near midnight).
    const d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  });
  const [maxExecutions, setMaxExecutions] = useState(12);
  const [formError, setFormError] = useState<string | null>(null);
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [runningNowId, setRunningNowId] = useState<string | null>(null);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Live clock so "overdue / next in …" states refresh without a manual refetch.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(iv);
  }, []);

  // ── N12: the selectable payment tokens for the FORM's chain ────────────────
  // Native + every live ERC-20 the wallet actually holds there (real
  // discovery; empty when disconnected — the native option always exists).
  const formTokenBalances = useTokenBalances({ chainId });
  const formChain = getChainByChainId(chainId);
  const tokenOptions = useMemo(() => {
    const opts: Array<{ key: string; symbol: string; name: string; decimals: number; address: string | null; balanceHuman: string | null }> = [
      {
        key: "native",
        symbol: formChain?.nativeCurrency.symbol ?? "ETH",
        name: formChain?.nativeCurrency.name ?? "Ether",
        decimals: formChain?.nativeCurrency.decimals ?? 18,
        address: null,
        balanceHuman: null,
      },
    ];
    for (const tk of formTokenBalances.data ?? []) {
      if (!tk.symbol || tk.balance === "0") continue;
      opts.push({
        key: tk.address.toLowerCase(),
        symbol: tk.symbol,
        name: tk.name,
        decimals: tk.decimals,
        address: tk.address,
        balanceHuman: tk.balanceHuman ?? null,
      });
    }
    return opts;
  }, [formTokenBalances.data, formChain]);

  // Reset the token selection to native whenever the chain changes (keys are
  // chain-scoped addresses). Render-phase reset (the official React pattern
  // for deriving state from props — no effect, no cascading render).
  const [prevChainId, setPrevChainId] = useState(chainId);
  if (prevChainId !== chainId) {
    setPrevChainId(chainId);
    setTokenKey("native");
  }

  const selectedToken = tokenOptions.find((o) => o.key === tokenKey) ?? tokenOptions[0];

  const rows = useMemo<RecurringScheduleDbType[]>(() => schedules ?? [], [schedules]);
  const activeRows = useMemo(() => rows.filter((s) => s.active), [rows]);

  const stats = useMemo(() => {
    const activeCount = activeRows.length;
    const totalScheduled = activeRows.reduce((sum, s) => {
      const n = parseFloat(s.amountHuman);
      return Number.isFinite(n) ? sum + n * s.maxExecutions : sum;
    }, 0);
    const nextFire = activeRows.length > 0
      ? Math.min(...activeRows.map((s) => s.nextFireAt))
      : null;
    const completedExecutions = rows.reduce((sum, s) => sum + s.executions, 0);
    const totalPaid = rows.reduce((sum, s) => {
      const n = parseFloat(s.amountHuman);
      return Number.isFinite(n) ? sum + n * s.executions : sum;
    }, 0);
    return { activeCount, totalScheduled, nextFire, completedExecutions, totalPaid };
  }, [rows, activeRows]);

  const handleRegister = useCallback(async () => {
    setFormError(null);
    if (!recipientAddress || recipientAddress.length !== 42) {
      setFormError(t("recurring.recipient"));
      return;
    }
    const amount = parseFloat(amountHuman);
    if (!Number.isFinite(amount) || amount <= 0) {
      setFormError(t("recurring.amount"));
      return;
    }
    // C37 cadence validation — honest bounds, not a silent clamp.
    let cadenceArg: CadencePreset | { unit: CadenceUnit; n: number };
    if (cadenceMode === "preset") {
      cadenceArg = cadencePreset;
    } else {
      const v = validateCustomCadence(customUnit, customN);
      if (!v.ok) {
        const range =
          customUnit === "seconds"
            ? t("recurring.customRangeSeconds")
            : customUnit === "minutes"
              ? t("recurring.customRangeMinutes")
              : customUnit === "hours"
                ? t("recurring.customRangeHours")
                : t("recurring.customRangeDays");
        setFormError(t("recurring.customRange", { range }));
        return;
      }
      cadenceArg = { unit: customUnit, n: v.n };
    }
    // Parse the date input in the USER'S timezone, not UTC: `new Date("YYYY-MM-DD")`
    // reads the calendar day as UTC midnight, which can judge a locally-future
    // date as past (a UTC-N user picking "tomorrow" in their evening).
    const [y, mo, d] = startDate.split("-").map(Number);
    const firstFireAt = Math.floor(new Date(y, (mo ?? 1) - 1, d ?? 1, 0, 0, 0, 0).getTime() / 1000);
    if (!firstFireAt || firstFireAt < Math.floor(Date.now() / 1000)) {
      setFormError(t("recurring.startDate"));
      return;
    }
    if (maxExecutions < 1 || maxExecutions > 365) {
      setFormError(t("recurring.maxExecutions"));
      return;
    }

    // N12: base units at the SELECTED token's decimals (was hardcoded 1e6 =
    // USDC-only). The token comes from the user's real holdings list.
    const tokenDecimals = selectedToken.decimals;
    const scaled = BigInt(Math.floor(amount * 10 ** tokenDecimals));

    const result = await register({
      recipientAddress,
      tokenAddress: selectedToken.address ?? "",
      amountBaseUnits: scaled.toString(),
      amountHuman: amount.toFixed(Math.min(tokenDecimals, 18)),
      cadence: cadenceArg,
      chainId,
      firstFireAt,
      maxExecutions,
      recipientLabel: recipientLabel || null,
      token: selectedToken.symbol,
    });

    if (result.status === "registered") {
      setShowCreate(false);
      setRecipientAddress("");
      setRecipientLabel("");
      setAmountHuman("");
      refetch();
    } else if (result.status === "failed") {
      setFormError(result.error);
    } else if (result.status === "declined") {
      // Localize the hook's machine reasons (no-wallet) instead of leaking them raw.
      setFormError(result.reason === "no-wallet" ? t("recurring.walletSwitch") : result.reason);
    }
  }, [recipientAddress, recipientLabel, amountHuman, cadenceMode, cadencePreset, customUnit, customN, chainId, startDate, maxExecutions, selectedToken, register, refetch, t]);

  const handleCancel = useCallback(
    async (scheduleIdHash: string, dbId: string) => {
      setCancelingId(dbId);
      const result = await cancel(scheduleIdHash, dbId);
      setCancelingId(null);
      if (result.status === "cancelled") {
        refetch();
      }
    },
    [cancel, refetch],
  );

  // Resume: reactivate + a FRESH next slot (now + one interval). A schedule
  // the user deliberately paused must not burn a catch-up payment on resume
  // — catch-up is for "missed while the app was closed", not "paused".
  const handleResume = useCallback(
    async (schedule: RecurringScheduleDbType) => {
      setResumingId(schedule.id);
      try {
        const intervalSec = Math.floor(cadenceIntervalMs(schedule.cadence) / 1000);
        await updateRecurring.mutateAsync({
          id: schedule.id,
          active: true,
          nextFireAt: Math.floor(Date.now() / 1000) + intervalSec,
          lastStatus: null,
        });
        refetch();
      } finally {
        setResumingId(null);
      }
    },
    [updateRecurring, refetch],
  );

  const handleDelete = useCallback(
    async (dbId: string) => {
      if (!confirm(t("recurring.deleteConfirm"))) return;
      setDeletingId(dbId);
      try {
        await deleteRecurring.mutateAsync(dbId);
        if (expandedId === dbId) setExpandedId(null);
      } catch {
        // non-critical
      }
      setDeletingId(null);
    },
    [deleteRecurring, t, expandedId],
  );

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  // ── Run now: fire the schedule (server-side latch + catch-up advance),
  // then dispatch the transfer through the agent loop — the wallet
  // confirmation gates apply exactly like a chat send. A busy-run race
  // requeues the pre-fire state (nothing is double-burned). ──
  const handleRunNow = useCallback(
    async (schedule: RecurringScheduleDbType) => {
      if (runningNowId) return;
      if (!isConnected) {
        alert(t("recurring.runNowWalletRequired"));
        return;
      }
      if (!configured) {
        alert(t("recurring.runNowProviderRequired"));
        return;
      }
      if (activeSessionBusy()) {
        alert(t("recurring.runNowBusy"));
        return;
      }
      setRunningNowId(schedule.id);
      try {
        const fired = await fireRecurring.mutateAsync(schedule.id);
        if (!fired || fired.skipped || !fired.schedule || !fired.previous) return; // dedup / inactive / complete

        const chainName = chainDisplayName(schedule.chainId);
        const label = schedule.recipientLabel ? ` "${schedule.recipientLabel}"` : "";
        const userText = `Recurring payment${label} due (manual run): transfer ${schedule.amountHuman} ${schedule.token} to ${schedule.recipientAddress} on ${chainName}.`;

        const result = await dispatchAgentUserMessage({
          run: agentRun.run,
          providerConfig: config,
          wallet: isConnected
            ? {
                address: address ?? null,
                chainId: null,
                holdings: (() => {
                  const h: Record<string, { address: string | null; balance: string }> = {};
                  if (nativeBalance?.value) {
                    const nativeSym = nativeBalance.symbol ?? "ETH";
                    h[nativeSym] = { address: null, balance: nativeBalance.value.toString() };
                  }
                  if (walletTokenBalances.data) {
                    for (const tk of walletTokenBalances.data) {
                      h[tk.symbol] = { address: tk.address, balance: tk.balance };
                    }
                  }
                  return Object.keys(h).length > 0 ? h : null;
                })(),
              }
            : null,
          userText,
        });

        if (result.errorCode === "busy") {
          await updateRecurring.mutateAsync({
            id: schedule.id,
            requeue: true,
            ...fired.previous,
          });
        } else if (result.error) {
          await updateRecurring.mutateAsync({ id: schedule.id, lastStatus: "failed" }).catch(() => undefined);
        } else {
          await updateRecurring.mutateAsync({ id: schedule.id, lastStatus: "dispatched" }).catch(() => undefined);
        }
      } finally {
        setRunningNowId(null);
      }
    },
    [
      runningNowId,
      isConnected,
      configured,
      fireRecurring,
      agentRun.run,
      config,
      address,
      nativeBalance,
      walletTokenBalances.data,
      updateRecurring,
      t,
    ],
  );

  return (
    <PageContainer
      title={t("recurring.title")}
      description={t("recurring.desc")}
      icon={<CalendarClock className="h-5 w-5" />}
      action={
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
            {t("recurring.refresh")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => setShowCreate((v) => !v)}
            disabled={!canRegister}
          >
            {showCreate ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            {showCreate ? t("recurring.cancelBtn") : t("recurring.newSchedule")}
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label={t("recurring.activeSchedules")}
          value={`${stats.activeCount}`}
          sublabel={t("recurring.cancelledCount", { count: rows.length - stats.activeCount })}
          icon={<CalendarClock className="h-4 w-4" />}
        />
        <StatCard
          label={t("recurring.totalScheduled")}
          value={`${stats.totalScheduled.toFixed(2)}`}
          sublabel={t("recurring.usdcAcross")}
          icon={<ShieldCheck className="h-4 w-4" />}
        />
        <StatCard
          label={t("recurring.nextFireStat")}
          value={stats.nextFire ? timeUntil(stats.nextFire * 1000) : "—"}
          sublabel={stats.nextFire ? formatFullDate(stats.nextFire * 1000) : t("recurring.noActiveSchedules")}
          icon={<Clock className="h-4 w-4" />}
        />
        <StatCard
          label={t("recurring.totalPaid")}
          value={`${stats.totalPaid.toFixed(2)}`}
          sublabel={`${stats.completedExecutions} ${t("recurring.completedPayments")}`}
          icon={<Check className="h-4 w-4" />}
        />
      </div>

      <AnimatePresence>
        {showCreate ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <Card>
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-foreground">{t("recurring.createTitle")}</h3>
                <p className="text-[11px] text-muted-2 leading-relaxed">
                  {t("recurring.createDesc")}
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-2 mb-1 block">{t("recurring.recipient")}</label>
                    <input
                      type="text"
                      value={recipientAddress}
                      onChange={(e) => setRecipientAddress(e.target.value)}
                      placeholder="0x..."
                      spellCheck={false}
                      autoComplete="off"
                      className="neumorphic-field w-full font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-2 mb-1 block">{t("recurring.recipientLabel")}</label>
                    <input
                      type="text"
                      value={recipientLabel}
                      onChange={(e) => setRecipientLabel(e.target.value)}
                      placeholder={t("recurring.recipientLabelPlaceholder")}
                      className="neumorphic-field w-full"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-2 mb-1 block">
                      {/* P17.4: the amount label follows the ACTUALLY selected token —
                          never a hardcoded "USDC" (the token picker below changes it). */}
                      {t("recurring.amountWithToken", { token: selectedToken?.symbol ?? "…" })}
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="number"
                        step="0.000001"
                        value={amountHuman}
                        onChange={(e) => setAmountHuman(e.target.value)}
                        placeholder="100.00"
                        className="neumorphic-field w-full font-mono tabular-nums"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-2 mb-1 block">{t("recurring.tokenLabel")}</label>
                    <select
                      value={tokenKey}
                      onChange={(e) => setTokenKey(e.target.value)}
                      className="w-full rounded-lg bg-surface-2/50 border border-border/50 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                      aria-label={t("recurring.tokenLabel")}
                    >
                      {tokenOptions.map((o) => (
                        <option key={o.key} value={o.key}>
                          {o.symbol}
                          {o.balanceHuman ? ` · ${o.balanceHuman}` : ""}
                          {o.address ? " · ERC-20" : ""}
                        </option>
                      ))}
                    </select>
                    <span className="text-[10px] text-muted-3 mt-1 block">{t("recurring.tokenHint")}</span>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-2 mb-1 block">{t("recurring.chainLabel")}</label>
                    <select
                      value={chainId}
                      onChange={(e) => setChainId(Number(e.target.value))}
                      className="w-full rounded-lg bg-surface-2/50 border border-border/50 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      {CHAIN_REGISTRY.map((c) => (
                        <option key={c.chainId} value={c.chainId}>
                          {c.name}
                          {c.testnet ? " · TESTNET" : ""}
                        </option>
                      ))}
                    </select>
                    <span className="text-[10px] text-muted-3 mt-1 block">{t("recurring.chainHint")}</span>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="text-xs font-medium text-muted-2 mb-1.5 block">{t("recurring.cadence")}</label>
                    <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={t("recurring.cadence")}>
                      {PRESET_ORDER.map((preset) => {
                        const active = cadenceMode === "preset" && cadencePreset === preset;
                        return (
                          <button
                            key={preset}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            onClick={() => {
                              setCadenceMode("preset");
                              setCadencePreset(preset);
                            }}
                            className={cn(
                              "rounded-full px-3 py-1.5 text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
                              active
                                ? "bg-primary/15 text-primary ring-1 ring-inset ring-primary/30 shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
                                : "neumorphic-inset text-muted hover:text-foreground",
                            )}
                          >
                            {t(PRESET_LABEL_KEYS[preset])}
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        role="radio"
                        aria-checked={cadenceMode === "custom"}
                        onClick={() => setCadenceMode("custom")}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
                          cadenceMode === "custom"
                            ? "bg-primary/15 text-primary ring-1 ring-inset ring-primary/30"
                            : "neumorphic-inset text-muted hover:text-foreground",
                        )}
                      >
                        <Wand2 className="h-3 w-3" />
                        {t("recurring.custom")}
                      </button>
                    </div>

                    {cadenceMode === "custom" ? (
                      <motion.div
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.15 }}
                        className="mt-2 flex flex-wrap items-center gap-2"
                      >
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            min={cadenceUnitBounds(customUnit).min}
                            max={cadenceUnitBounds(customUnit).max}
                            step={1}
                            value={customN}
                            onChange={(e) => setCustomN(Number(e.target.value))}
                            aria-label={t("recurring.customInterval")}
                            className="neumorphic-field w-20 font-mono tabular-nums"
                          />
                          <div className="flex rounded-lg bg-surface-2/50 border border-border/50 p-0.5" role="group" aria-label={t("recurring.customUnit")}>
                            {CADENCE_UNITS.map((unit) => (
                              <button
                                key={unit}
                                type="button"
                                aria-pressed={customUnit === unit}
                                onClick={() => {
                                  setCustomUnit(unit);
                                  setCustomN((prev) => clampCustom(unit, prev).n);
                                }}
                                className={cn(
                                  "rounded-md px-2 py-1 text-xs font-medium transition-colors",
                                  customUnit === unit ? "bg-primary/15 text-primary" : "text-muted-2 hover:text-foreground",
                                )}
                              >
                                {t(`recurring.unit${unit.charAt(0).toUpperCase()}${unit.slice(1)}` as never)}
                              </button>
                            ))}
                          </div>
                        </div>
                        <span className="text-[10px] text-muted-3">
                          {t(
                            (customUnit === "seconds"
                              ? "recurring.customRangeSeconds"
                              : customUnit === "minutes"
                                ? "recurring.customRangeMinutes"
                                : customUnit === "hours"
                                  ? "recurring.customRangeHours"
                                  : "recurring.customRangeDays") as never,
                          )}
                        </span>
                      </motion.div>
                    ) : null}

                    <p className="text-[10px] text-muted-3 mt-1.5">
                      {t("recurring.cadencePreview", {
                        label: cadenceSelectionLabel(
                          cadenceMode === "preset"
                            ? { mode: "preset", preset: cadencePreset }
                            : { mode: "custom", unit: customUnit, n: clampCustom(customUnit, customN).n },
                          t,
                        ),
                      })}
                    </p>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-2 mb-1 block">{t("recurring.startDate")}</label>
                    <input
                      type="date"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                      className="neumorphic-field w-full"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-2 mb-1 block">{t("recurring.maxExecutions")}</label>
                    <input
                      type="number"
                      min="1"
                      max="365"
                      value={maxExecutions}
                      onChange={(e) => setMaxExecutions(Number(e.target.value))}
                      className="neumorphic-field w-full font-mono tabular-nums"
                    />
                  </div>
                </div>

                {formError ? (
                  <div className="flex items-center gap-2 text-xs text-danger">
                    <AlertCircle className="h-3.5 w-3.5" />
                    {formError}
                  </div>
                ) : null}

                <div className="flex items-center gap-2 pt-1">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleRegister}
                    disabled={isRegistering || !canRegister}
                  >
                    {isRegistering ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Plus className="h-3.5 w-3.5" />
                    )}
                    {isRegistering ? t("recurring.registering") : t("recurring.register")}
                  </Button>
                  <span className="text-[10px] text-muted-3">
                    {t("recurring.walletSwitch")}
                  </span>
                </div>
              </div>
            </Card>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {isLoading ? (
        <Card>
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("recurring.loading")}
          </div>
        </Card>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<CalendarClock className="h-6 w-6" />}
          title={t("recurring.noSchedules")}
          description={t("recurring.noSchedulesDesc")}
          action={
            <div className="flex flex-col items-center gap-3">
              {canRegister ? (
                <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
                  <Plus className="h-3.5 w-3.5" />
                  {t("recurring.newSchedule")}
                </Button>
              ) : null}
              {/* R14 (example intents): one tap composes a real, answerable
                  agent prompt (create_recurring_schedule) — the empty state
                  becomes a starting point instead of a dead end. Chips pair
                  the quick contacts with alternating weekly/monthly cadences
                  so the two never read as duplicates. */}
              {quickContacts.length > 0 ? (
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {quickContacts.map((c, i) => {
                    const monthly = i % 2 === 1;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() =>
                          askAgent(
                            t("recurring.examplePrompt", {
                              amount: "10",
                              token: "USDC",
                              name: c.label,
                              address: c.address,
                              cadence: monthly ? t("recurring.everyMonth") : t("recurring.everyWeek"),
                            }),
                          )
                        }
                        className="glass-item flex min-h-9 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-muted transition-all duration-200 hover:border-primary/40 hover:bg-primary/10 hover:text-primary cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                        title={t("contacts.sendTo", { name: c.label })}
                      >
                        <CalendarClock className="h-3 w-3" aria-hidden />
                        <span className="max-w-[120px] truncate">
                          {monthly ? t("recurring.monthly") : t("recurring.weekly")} · {c.label}
                        </span>
                        {c.favorite ? <Star className="h-3 w-3 shrink-0 text-warning" aria-hidden /> : null}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <Link
                  href="/contacts"
                  className="glass-item flex min-h-9 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-muted transition-all duration-200 hover:border-primary/40 hover:bg-primary/10 hover:text-primary"
                >
                  <UserPlus className="h-3 w-3" aria-hidden />
                  {t("payments.emptyAddContactChip")}
                </Link>
              )}
            </div>
          }
        />
      ) : (
        <div className="space-y-2">
          {rows.map((s) => (
            <ScheduleRow
              key={s.id}
              schedule={s}
              isExpanded={expandedId === s.id}
              onToggle={() => handleToggleExpand(s.id)}
              onCancel={handleCancel}
              isCancelling={isCancelling}
              cancelingId={cancelingId}
              onDelete={handleDelete}
              deletingId={deletingId}
              onRunNow={handleRunNow}
              runningNowId={runningNowId}
              onResume={handleResume}
              resumingId={resumingId}
              now={now}
            />
          ))}
        </div>
      )}

      <div className="flex justify-center pt-2">
        <Link href="/">
          <Button variant="ghost" size="sm">
            {t("payments.newViaChat")}
          </Button>
        </Link>
      </div>
    </PageContainer>
  );
}
