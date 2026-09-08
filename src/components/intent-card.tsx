"use client";

import { memo, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";
import type { PaymentIntent, PaymentStatus } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  AlertCircle, ArrowRight, Check, CheckCircle2, Clock, Copy, ExternalLink,
  FileCheck2, Hexagon, Loader2, Send, ShieldCheck, Sparkles, Wallet, XCircle,
} from "lucide-react";
import { explorerTxUrl, explorerAddressUrl, networkName, getUsdc, DEFAULT_CHAIN_ID } from "@/lib/wagmi/chains";
import { useTxReceipt } from "@/lib/use-tx-receipt";
import { useAttestationForTx } from "@/lib/use-attestation-for-tx";
import { useI18n } from "@/lib/i18n";
import { AttestStatePill } from "@/components/attest-state-pill";
import type { TranslationKey } from "@/lib/i18n/types";
import { cn } from "@/lib/utils";

// ─── Types ───────────────────────────────────────────────────────────────────

interface IntentCardProps {
  intent: PaymentIntent;
  status?: PaymentStatus;
  txHash?: string;
  chainId?: number;
  senderAddress?: string;
  paymentStep?: string;
  onConfirm?: () => void;
  onCancel?: () => void;
  onCancelPayment?: () => void;
  paymentId?: string;
}

// ─── Step definitions ─────────────────────────────────────────────────────────

type StepState = "pending" | "current" | "done" | "failed" | "skipped";

interface StepDef {
  key: string;
  labelKey: TranslationKey;
  descKey: TranslationKey;
  icon: typeof FileCheck2;
}

