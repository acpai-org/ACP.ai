"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Activity,
  ArrowLeftRight,
  ArrowUpRight,
  Braces,
  CalendarClock,
  CalendarX,
  Check,
  ChevronDown,
  CircleDashed,
  Cog,
  Coins,
  Copy,
  ExternalLink,
  FileCog,
  FileSearch,
  Fuel,
  Hexagon,
  Layers,
  List,
  Loader2,
  Lock,
  LockOpen,
  Network,
  Radar,
  Scale,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Timer,
  UserPlus,
  Users,
  Wallet,
  X,
  XCircle,
  Clock,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { getChainByChainId } from "@/lib/chains/registry";
import type { TraceStep, TraceStepStatus } from "@/lib/agent/events";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// AgentTrace — the LIVE execution trace (brief §2/§9): every tool call the
// agent makes, streaming its status in real time — pending → running →
// (awaiting signature | confirmation | attestation) → succeeded/failed.
// Not a log dump: a considered timeline with per-step detail, live elapsed
// timers, an indeterminate progress bar on in-flight steps, explorer links,
// proof references (Merkle root, blocks) and a run summary footer (steps,
// durations, tx count, finish reason).
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<TraceStepStatus, { icon: typeof CircleDashed; className: string; spin?: boolean }> = {
  pending: { icon: CircleDashed, className: "text-foreground/30" },
  running: { icon: Loader2, className: "text-primary", spin: true },
  awaiting_signature: { icon: Wallet, className: "text-warning", spin: true },
  awaiting_confirmation: { icon: ShieldAlert, className: "text-warning" },
  awaiting_user: { icon: ShieldAlert, className: "text-warning" },
  waiting_attestation: { icon: Hexagon, className: "text-primary", spin: true },
  broadcast: { icon: ArrowUpRight, className: "text-primary", spin: true },
  confirming: { icon: Hexagon, className: "text-success", spin: true },
  succeeded: { icon: Check, className: "text-success" },
  failed: { icon: X, className: "text-danger" },
  skipped: { icon: CircleDashed, className: "text-foreground/25" },
  declined: { icon: X, className: "text-foreground/30" },
  interrupted: { icon: X, className: "text-warning" },
};

const IN_FLIGHT: TraceStepStatus[] = [
  "running",
  "awaiting_signature",
  "awaiting_confirmation",
  "awaiting_user",
  "waiting_attestation",
  "broadcast",
  "confirming",
];

const FINISHED: TraceStepStatus[] = ["succeeded", "failed", "declined", "interrupted"];

// ── P22 design pass ─────────────────────────────────────────────────────
// Every tool gets its OWN symbol — the row's glyph answers "what is this
// step doing?" at a glance (a lock for escrow, arrows for a swap, a calendar
// for a schedule…). State stays on the existing channels: color, the pulse
// ring + shimmer bar (in flight), and a small corner badge (terminal states).
// Unmapped tools fall back to the status icon shape.
const TOOL_ICONS: Record<string, LucideIcon> = {
  get_balances: Scale,
  get_transaction_status: Search,
  check_attestation_status: FileSearch,
  wait_for_attestation: Timer,
  attestcoin_network_status: Radar,
  list_contacts: Users,
  list_chains: Network,
  list_recent_actions: List,
  transfer: Send,
  batch_transfer: Layers,
  deploy_contract: FileCog,
  create_conditional_release: Lock,
  execute_conditional_release: LockOpen,
  cross_chain_swap: ArrowLeftRight,
  create_automation_rule: Cog,
  update_automation_rule: SlidersHorizontal,
  delete_automation_rule: XCircle,
  list_automation_rules: List,
  get_app_status: Activity,
  create_recurring_payment: CalendarClock,
  create_contact: UserPlus,
  list_recurring_payments: List,
  cancel_recurring_payment: CalendarX,
  decode_source_transaction: Braces,
  verify_proof_readonly: ShieldCheck,
  estimate_verification_cost: Coins,
  get_attestation_bounds: Hexagon,
  submit_proof_onchain: Zap,
};

/** Terminal-state corner badge: a tiny solid chip (check / x) so a finished
 * row is readable from the glyph alone — the symbol keeps its identity. */
const TERMINAL_BADGE: Partial<Record<TraceStepStatus, { icon: LucideIcon; className: string }>> = {
  succeeded: { icon: Check, className: "text-success" },
  failed: { icon: X, className: "text-danger" },
  declined: { icon: X, className: "text-muted-2" },
  interrupted: { icon: X, className: "text-warning" },
};

const TOOL_LABEL_KEYS: Record<string, string> = {
  get_balances: "trace.toolBalances",
  get_transaction_status: "trace.toolTxStatus",
  check_attestation_status: "trace.toolCheckAttestation",
  wait_for_attestation: "trace.toolWaitAttestation",
  attestcoin_network_status: "trace.toolAttestcoinStatus",
  list_contacts: "trace.toolContacts",
  list_chains: "trace.toolChains",
  list_recent_actions: "trace.toolActions",
  transfer: "trace.toolTransfer",
  batch_transfer: "trace.toolBatch",
  deploy_contract: "trace.toolDeploy",
  create_conditional_release: "trace.toolEscrow",
  execute_conditional_release: "trace.toolRelease",
  cross_chain_swap: "trace.toolSwap",
  create_recurring_payment: "trace.toolRecurring",
  get_app_status: "trace.toolAppStatus",
  // N24: app-control tools
  create_contact: "trace.toolCreateContact",
  list_recurring_payments: "trace.toolListRecurring",
  cancel_recurring_payment: "trace.toolCancelRecurring",
  recurring_payment: "trace.toolRecurring",
  automation_rule: "trace.toolAutomation",
  // P26 fix: the four automation CRUD tools had no label keys — the trace
  // fell back to English-only traceTitle. Now localized like every peer
  // (reusing the P24 actions-log keys where they already exist).
  create_automation_rule: "trace.toolNewAutomation",
  update_automation_rule: "trace.toolEditAutomation",
  delete_automation_rule: "trace.toolDeleteAutomation",
  list_automation_rules: "trace.toolListAutomation",
  // N32 protocol tools
  decode_source_transaction: "trace.toolDecodeTx",
  verify_proof_readonly: "trace.toolVerifyProof",
  estimate_verification_cost: "trace.toolCostEstimate",
  get_attestation_bounds: "trace.toolBounds",
  submit_proof_onchain: "trace.toolSubmitProof",
};

function shortHash(h: string | undefined): string {
  return h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "";
}

// ─────────────────────────────────────────────────────────────────────────────
// N25 — Parameters panel: the validated tool arguments, humanized. Key/value
// rows for the known arg shapes (amounts, recipients, chains, cadences…),
// copy affordances on everything hash-like (Android: title attrs don't exist
// on touch — a copy button is the real affordance), and a collapsed <details>
// with pretty JSON for unknown/complex values. Raw JSON is never the primary
// presentation of a known argument.
// ─────────────────────────────────────────────────────────────────────────────

/** Known arg keys → i18n label (names match the registry zod schemas exactly). */
const ARG_LABEL_KEYS: Record<string, string> = {
  amount: "trace.paramAmount",
  lockAmount: "trace.paramAmount",
  rateTctcPerEth: "trace.paramRate",
  recipient: "trace.paramRecipient",
  destinationAddress: "trace.paramRecipient",
  sourceAddress: "trace.paramAddress",
  beneficiary: "trace.paramBeneficiary",
  address: "trace.paramAddress",
  contractAddress: "trace.paramAddress",
  chain: "trace.paramChain",
  sourceChain: "trace.paramChain",
  token: "trace.paramToken",
  cadence: "trace.paramCadence",
  scheduleId: "trace.paramSchedule",
  label: "trace.paramLabel",
  sourceName: "trace.paramLabel",
  note: "trace.paramNote",
  memo: "trace.paramMemo",
  conditionDescription: "trace.paramCondition",
  txHash: "trace.paramTx",
  sourceTxHash: "trace.paramTx",
  mode: "trace.paramMode",
  template: "trace.paramTemplate",
  maxWaitSeconds: "trace.paramMaxWait",
  timeoutHours: "trace.paramTimeout",
  intervalHours: "trace.paramInterval",
  maxExecutions: "trace.paramExecutions",
  limit: "trace.paramLimit",
  includeInactive: "trace.paramIncludeInactive",
  transfers: "trace.paramTransfers",
  constructorArgs: "trace.paramConstructor",
  source: "trace.paramSource",
};