// On-chain transfer steps + the Attestcoin attestation step. After the
// transfer confirms, the attestation step tracks the tx's inclusion proof on
// Creditcoin (Merkle + continuity) — "current" while the block is not yet
// attested, "done" once the proof is available. Chains not tracked by the
// integration (or upstream failures) skip the step silently.
const STEPS: StepDef[] = [
  { key: "creating", labelKey: "intent.stepCreateRecord", descKey: "intent.stepCreateRecordDesc", icon: FileCheck2 },
  { key: "transfer-signing", labelKey: "intent.stepSendOnchain", descKey: "intent.plainStepSendOnchainDesc", icon: Send },
  { key: "confirming", labelKey: "intent.stepWaitingConfirm", descKey: "intent.stepWaitingConfirmDesc", icon: Clock },
  { key: "attesting", labelKey: "intent.stepAttest", descKey: "intent.stepAttestDesc", icon: Hexagon },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shortenAddress(address: string) {
  if (!address) return "";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function initials(label: string | null) {
  if (!label) return "?";
  return label.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}

function CopyableAddress({ address, chainId }: { address: string; chainId?: number }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(address);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="flex items-center gap-1.5 font-mono text-[11px] text-muted hover:text-foreground transition-colors"
        title={t("intent.copyFullAddress")}
      >
        {shortenAddress(address)}
        <Copy className={cn("h-3 w-3 transition-opacity", copied ? "opacity-100 text-success" : "opacity-40")} />
      </button>
      {chainId ? (
        <Link href={explorerAddressUrl(chainId, address)} target="_blank" rel="noopener noreferrer" className="text-muted hover:text-primary transition-colors" title={t("intent.viewOnExplorer")}>
          <ExternalLink className="h-3 w-3" />
        </Link>
      ) : null}
    </div>
  );
}

function resolveStepIndex(step: string, steps: StepDef[]): number {
  const idx = steps.findIndex((s) => s.key === step);
  return idx === -1 ? steps.length : idx;
}

function computeStepState(
  stepIdx: number,
  currentIdx: number,
  isDone: boolean,
  isFailed: boolean,
): StepState {
  if (isDone) return "done";
  if (isFailed) {
    if (stepIdx < currentIdx) return "done";
    if (stepIdx === currentIdx) return "failed";
    return "skipped";
  }
  if (stepIdx < currentIdx) return "done";
  if (stepIdx === currentIdx) return "current";
  return "pending";
}

function StepIcon({ state, icon: Icon }: { state: StepState; icon: typeof FileCheck2 }) {
  if (state === "done") return <Check className="h-3.5 w-3.5 text-white" strokeWidth={3} />;
  if (state === "current") return <Loader2 className="h-3.5 w-3.5 text-current animate-spin" />;
  if (state === "failed") return <XCircle className="h-3.5 w-3.5 text-white" />;
  return <Icon className="h-3.5 w-3.5" />;
}

function StepRow({ def, state, isLast }: { def: StepDef; state: StepState; isLast: boolean }) {
  const { t } = useI18n();
  const bgClass = {
    done: "bg-success",
    current: "bg-primary",
    failed: "bg-danger",
    pending: "bg-surface-3",
    skipped: "bg-surface-3 opacity-40",
  }[state];

  const textClass = {
    done: "text-foreground",
    current: "text-primary",
    failed: "text-danger",
    pending: "text-muted",
    skipped: "text-muted-2",
  }[state];

  const descClass = {
    done: "text-muted-2",
    current: "text-muted",
    failed: "text-danger/80",
    pending: "text-muted-3",
    skipped: "text-muted-3 opacity-50",
  }[state];

  return (
    <div className="relative flex items-start gap-2.5 py-1.5">
      {/* Icon + connecting line */}
      <div className="flex flex-col items-center">
        <motion.div
          initial={state === "current" ? { scale: 0.8 } : false}
          animate={state === "current" ? { scale: 1 } : undefined}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-full ring-1 ring-inset transition-colors",
            bgClass,
            state === "current" && "ring-primary/30",
            state === "pending" && "ring-border/40 text-muted-2",
            state === "skipped" && "ring-border/30",
            state === "done" && "text-white",
            state === "failed" && "text-white ring-danger/30",
          )}
        >
          <StepIcon state={state} icon={def.icon} />
        </motion.div>
        {!isLast ? (
          <div className={cn(
            "absolute top-7 h-[calc(100%-12px)] w-px",
            state === "done" ? "bg-success/30" : "bg-border/30",
          )} />
        ) : null}
      </div>

      {/* Label + description */}
      <div className="flex-1 pt-0.5">
        <p className={cn("text-[12px] font-medium transition-colors", textClass)}>
          {t(def.labelKey)}
        </p>
        <AnimatePresence>
          {state === "current" || state === "failed" || state === "done" ? (
            <motion.p
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className={cn("text-[11px] leading-relaxed transition-colors overflow-hidden", descClass)}
            >
              {t(def.descKey)}
            </motion.p>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export const IntentCard = memo(function IntentCard({
  intent,
  status,
  txHash,
  chainId,
  senderAddress,
  paymentStep,
  onConfirm,
  onCancel,
  onCancelPayment,
  paymentId: _paymentId,
}: IntentCardProps) {
  const { t } = useI18n();
  const isPending = status === "signing" || status === "settling" || status === "approving";
  const isDone = status === "settled";
  const isFailed = status === "failed";
  const isReviewing = !status || status === "reviewing";
  const showingSteps = isPending || isDone || isFailed;

  const effectiveChain = chainId ?? DEFAULT_CHAIN_ID;
  const receipt = useTxReceipt(
    txHash && (isPending || isDone || isFailed) ? txHash : undefined,
    effectiveChain,
  );

  // Attestcoin attestation state for the settled transfer tx. Only worth
  // checking once the tx is mined (settled) — while signing/settling the
  // step renders "pending" without polling.
  const attestation = useAttestationForTx(
    txHash,
    effectiveChain,
    isDone && Boolean(txHash) && receipt.state === "confirmed",
  );

  const usdcInfo = getUsdc(effectiveChain);
  const isStablecoin = intent.token === "USDC" || intent.token === "USDC.e";
  const isNativeToken = intent.token === "ETH";
  const tokenContractAddress = isNativeToken
    ? null
    : isStablecoin
      ? usdcInfo?.address ?? (/^0x[a-fA-F0-9]{40}$/.test(intent.token) ? (intent.token as `0x${string}`) : null)
      : (intent.token as `0x${string}`);

  const explorerUrl = txHash ? explorerTxUrl(effectiveChain, txHash) : "/payments";
  const receiptHref = isDone && txHash ? explorerUrl : "/payments";

  const steps = STEPS;
  const currentIdx = paymentStep ? resolveStepIndex(paymentStep, steps) : 0;

  // State of the attestation step (last in the timeline). Skipped when the
  // integration can't check it; "current" (spinner) while the payment is
  // settled but the block isn't attested on Creditcoin yet.
  const ATTEST_IDX = steps.length - 1;
  const attestStepState: StepState = (() => {
    if (attestation.phase === "disabled" || attestation.phase === "unsupported" || attestation.phase === "unavailable") {
      return "skipped";
    }
    if (attestation.phase === "attested") return "done";
    if (isFailed) return "skipped";
    if (isDone) return "current";
    return "pending";
  })();
  /** Index of the last row that will actually render (for connector lines). */
  const lastVisibleIdx = attestStepState === "skipped" ? ATTEST_IDX - 1 : ATTEST_IDX;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
      className="glass-panel mt-2 w-full rounded-2xl overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/50 bg-surface-2/30 px-4 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          {t("intent.paymentRequest")}
        </span>
        <div className="flex items-center gap-2">
          {intent.aiGenerated ? (
            <span className="flex items-center gap-1 rounded-full bg-cyan-500/10 px-2 py-0.5 text-[10px] font-medium text-cyan-700 dark:text-cyan-300">
              <Sparkles className="h-2.5 w-2.5" /> {t("intent.aiBadge")}
            </span>
          ) : null}
          {isNativeToken ? (
            <span className="flex items-center gap-1 rounded-full bg-muted/15 px-2 py-0.5 text-[10px] font-medium text-muted-2" title={t("intent.nativeBadgeTitle")}>
              <Wallet className="h-2.5 w-2.5" /> {t("intent.nativeBadge")}
            </span>
          ) : null}
          <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-medium text-muted">
            {networkName(effectiveChain)}
          </span>
        </div>
      </div>

      {/* Amount */}
      <div className="px-4 pt-4 pb-3">
        <div className="rounded-xl bg-surface-2/40 p-4">
          <p className="text-xs text-muted">{t("intent.amount")}</p>
          <p className="font-mono text-4xl font-semibold tracking-tight text-foreground tabular-nums">
            {intent.amountHuman}
            <span className="ml-2 text-xl font-normal text-muted">{intent.token}</span>
          </p>
          {intent.amountBaseUnits ? (
            <p className="mt-1 font-mono text-[11px] text-muted-2 tabular-nums">
              {Number(BigInt(intent.amountBaseUnits)).toLocaleString()} {t("intent.baseUnits")}
              {isStablecoin && usdcInfo ? ` · ${usdcInfo.decimals} ${t("intent.decimals")}` : ""}
            </p>
          ) : null}
        </div>
      </div>

      {/* From → To flow */}
      <div className="px-4 pb-3">
        <div className="flex items-stretch gap-2.5">
          {/* Sender */}
          <div className="flex-1 min-w-0 rounded-xl border border-border/40 bg-surface-2/20 p-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted/20 ring-1 ring-inset ring-border/50">
                <Wallet className="h-3.5 w-3.5 text-muted" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wider text-muted-2">{t("intent.from")}</p>
                <p className="truncate text-[13px] font-medium text-foreground">
                  {senderAddress ? t("intent.yourWallet") : t("intent.notConnected")}
                </p>
              </div>
            </div>
            {senderAddress ? <div className="mt-1.5"><CopyableAddress address={senderAddress} chainId={effectiveChain} /></div> : null}
          </div>

          {/* Arrow */}
          <div className="flex items-center justify-center">
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.1, type: "spring", stiffness: 500, damping: 25 }}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-primary"
            >
              <ArrowRight className="h-4 w-4" />
            </motion.div>
          </div>

          {/* Recipient */}
          <div className="flex-1 min-w-0 rounded-xl border border-border/40 bg-surface-2/20 p-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary/30 to-primary/5 text-xs font-semibold text-primary ring-1 ring-inset ring-primary/30" aria-hidden="true">
                {initials(intent.recipientLabel)}
              </div>
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wider text-muted-2">{t("intent.to")}</p>
                <p className="truncate text-[13px] font-medium text-foreground">
                  {intent.recipientLabel ?? t("intent.unknownRecipient")}
                </p>
              </div>
            </div>
            <div className="mt-1.5"><CopyableAddress address={intent.recipientAddress} chainId={effectiveChain} /></div>
          </div>
        </div>
      </div>

      {/* Details grid */}
      <div className="border-t border-border/40 px-4 py-3">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-xs">
          <div>
            <p className="text-muted-2">{t("intent.token")}</p>
            <p className="font-medium text-foreground">
              {intent.token}
              {isNativeToken ? <span className="ml-1 text-[10px] font-normal text-muted-2">{t("intent.nativeGas")}</span> : ""}
            </p>
          </div>
          <div>
            <p className="text-muted-2">{t("intent.network")}</p>
            <p className="font-medium text-foreground">{networkName(effectiveChain)}</p>
          </div>
          {tokenContractAddress ? (
            <div className="col-span-2">
              <p className="text-muted-2">{t("intent.tokenContract")}</p>
              <Link href={explorerAddressUrl(effectiveChain, tokenContractAddress)} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 font-mono text-[11px] text-primary hover:underline">
                {shortenAddress(tokenContractAddress)}
                <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
          ) : null}
          {intent.memo ? (
            <div className="col-span-2">
              <p className="text-muted-2">{t("intent.note")}</p>
              <p className="text-foreground">{intent.memo}</p>
            </div>
          ) : null}
          {intent.confidence != null && intent.confidence < 1 ? (
            <div className="col-span-2">
              <p className="text-muted-2">{t("intent.aiConfidence")}</p>
              <div className="flex items-center gap-2">
                <div className="h-1.5 w-24 rounded-full bg-surface-3">
                  <div className="h-1.5 rounded-full bg-primary" style={{ width: `${Math.round(intent.confidence * 100)}%` }} />
                </div>
                <span className="font-mono text-[11px] text-muted">{Math.round(intent.confidence * 100)}%</span>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Pre-confirm info note */}
      {isReviewing ? (
        <div className="border-t border-border/40 px-4 py-3">
          {isNativeToken ? (
            <div className="rounded-xl border border-border/40 bg-surface-2/20 px-3 py-2.5 text-[11px] text-muted">
              <p className="flex items-center gap-1.5 font-medium text-muted-2">
                <Wallet className="h-3.5 w-3.5" />
                {t("intent.nativeTokenTransfer")}
              </p>
              <p className="mt-1 text-muted-2 leading-relaxed">
                {t("intent.nativeTokenDesc", { token: intent.token })}
              </p>
            </div>
          ) : (
            <div className="rounded-xl bg-primary/5 border border-primary/10 px-3 py-2.5 text-[11px] text-muted">
              <p className="flex items-center gap-1.5 font-medium text-primary/80">
                <ShieldCheck className="h-3.5 w-3.5" />
                {t("intent.onchainTransfer")}
              </p>
              <p className="mt-1 text-muted-2 leading-relaxed">
                {t("intent.onchainTransferDesc", { token: intent.token })}
              </p>
            </div>
          )}
        </div>
      ) : null}

      {/* Live step timeline */}
      {showingSteps ? (
        <div className="border-t border-border/50 px-4 py-3">
          <div className="flex items-center gap-1.5 pb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
            {isDone ? (
              <><CheckCircle2 className="h-3.5 w-3.5 text-success" /> {t("intent.paymentComplete")}</>
            ) : isFailed ? (
              <><AlertCircle className="h-3.5 w-3.5 text-danger" /> {t("intent.paymentFailed")}</>
            ) : (
              <><Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> {t("intent.processingPayment")}</>
            )}
          </div>
          <div className="flex flex-col">
            {steps.map((step, idx) => {
              const state = idx === ATTEST_IDX ? attestStepState : computeStepState(idx, currentIdx, isDone, isFailed);
              if (state === "skipped") return null;
              return <StepRow key={step.key} def={step} state={state} isLast={idx === lastVisibleIdx} />;
            })}
          </div>
        </div>
      ) : null}

      {/* Receipt confirmations */}
      {txHash && receipt.state !== "unknown" ? (
        <div className="border-t border-border/50 bg-surface-2/20 px-4 py-3 text-xs text-muted">
          {receipt.state === "pending" ? (
            <div className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-warning" />
              {receipt.stuck ? t("intent.awaitingReceiptTimeout") : t("intent.waitingReceipt")}
            </div>
          ) : receipt.state === "reverted" ? (
            <div className="flex items-start gap-2 text-danger">
              <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
              {/* P8: revert reasons can be long unbreakable strings
                  (custom-error selectors, hex data) — contained + wrappable. */}
              <span className="min-w-0 flex-1 wrap-anywhere break-words">
                {t("intent.reverted")}{receipt.revertReason ? ` — ${receipt.revertReason}` : ""}
              </span>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                <span className="tabular-nums text-foreground">{receipt.confirmations.toLocaleString()}</span>
                <span>{receipt.confirmations === 1 ? t("intent.confirmation") : t("intent.confirmations")}</span>
                {receipt.finalized ? (
                  <span className="rounded-full bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success">{t("intent.finalized")}</span>
                ) : (
                  <span className="text-muted-3">{t("intent.updating")}</span>
                )}
              </div>
              {receipt.blockNumber !== null ? <span className="font-mono text-muted-3">#{receipt.blockNumber.toString()}</span> : null}
            </div>
          )}
        </div>
      ) : null}

      {/* Attestcoin settlement verification footer.
          Renders once the payment settles: a verifiable-settlement receipt
          (proof-available badge + Merkle root + dashboard link) or the
          awaiting-attestation state while Creditcoin hasn't attested the
          block yet. Read-only lookup — on-chain proof submission is
          TODO(phase-2) (Block Prover Precompile + funded signer). */}
      {isDone && txHash && (attestation.phase === "attested" || attestation.phase === "pending" || attestation.phase === "checking") ? (
        <div className="border-t border-border/50 bg-surface-2/20 px-4 py-3">
          {attestation.phase === "attested" ? (
            <div className="rounded-lg border border-success/20 border-l-2 border-l-success/60 bg-gradient-to-r from-success/5 to-transparent px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="flex items-center gap-1.5 text-[11px] font-medium text-success">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    {t("intent.attestVerifiedTitle")}
                  </p>
                  <AttestStatePill state="proof" size="xs" />
                </div>
                <a
                  href={attestation.dashboardUrl ?? "https://dashboard.cc3-testnet.creditcoin.network/"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[10px] text-muted-2 transition-colors hover:text-primary"
                >
                  {t("intent.attestDashboard")}
                  <ExternalLink className="h-2.5 w-2.5" />
                </a>
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-muted-2">
                {t("intent.attestVerifiedDesc", {
                  block: (attestation.headerNumber ?? 0).toLocaleString(),
                  roots: attestation.continuityRoots ?? 0,
                })}
              </p>
              {attestation.merkleRoot ? (
                <p className="mt-1 truncate font-mono text-[10px] text-muted-3" title={attestation.merkleRoot}>
                  {t("intent.attestMerkleLabel")} {attestation.merkleRoot.slice(0, 18)}…{attestation.merkleRoot.slice(-8)}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-lg border border-warning/20 bg-warning/5 px-3 py-2">
              {attestation.phase === "checking" ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-warning" />
              ) : (
                <motion.span
                  className="inline-block shrink-0"
                  animate={{ opacity: [1, 0.4, 1] }}
                  transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
                >
                  <Hexagon className="h-3.5 w-3.5 text-warning" />
                </motion.span>
              )}
              <p className="text-[11px] leading-relaxed text-warning/90">
                {t("intent.attestPendingTitle")}
                <span className="block text-[10px] text-muted-2">{t("intent.attestPendingDesc")}</span>
              </p>
              <span className="ml-auto shrink-0">
                <AttestStatePill state={attestation.phase === "checking" ? "loading" : "pending"} size="xs" />
              </span>
            </div>
          )}
        </div>
      ) : null}

      {/* Footer actions */}
      {(isDone || isFailed) ? (
        <div className="flex items-center justify-end gap-3 border-t border-border/50 px-4 py-2.5">
          <div className="flex items-center gap-3">
            {isFailed && onConfirm ? <Button variant="primary" size="sm" onClick={onConfirm}>{t("intent.retry")}</Button> : null}
            <Link href={receiptHref} target={isDone && txHash ? "_blank" : undefined} rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
              {isDone && txHash ? t("intent.receipt") : t("intent.viewInPayments")} <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
        </div>
      ) : isReviewing ? (
        <div className="flex items-center gap-2 border-t border-border/50 px-4 py-3">
          <Button variant="secondary" size="md" onClick={onCancel} disabled={isPending}>{t("intent.cancel")}</Button>
          <Button variant="primary" size="md" onClick={onConfirm} disabled={isPending} className="flex-1">
            <span className="flex items-center gap-2"><Wallet className="h-4 w-4" /> {t("intent.confirmPay")}</span>
          </Button>
        </div>
      ) : isPending && onCancelPayment ? (
        <div className="flex items-center justify-end gap-2 border-t border-border/50 px-4 py-2.5">
          <button
            onClick={onCancelPayment}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/10"
          >
            <XCircle className="h-3.5 w-3.5" />
            {t("intent.cancelPayment")}
          </button>
        </div>
      ) : null}
    </motion.div>
  );
});