/** Arg values that are identifiers (addresses, tx hashes, schedule ids). */
const HASH_ARG_KEYS = new Set([
  "recipient",
  "destinationAddress",
  "sourceAddress",
  "beneficiary",
  "address",
  "contractAddress",
  "txHash",
  "sourceTxHash",
  "scheduleId",
]);

const CADENCE_KEYS = new Set(["daily", "weekly", "biweekly", "monthly"]);
const NUMERIC_STRING = /^\d+(?:\.\d+)?$/;

function isEvmHash(s: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(s) || /^0x[a-fA-F0-9]{64}$/.test(s);
}

/** Fallback label for an arg key the map doesn't know: "rateTctcPerEth" → "Rate tctc per eth". */
function humanArgKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** "600" → "10m" — bounded wait seconds, the natural unit. */
function fmtSeconds(s: number): string {
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
}

/** "72" → "3d", "6" → "6h" — hour durations (D12: hour soup is meaningless). */
function fmtHours(h: number): string {
  return h < 48 ? `${h}h` : `${Math.round((h / 24) * 10) / 10}d`;
}

/** Arg entries worth showing: null/undefined/empty are hidden — except a
 * null chain on get_balances, where null MEANS "all chains" (not absence). */
function visibleArgEntries(tool: string, args: Record<string, unknown> | undefined): Array<[string, unknown]> {
  if (!args) return [];
  return Object.entries(args).filter(([k, v]) => {
    if (v == null) return k === "chain" && tool === "get_balances";
    if (typeof v === "string" && v.trim() === "") return false;
    return true;
  });
}

/** "1m 04s" / "42s" / "0.8s" — elapsed formatter for step timers. */
function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

/** A ticking "now" for live timers — one interval for the whole trace. */
function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const iv = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(iv);
  }, [active, intervalMs]);
  return now;
}

export interface AgentTraceFooter {
  /** Finish reason of the run (stop/error/interrupted/max_rounds); null while streaming. */
  finishReason: "stop" | "error" | "interrupted" | "max_rounds" | "invalid_loop" | null;
}

export function AgentTrace({ steps, footer }: { steps: TraceStep[]; footer?: AgentTraceFooter }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const anyInFlight = steps.some((s) => IN_FLIGHT.includes(s.status));
  const now = useNow(anyInFlight);

  if (steps.length === 0) return null;

  const runStats = {
    total: steps.length,
    succeeded: steps.filter((s) => s.status === "succeeded").length,
    failed: steps.filter((s) => s.status === "failed").length,
    declined: steps.filter((s) => s.status === "declined").length,
    txCount: steps.filter((s) => s.detail?.txHash ?? s.result?.txHash).length,
    firstStart: steps.reduce((min, s) => Math.min(min, s.startedAt ?? Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER),
    lastEnd: steps.reduce((max, s) => Math.max(max, s.finishedAt ?? now), 0),
  };
  const hasRunTimes = runStats.firstStart !== Number.MAX_SAFE_INTEGER;
  const runDurationMs = hasRunTimes ? Math.max(0, (footer?.finishReason ? runStats.lastEnd : now) - runStats.firstStart) : 0;

  return (
    <div className="mt-3 flex flex-col gap-1.5" role="list" aria-label={t("trace.title")}>
      {steps.map((step, i) => {
        const cfg = STATUS_CONFIG[step.status] ?? STATUS_CONFIG.pending;
        const Icon = cfg.icon;
        // P22: the tool's own symbol when mapped — identity over state shape.
        const Glyph = TOOL_ICONS[step.tool] ?? Icon;
        const badge = TERMINAL_BADGE[step.status];
        const labelKey = TOOL_LABEL_KEYS[step.tool];
        const label = labelKey ? t(labelKey as never) : step.title ?? step.tool;
        const inFlight = IN_FLIGHT.includes(step.status);
        const stepElapsed = (() => {
          const start = step.startedAt;
          if (start == null) return null;
          const end = FINISHED.includes(step.status) ? (step.finishedAt ?? now) : now;
          return end - start;
        })();
        const hasDetail = Boolean(
          step.detail?.text ||
            step.result?.summary ||
            step.detail?.txHash ||
            step.detail?.merkleRoot ||
            step.result?.txHash ||
            (step.detail?.data as { feeEstimate?: { gasUnits: string } } | undefined)?.feeEstimate ||
            visibleArgEntries(step.tool, step.args).length > 0,
        );
        const isOpen = expanded[step.stepId] ?? false;

        return (
          <motion.div
            key={step.stepId}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i * 0.05, 0.3), duration: 0.25 }}
            className={cn(
              "relative overflow-hidden rounded-xl border px-3 py-2 transition-colors",
              step.status === "failed"
                ? "border-danger/25 bg-danger/5"
                : step.status === "succeeded"
                  ? "border-success/20 bg-success/5"
                  : step.status === "awaiting_confirmation" || step.status === "awaiting_user"
                    ? "border-warning/25 bg-warning/5"
                    : "border-foreground/10 bg-foreground/[0.03]",
            )}
            role="listitem"
          >
            {/* Indeterminate progress bar for in-flight steps (queue #5). */}
            {inFlight ? (
              <span className="trace-progress-bar" aria-hidden>
                <span className="trace-progress-bar-fill" />
              </span>
            ) : null}

            <button
              type="button"
              onClick={() => setExpanded((e) => ({ ...e, [step.stepId]: !e[step.stepId] }))}
              disabled={!hasDetail}
              className="flex min-h-11 w-full items-center gap-2.5 text-left disabled:cursor-default"
              aria-expanded={hasDetail ? isOpen : undefined}
            >
              <span className={cn("relative flex h-5 w-5 shrink-0 items-center justify-center", cfg.className)}>
                {inFlight ? <span className="trace-pulse-ring" aria-hidden /> : null}
                {/* Spin ONLY the fallback status glyphs (Loader2-class shapes
                    are spin-safe; semantic glyphs like Lock/Send spin badly —
                    their in-flight motion is the pulse ring + shimmer bar). */}
                <Glyph className={cn("h-4 w-4", Glyph === Icon && cfg.spin && inFlight && "animate-spin")} />
                {badge ? (
                  <span
                    aria-hidden
                    className={cn(
                      "absolute -bottom-1 -right-1 flex h-3 w-3 items-center justify-center rounded-full bg-[var(--page-bg)] ring-1 ring-border/70",
                      badge.className,
                    )}
                  >
                    <badge.icon className="h-2 w-2" strokeWidth={4} />
                  </span>
                ) : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-foreground/85">{label}</span>
                {/* P8: wrap-anywhere — a detail line carrying an unbreakable
                    token (hash, revert word) must never push past the card. */}
                <span className="block wrap-anywhere break-words text-[11px] text-foreground/40">
                  {t(`trace.status.${step.status}` as never)}
                  {step.detail?.text ? ` · ${step.detail.text}` : ""}
                </span>
              </span>
              {stepElapsed != null ? (
                <span
                  className={cn(
                    "flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums",
                    inFlight ? "text-primary/80" : "text-foreground/35",
                  )}
                  aria-label={t("trace.elapsed")}
                >
                  <Clock className="h-2.5 w-2.5" aria-hidden />
                  {fmtElapsed(stepElapsed)}
                </span>
              ) : null}
              {hasDetail ? (
                <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-foreground/30 transition-transform", isOpen && "rotate-180")} aria-hidden />
              ) : null}
            </button>

            <AnimatePresence initial={false}>
              {isOpen && hasDetail ? (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="overflow-hidden"
                >
                  <div className="mt-2 space-y-1.5 border-t border-foreground/10 pt-2 text-[11px] leading-relaxed text-foreground/60">
                    {/* N25: the tool's validated arguments, humanized — shown
                     * before the result (input → output reading order). */}
                    {visibleArgEntries(step.tool, step.args).length > 0 ? (
                      <ArgsSection tool={step.tool} args={step.args} />
                    ) : null}
                    {step.result?.summary ? (
                      // P8: wrap-anywhere — summaries can carry hashes/JSON
                      // tokens with no break opportunities.
                      <p className={cn("wrap-anywhere break-words", step.result.ok ? "text-foreground/70" : "text-danger/90")}>{step.result.summary}</p>
                    ) : null}
                    {step.detail?.txHash || step.result?.txHash ? (
                      <TxRow chainId={step.detail?.chainId ?? step.result?.chainId} txHash={String(step.detail?.txHash ?? step.result?.txHash)} />
                    ) : null}
                    {step.detail?.merkleRoot ? (
                      <div className="flex items-center gap-1">
                        <p className="min-w-0 flex-1 truncate font-mono text-[10px] text-foreground/40" title={step.detail.merkleRoot}>
                          {t("trace.merkleRoot")}: {shortHash(step.detail.merkleRoot)}
                        </p>
                        <CopyButton value={step.detail.merkleRoot} />
                      </div>
                    ) : null}
                    {step.detail?.blockNumber ? (
                      <p className="text-foreground/40">
                        {t("trace.block")}: {step.detail.blockNumber}
                      </p>
                    ) : null}
                    {step.detail?.address ? (
                      <div className="flex items-center gap-1">
                        <p className="min-w-0 flex-1 truncate font-mono text-[10px] text-foreground/40" title={step.detail.address}>
                          {t("trace.contract")}: {shortHash(step.detail.address)}
                        </p>
                        <CopyButton value={step.detail.address} />
                      </div>
                    ) : null}
                    {(() => {
                      // N27.1/N25: tool results that carry deep links (CC3
                      // explorer tx URLs, source-chain explorer URLs) render
                      // as clickable records — every Attestcoin artifact
                      // viewable straight from the chat trace.
                      const data = step.result?.data as Record<string, unknown> | undefined;
                      const links: Array<{ label: string; url: string }> = [];
                      const explorerTx = typeof data?.explorerTx === "string" ? (data.explorerTx as string) : null;
                      const explorerUrl = typeof data?.explorerUrl === "string" ? (data.explorerUrl as string) : null;
                      if (explorerTx && /^https:\/\//.test(explorerTx)) links.push({ label: t("trace.explorer"), url: explorerTx });
                      if (explorerUrl && /^https:\/\//.test(explorerUrl)) links.push({ label: t("trace.explorer"), url: explorerUrl });
                      if (links.length === 0) return null;
                      return (
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {links.map((l, li) => (
                            <a
                              key={li}
                              href={l.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex min-h-11 items-center gap-1 rounded-md border border-foreground/10 px-2.5 text-[10px] text-primary active:bg-primary/10 hover:border-primary/40 hover:text-primary-hover"
                            >
                              <ExternalLink className="h-3 w-3" aria-hidden />
                              {l.label}
                            </a>
                          ))}
                        </div>
                      );
                    })()}
                    {step.detail?.error ? (
                      // P8: the reported defect — error strings (revert data,
                      // JSON bodies, hex blobs) overflowed the step card.
                      <p className="wrap-anywhere break-words font-mono text-[10.5px] leading-relaxed text-danger/80">{step.detail.error}</p>
                    ) : null}
                    {(() => {
                      // Pre-signature visibility (§5): fee units + USD ride the
                      // awaiting_signature detail (C3). Render them as a quiet
                      // key-value block — the wallet shows exact gas at signing.
                      const fee = (step.detail?.data as { feeEstimate?: { gasUnits: string; breakdown?: Array<{ label: string; gasUnits: string; chainId?: number }> } } | undefined)?.feeEstimate;
                      if (!fee) return null;
                      return (
                        <div className="mt-1 rounded-lg border border-foreground/10 bg-foreground/[0.03] p-2">
                          <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-foreground/35">
                            <Fuel className="h-2.5 w-2.5" aria-hidden /> {t("confirm.fee")}
                          </p>
                          <p className="mt-0.5 font-mono text-[10px] tabular-nums text-foreground/60">
                            ≈ {Number(BigInt(fee.gasUnits)).toLocaleString("en-US")} gas
                          </p>
                          {fee.breakdown && fee.breakdown.length > 1 ? (
                            <div className="mt-1 space-y-0.5">
                              {fee.breakdown.map((b, bi) => (
                                <p key={bi} className="flex items-baseline justify-between gap-3 text-[9px] text-foreground/40">
                                  <span className="min-w-0 truncate">{b.label}</span>
                                  <span className="shrink-0 font-mono tabular-nums">{Number(BigInt(b.gasUnits)).toLocaleString("en-US")}</span>
                                </p>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    })()}
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </motion.div>
        );
      })}

      {/* ── Run summary footer (queue #2 polish): steps, duration, txs, reason ── */}
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-foreground/8 bg-foreground/[0.02] px-2.5 py-1.5 text-[10px] text-foreground/40">
        <span className="flex items-center gap-1" aria-label={t("trace.runSteps")}>
          <Layers className="h-2.5 w-2.5" aria-hidden />
          {runStats.succeeded}/{runStats.total} {t("trace.runStepsDone")}
        </span>
        {runStats.failed > 0 ? (
          <span className="flex items-center gap-0.5 text-danger/80">
            <X className="h-2.5 w-2.5" aria-hidden />
            {runStats.failed}
          </span>
        ) : null}
        {runStats.declined > 0 ? (
          <span className="flex items-center gap-0.5 text-warning/80">
            <ShieldAlert className="h-2.5 w-2.5" aria-hidden />
            {runStats.declined}
          </span>
        ) : null}
        {runStats.txCount > 0 ? (
          <span className="flex items-center gap-1">
            <Zap className="h-2.5 w-2.5 text-primary/70" aria-hidden />
            {runStats.txCount} {t("trace.runTxs")}
          </span>
        ) : null}
        {hasRunTimes ? (
          <span className="flex items-center gap-1 font-mono tabular-nums">
            <Clock className="h-2.5 w-2.5" aria-hidden />
            {fmtElapsed(runDurationMs)}
          </span>
        ) : null}
        {footer?.finishReason ? (
          <span
            className={cn(
              "ml-auto rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider",
              footer.finishReason === "stop"
                ? "bg-success/10 text-success"
                : footer.finishReason === "error"
                  ? "bg-danger/10 text-danger"
                  : footer.finishReason === "interrupted"
                    ? "bg-warning/10 text-warning"
                    : "bg-primary/10 text-primary",
            )}
          >
            {t(`trace.finish.${footer.finishReason}` as never)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function TxRow({ chainId, txHash }: { chainId?: number; txHash: string }) {
  const { t } = useI18n();
  const chain = chainId ? getChainByChainId(chainId) : undefined;
  const url = chain?.explorerUrl ? `${chain.explorerUrl}/tx/${txHash}` : null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span className="flex min-w-0 items-center gap-1.5 pl-1">
        <span className="min-w-0 truncate font-mono text-[10.5px] text-foreground/50" title={txHash}>
          {shortHash(txHash)}
        </span>
        {chain ? <span className="shrink-0 text-[10.5px] text-foreground/35">· {chain.shortName}</span> : null}
      </span>
      <CopyButton value={txHash} />
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center gap-1 rounded-md border border-foreground/10 px-2.5 text-[10px] text-primary active:bg-primary/10 hover:border-primary/40 hover:text-primary-hover"
        >
          <ExternalLink className="h-3 w-3" aria-hidden />
          {t("trace.explorer")}
        </a>
      ) : null}
    </span>
  );
}

// ── N25 arg-row components ───────────────────────────────────────────────────

/** Icon-only copy button — a full 44×44 touch target (Android-correct: the
 * icon is always visible, no hover needed; `active:` gives touch feedback;
 * the check icon confirms the copy on-device). */
function CopyButton({ value }: { value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={t("trace.copy")}
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      }}
      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-foreground/40 transition-colors hover:bg-foreground/[0.06] hover:text-foreground/70 active:bg-foreground/10"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-success" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
    </button>
  );
}

type TFunc = (key: TranslationKey) => string;

/** Label → value row for plain values (chain names, amounts, yes/no…). */
function ArgTextRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 px-2 py-1">
      <span className="max-w-[55%] shrink-0 truncate text-[10.5px] text-foreground/45">{label}</span>
      <span
        className={cn("min-w-0 truncate text-right text-[10.5px] text-foreground/65", mono && "font-mono tabular-nums")}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

/** Label → truncated mono value + copy (addresses, tx hashes, schedule ids). */
function ArgHashRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 pl-2">
      <span className="max-w-[45%] shrink-0 truncate text-[10.5px] text-foreground/45">{label}</span>
      <span className="ml-auto flex min-w-0 items-center">
        <span className="min-w-0 truncate font-mono text-[10.5px] text-foreground/65" title={value}>
          {value.length > 24 ? shortHash(value) : value}
        </span>
        <CopyButton value={value} />
      </span>
    </div>
  );
}

/** Collapsed row for long text / complex values — expands to a scrollable
 * mono block (the existing "pre code-surface" pattern) plus a copy button. */
function ArgDetailsRow({ label, value, preview }: { label: string; value: string; preview?: string }) {
  return (
    <details className="group/arg">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 px-1.5 text-[10.5px] text-foreground/45 [&::-webkit-details-marker]:hidden">
        <ChevronDown className="h-3 w-3 shrink-0 text-foreground/30 transition-transform group-open/arg:rotate-180" aria-hidden />
        <span className="shrink-0">{label}</span>
        {preview ? <span className="min-w-0 flex-1 truncate text-foreground/30">{preview}</span> : null}
      </summary>
      <div className="flex items-start gap-1 pb-1 pl-1.5 pr-1">
        <pre className="acp-scroll max-h-40 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-all rounded-md p-2 code-surface font-mono text-[9.5px] leading-relaxed text-foreground/60">
          {value}
        </pre>
        <CopyButton value={value} />
      </div>
    </details>
  );
}

/** One arg key/value — dispatches on the known arg shapes, with a generic
 * (humanized key + auto-detected value) fallback for anything unmapped. */
function ArgRow({ argKey, value, t, language }: { argKey: string; value: unknown; t: TFunc; language: string }) {
  const label = ARG_LABEL_KEYS[argKey] ? t(ARG_LABEL_KEYS[argKey] as never) : humanArgKey(argKey);

  if (argKey === "chain" || argKey === "sourceChain") {
    const text =
      value == null
        ? t("trace.allChains")
        : typeof value === "number"
          ? (getChainByChainId(value)?.shortName ?? `id ${value}`)
          : String(value);
    return <ArgTextRow label={label} value={text} />;
  }

  if (argKey === "cadence" && typeof value === "string") {
    const text = CADENCE_KEYS.has(value) ? t(`recurring.${value}` as never) : humanArgKey(value);
    return <ArgTextRow label={label} value={text} />;
  }

  if (typeof value === "boolean") {
    return <ArgTextRow label={label} value={value ? t("trace.yes") : t("trace.no")} />;
  }

  if (typeof value === "number") {
    if (argKey === "maxWaitSeconds") return <ArgTextRow label={label} value={fmtSeconds(value)} mono />;
    if (argKey === "timeoutHours" || argKey === "intervalHours") return <ArgTextRow label={label} value={fmtHours(value)} mono />;
    if (argKey === "rateTctcPerEth") return <ArgTextRow label={label} value={`${value.toLocaleString(language)} tCTC/ETH`} mono />;
    return <ArgTextRow label={label} value={value.toLocaleString(language)} mono />;
  }

  if (typeof value === "string") {
    if (HASH_ARG_KEYS.has(argKey) || isEvmHash(value)) return <ArgHashRow label={label} value={value} />;
    if (NUMERIC_STRING.test(value) && Number.isFinite(Number(value))) {
      return <ArgTextRow label={label} value={Number(value).toLocaleString(language, { maximumFractionDigits: 18 })} mono />;
    }
    if (value.length > 96) return <ArgDetailsRow label={label} value={value} preview={value.slice(0, 72)} />;
    return <ArgTextRow label={label} value={value} />;
  }

  const json = JSON.stringify(value, null, 2) ?? String(value);
  const preview = Array.isArray(value) ? `${value.length}` : undefined;
  return <ArgDetailsRow label={label} value={json} preview={preview} />;
}

/** The Parameters section: every visible arg of the step, in the order the
 * model supplied them. Rendered above the result summary (input → output). */
function ArgsSection({ tool, args }: { tool: string; args: Record<string, unknown> | undefined }) {
  const { t, language } = useI18n();
  const entries = visibleArgEntries(tool, args);
  if (entries.length === 0) return null;
  return (
    <div className="rounded-lg border border-foreground/10 bg-foreground/[0.03] pb-0.5 pt-1">
      <p className="flex items-center gap-1 px-2 pb-0.5 text-[9px] font-semibold uppercase tracking-wider text-foreground/35">
        <SlidersHorizontal className="h-2.5 w-2.5" aria-hidden />
        {t("trace.paramsTitle")}
      </p>
      {entries.map(([k, v]) => (
        <ArgRow key={k} argKey={k} value={v} t={t} language={language} />
      ))}
    </div>
  );
}

/** Localize a tool name for the action-log surface (exported for reuse). */
export function traceToolLabel(tool: string): TranslationKey | null {
  const key = TOOL_LABEL_KEYS[tool];
  return key ? (key as TranslationKey) : null;
}
