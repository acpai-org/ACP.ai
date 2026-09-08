"use client";

import { useMemo, useState, memo, useCallback, useDeferredValue, useEffect, useRef, Suspense } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import {
  Receipt,
  Filter,
  Check,
  X,
  Loader2,
  Clock,
  ArrowUpDown,
  ExternalLink,
  RefreshCw,
  ChevronDown,
  AlertCircle,
  Copy,
  Send,
  ShieldCheck,
  Trash2,
  RefreshCcw,
  BadgeCheck,
  Landmark,
  KeyRound,
  Radar,
  Star,
  UserPlus,
  UserRound,
  Repeat,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { PageContainer } from "@/components/page-container";
import { ActionsView } from "@/components/actions-view";
import { Card, EmptyState } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { usePayments, useSyncPayment, useDeletePayment, useSubmitAttestationBatch, useContacts, type BatchAttestResult } from "@/lib/api";
import { settledTotalsByToken } from "@/lib/contacts/rollup";
import { PaymentAttestationCard } from "@/components/payment-attestation-card";
import { CertificateVerifier } from "@/components/certificate-verifier";
import { FileSearch } from "lucide-react";
import { shortenAddress } from "@/lib/format";
import { explorerTxUrl, explorerAddressUrl, networkName, getUsdc } from "@/lib/wagmi/chains";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import { useFormatters } from "@/lib/use-formatters";
import { useAskAgent } from "@/lib/use-ask-agent";
import { cn } from "@/lib/utils";

type FilterStatus = "all" | "settled" | "pending" | "failed" | "attested" | "awaiting" | "onchain";

interface AttestFilterEntry {
  value: "attested" | "awaiting" | "onchain";
  icon: typeof ShieldCheck;
  /** Active-state tint classes (inactive looks like the status filters). */
  activeClass: string;
}

/** Attestation-state filters — settled payments seen through the Attestcoin lens. */
const ATTEST_FILTERS: AttestFilterEntry[] = [
  { value: "attested", icon: ShieldCheck, activeClass: "bg-success/15 text-success ring-1 ring-inset ring-success/30 shadow-[0_2px_8px_-2px_rgba(74,222,128,0.35)]" },
  { value: "awaiting", icon: Clock, activeClass: "bg-warning/15 text-warning ring-1 ring-inset ring-warning/30 shadow-[0_2px_8px_-2px_rgba(234,179,8,0.3)]" },
  { value: "onchain", icon: BadgeCheck, activeClass: "bg-primary/15 text-primary ring-1 ring-inset ring-primary/30 shadow-[0_2px_8px_-2px_rgba(8,145,178,0.4)]" },
];

const FILTERS: { label: string; value: FilterStatus }[] = [
  { label: "All", value: "all" },
  { label: "Settled", value: "settled" },
  { label: "Pending", value: "pending" },
  { label: "Failed", value: "failed" },
];

function isPendingStatus(status: string) {
  return (
    status === "pending" ||
    status === "signing" ||
    status === "settling" ||
    status === "sent" ||
    status === "approving" ||
    status === "deploying"
  );
}

/**
 * Whether a payment's on-chain state might have progressed further than what
 * the DB currently records (receipt wasn't available when the app returned).
 * Used to decide whether to show the "Sync" button and whether to auto-sync
 * on page load. Requires a broadcast transaction hash — without one there is
 * nothing on-chain to sync (the sync route would 400), and a pending payment
 * is most often simply awaiting the user's wallet signature.
 *
 * TODO(phase-2): sync will additionally consult the Attestcoin Protocol for
 * the payment's attestation status, not just the raw transaction receipt.
 */
function isStale(p: { status?: string | null; txHash?: string | null }): boolean {
  const hasTx = !!p.txHash && p.txHash !== "0x0" && p.txHash !== "";
  return hasTx && isPendingStatus(p.status ?? "");
}

interface StatusEntry {
  label: string;
  icon: typeof Check;
  className: string;
  spin?: boolean;
  pulse?: boolean;
}

const ALL_STATUSES: Record<string, StatusEntry> = {
  settled: { label: "Settled", icon: Check, className: "bg-success/10 text-success" },
  failed: { label: "Failed", icon: X, className: "bg-danger/10 text-danger" },
  pending: { label: "Pending", icon: Clock, className: "bg-warning/10 text-warning", pulse: true },
  signing: { label: "Signing", icon: Loader2, className: "bg-primary/10 text-primary", spin: true },
  settling: { label: "Settling", icon: Loader2, className: "bg-primary/10 text-primary", spin: true },
  approving: { label: "Approving", icon: Loader2, className: "bg-warning/10 text-warning", spin: true },
  deploying: { label: "Deploying", icon: Loader2, className: "bg-warning/10 text-warning", spin: true },
  sent: {
    label: "Broadcast",
    icon: Send,
    className: "bg-primary/10 text-primary",
    pulse: true,
  },
};

function getStatusEntry(status: string): StatusEntry {
  return ALL_STATUSES[status] ?? {
    label: status.charAt(0).toUpperCase() + status.slice(1),
    icon: Clock,
    className: "bg-warning/10 text-warning",
  };
}

const StatusBadge = memo(function StatusBadge({
  status,
}: {
  status: string;
}) {
  const { t } = useI18n();
  const c = getStatusEntry(status);
  const Icon = c.icon;
  const labelMap: Record<string, TranslationKey> = {
    settled: "payments.statusSettled",
    failed: "payments.statusFailed",
    pending: "payments.statusPending",
    signing: "payments.statusSigning",
    settling: "payments.statusSettled",
    approving: "payments.statusSigning",
    deploying: "payments.statusSigning",
    sent: "payments.statusSent",
  };
  const tKey = labelMap[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        c.className,
      )}
    >
      <Icon className={cn("h-3 w-3", c.spin && "animate-spin", c.pulse && "animate-pulse")} />
      {tKey ? t(tKey) : c.label}
    </span>
  );
});

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
      className={cn(
        "flex items-center gap-1 font-mono text-xs text-muted transition-colors hover:text-foreground",
      )}
      title={label ? `${t("common.copy")} ${label}` : t("common.copy")}
    >
      {shortenAddress(value)}
      <Copy className={cn("h-3 w-3 transition-opacity", copied ? "opacity-100 text-success" : "opacity-40")} />
    </button>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <span className="text-muted-2 shrink-0 text-xs">{label}</span>
      <span className="text-right text-xs">{children}</span>
    </div>
  );
}

interface PaymentDbType {
  id: string;
  recipientLabel: string | null;
  recipientAddress: string;
  token: string;
  tokenAddress: string | null;
  amountHuman: string;
  amountBaseUnits: string;
  status: string;
  memo: string | null;
  txHash: string | null;
  chainId: number;
  senderAddress: string | null;
  createdAt: number;
  settledAt: number | null;
  /** Set by the server-side Attestcoin poller when the proof first appears. */
  attestedAt: number | null;
  attestRoot: string | null;
  /** Set when the Block Prover Precompile (0x0FD2) confirmed the proof on-chain. */
  onchainVerifiedAt: number | null;
  /** Creditcoin tx hash of the signed on-chain proof submission, when performed. */
  cc3TxHash: string | null;
}

const PaymentRow = memo(function PaymentRow({
  payment,
  isExpanded,
  isHighlighted = false,
  onToggle,
  onSync,
  isSyncing,
  syncError,
  onDelete,
  isDeleting,
  deleteError,
}: {
  payment: PaymentDbType;
  isExpanded: boolean;
  /** R15 (deep-link): momentary emphasis while a notification deep-link lands. */
  isHighlighted?: boolean;
  onToggle: () => void;
  onSync?: (paymentId: string) => void;
  isSyncing?: boolean;
  syncError?: string | null;
  onDelete?: (paymentId: string) => void;
  isDeleting?: boolean;
  deleteError?: string | null;
}) {
  const { t } = useI18n();
  const { timeAgo, formatFullDate } = useFormatters();
  // R12 (pay again): the handoff bridge — routes to the chat and hands the
  // exact intent back to the composer, same primitive the contacts page and
  // the wallet quick actions use.
  const askAgent = useAskAgent();
  const chainId = payment.chainId;
  const hasTx = !!payment.txHash && payment.txHash !== "0x0" && payment.txHash !== "";
  const tokenInfo = getUsdc(chainId);
  const tokenContract =
    payment.tokenAddress ?? (tokenInfo?.address ?? null);
  // isStale already requires a usable txHash.
  const canSync = isStale(payment);

  return (
    <motion.div
      data-payment-row={payment.id}
      className={cn(
        "rounded-2xl overflow-hidden",
        // R15 (deep-link): ring + soft tint while the notification hand-off
        // points at this row; box-shadow rings paint outside overflow-hidden.
        isHighlighted && "ring-2 ring-primary/70 ring-offset-2 ring-offset-background",
      )}
      animate={isHighlighted ? { scale: [1, 1.012, 1] } : undefined}
      transition={{ duration: 0.5 }}
    >
      {/* Compact header row */}
      <button
        type="button"
        onClick={onToggle}
        className="glass-item group flex w-full items-center gap-3 p-4 text-left cursor-pointer transition-colors hover:bg-surface-2/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary/25 to-primary/5 text-sm font-semibold text-primary ring-1 ring-inset ring-primary/20 transition-shadow duration-200 group-hover:ring-primary/35">
          {(payment.recipientLabel ?? "?").charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium text-foreground">
              {payment.recipientLabel ?? t("recurring.unknownRecipient")}
            </p>
            <StatusBadge status={payment.status} />
            {payment.status === "settled" && hasTx ? (
              payment.attestedAt ? (
                <span
                  className={cn(
                    "inline-flex h-4 w-4 items-center justify-center rounded-full text-success ring-1 ring-inset",
                    payment.onchainVerifiedAt
                      ? "bg-success/15 ring-success/50"
                      : "bg-success/15 ring-success/30",
                  )}
                  title={
                    payment.onchainVerifiedAt
                      ? t("payments.attestRowOnchain")
                      : t("payments.attestRowVerified")
                  }
                  aria-label={
                    payment.onchainVerifiedAt
                      ? t("payments.attestRowOnchain")
                      : t("payments.attestRowVerified")
                  }
                >
                  <ShieldCheck className="h-2.5 w-2.5" />
                </span>
              ) : (
                <span
                  className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-success/10 text-success"
                  title={t("payments.attestRowHint")}
                  aria-label={t("payments.attestRowHint")}
                >
                  <ShieldCheck className="h-2.5 w-2.5" />
                </span>
              )
            ) : null}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <p className="truncate font-mono text-xs text-muted">
              {shortenAddress(payment.recipientAddress)}
            </p>
            <span className="text-[10px] text-muted-3">·</span>
            <span className="text-[10px] text-muted-2 shrink-0">{networkName(chainId)}</span>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-mono text-sm font-semibold text-foreground tabular-nums">
            {payment.amountHuman}
          </p>
          <p className="text-xs text-muted-2">{payment.token}</p>
          <p className="mt-0.5 text-[11px] text-muted-2" title={formatFullDate(payment.createdAt)}>
            {timeAgo(payment.createdAt)}
          </p>
        </div>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted transition-all duration-200 group-hover:text-foreground",
            isExpanded && "rotate-180 text-primary",
          )}
        />
      </button>

      {/* Expanded details panel */}
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
                <DetailRow label={t("payments.status")}>
                  <StatusBadge status={payment.status} />
                </DetailRow>
                <DetailRow label={t("payments.network")}>
                  <span className="font-mono text-muted">{networkName(chainId)}</span>
                </DetailRow>
                <DetailRow label={t("payments.token")}>
                  <span className="font-mono text-muted">{payment.token}</span>
                </DetailRow>
                <DetailRow label={t("payments.amount")}>
                  <span className="font-mono text-muted tabular-nums">
                    {Number(BigInt(payment.amountBaseUnits)).toLocaleString()}
                  </span>
                </DetailRow>
                <DetailRow label={t("payments.created")}>
                  <span className="text-muted">{formatFullDate(payment.createdAt)}</span>
                </DetailRow>
                {payment.settledAt ? (
                  <DetailRow label={t("payments.settledTime")}>
                    <span className="text-success">{formatFullDate(payment.settledAt)}</span>
                  </DetailRow>
                ) : null}
              </div>

              <div className="my-2 border-t border-border/40" />

              {/* Recipient */}
              <DetailRow label={t("payments.recipient")}>
                <div className="flex items-center gap-2">
                  <CopyableValue value={payment.recipientAddress} label={t("payments.recipient")} />
                  <a
                    href={explorerAddressUrl(chainId, payment.recipientAddress)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:text-primary-hover"
                    title={t("common.viewExplorer")}
                  >
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </DetailRow>

              {/* Sender */}
              {payment.senderAddress ? (
                <DetailRow label={t("payments.sender")}>
                  <div className="flex items-center gap-2">
                    <CopyableValue value={payment.senderAddress} label={t("payments.sender")} />
                    <a
                      href={explorerAddressUrl(chainId, payment.senderAddress)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:text-primary-hover"
                      title={t("common.viewExplorer")}
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </DetailRow>
              ) : null}

              {/* Token contract */}
              {tokenContract ? (
                <DetailRow label={t("payments.tokenContract")}>
                  <div className="flex items-center gap-2">
                    <CopyableValue value={tokenContract} label={t("payments.tokenContract")} />
                    <a
                      href={explorerAddressUrl(chainId, tokenContract)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:text-primary-hover"
                      title={t("common.viewExplorer")}
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </DetailRow>
              ) : (
                <DetailRow label={t("payments.tokenContract")}>
                  <span className="text-muted-2 italic">{t("payments.native")}</span>
                </DetailRow>
              )}

              {/* Tx hash */}
              {hasTx ? (
                <DetailRow label={t("payments.txHash")}>
                  <div className="flex items-center gap-2">
                    <CopyableValue value={payment.txHash!} label={t("common.viewTx")} />
                    <a
                      href={explorerTxUrl(chainId, payment.txHash!)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-primary hover:underline text-xs"
                    >
                      {t("common.viewTx")} <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </DetailRow>
              ) : (
                <DetailRow label={t("payments.txHash")}>
                  <span className="text-muted-2 italic">{t("payments.notBroadcast")}</span>
                </DetailRow>
              )}

              {/* Memo */}
              {payment.memo ? (
                <DetailRow label={t("payments.memo")}>
                  <span className="text-foreground max-w-[60ch]">{payment.memo}</span>
                </DetailRow>
              ) : null}

              {/* Attestcoin Protocol attestation — the Phase-2 seam.
                  "Verify on Attestcoin" fetches a Merkle + continuity proof
                  from the Creditcoin proof builder AND re-checks it against
                  the Block Prover Precompile (read-only eth_call). Signed
                  on-chain submission (POST /api/payments/[id]/attest) is
                  offered in the card when a signer is configured. */}
              {hasTx ? (
                <>
                  <div className="my-2 border-t border-border/40" />
                  <PaymentAttestationCard
                    paymentId={payment.id}
                    txHash={payment.txHash!}
                    serverAttestedAt={payment.attestedAt}
                    serverCc3TxHash={payment.cc3TxHash}
                    paymentContext={{
                      recipient: payment.recipientAddress,
                      recipientLabel: payment.recipientLabel,
                      senderAddress: payment.senderAddress,
                      token: payment.token,
                      amountHuman: payment.amountHuman,
                      memo: payment.memo,
                      chainId: payment.chainId,
                      createdAt: payment.createdAt,
                      settledAt: payment.settledAt,
                    }}
                  />
                </>
              ) : null}

              {/* Plain ERC-20 transfer note (kept for context alongside
                  attestation state). */}
              {payment.token !== "ETH" ? (
                <>
                  <div className="my-2 border-t border-border/40" />
                  <div className="flex items-center gap-1.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
                    <Send className="h-3 w-3" />
                    {t("payments.plainErc20Transfer")}
                  </div>
                  <p className="text-[11px] text-muted-2 leading-relaxed">
                    {t("payments.plainTransferDesc")}
                  </p>
                </>
              ) : null}

              {/* Pay again + Sync + Delete actions */}
              <div className="my-2 border-t border-border/40" />
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {/* R12 (pay again): one tap hands the exact intent (payee,
                    amount, token, chain) back to the chat composer — the
                    historical payment becomes a template. Offered on every
                    non-in-flight payment: settled rows repeat a known-good
                    intent, failed rows retry it. */}
                {!isPendingStatus(payment.status) ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      askAgent(
                        t("payments.payAgainPrompt", {
                          amount: payment.amountHuman,
                          token: payment.token,
                          name: payment.recipientLabel ?? shortenAddress(payment.recipientAddress),
                          address: payment.recipientAddress,
                          chain: networkName(payment.chainId),
                        }),
                      );
                    }}
                    className="h-7 gap-1.5 text-xs"
                    title={t("payments.payAgain")}
                  >
                    <Repeat className="h-3 w-3" />
                    {t("payments.payAgain")}
                  </Button>
                ) : null}
                {canSync ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSync?.(payment.id);
                    }}
                    disabled={isSyncing}
                    className="h-7 gap-1.5 text-xs"
                    title={t("payments.sync")}
                  >
                    {isSyncing ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCcw className="h-3 w-3" />
                    )}
                    {isSyncing ? t("payments.syncing") : t("payments.sync")}
                  </Button>
                ) : null}
                {syncError ? (
                  <span className="text-[10px] text-danger flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" />
                    {syncError}
                  </span>
                ) : null}

                {isDeleting ? (
                  <span className="text-xs text-muted flex items-center gap-1.5">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t("payments.deleting")}
                  </span>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (
                        confirm(
                          t("payments.deleteConfirmName", { name: payment.recipientLabel ?? payment.recipientAddress }),
                        )
                      ) {
                        onDelete?.(payment.id);
                      }
                    }}
                    disabled={isDeleting}
                    className="h-7 gap-1.5 text-xs text-danger hover:text-danger"
                    title={t("payments.delete")}
                  >
                    <Trash2 className="h-3 w-3" />
                    {t("payments.delete")}
                  </Button>
                )}
                {deleteError ? (
                  <span className="text-[10px] text-danger flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" />
                    {deleteError}
                  </span>
                ) : null}
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
});

/**
 * Result banner for POST /api/payments/attest-batch — success receipt with
 * the Creditcoin tx hash, 409 "nothing ready" guidance, or the 501 env hint.
 * Rendered via AnimatePresence so it slides in/out; success auto-dismisses
 * (see handleBatchSubmit).
 */
function BatchResultBanner({
  result,
  isPending,
  error,
}: {
  result: (BatchAttestResult & { status: number }) | undefined;
  isPending: boolean;
  error: Error | null;
}) {
  const { t } = useI18n();
  if (isPending || !result) {
    if (error) {
      return (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          className="flex items-center gap-2 rounded-xl border border-danger/30 bg-danger/5 px-4 py-2.5"
          role="alert"
        >
          <AlertCircle className="h-4 w-4 shrink-0 text-danger" />
          <p className="text-xs text-danger">{error.message}</p>
        </motion.div>
      );
    }
    return null;
  }

  if (result.ok) {
    return (
      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-success/25 border-l-2 border-l-success/60 bg-gradient-to-r from-success/10 via-success/5 to-transparent px-4 py-2.5"
        role="status"
      >
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-success">
          <Landmark className="h-3 w-3" />
          {t("payments.batchDone")}
        </div>
        <p className="text-xs text-foreground">
          {t("payments.batchSuccess", { count: result.persistedCount ?? result.submittedCount ?? 0 })}
        </p>
        {result.cc3TxHash ? (
          <span className="font-mono text-[11px] text-muted" title={result.cc3TxHash}>
            {shortenAddress(result.cc3TxHash)}
          </span>
        ) : null}
        {result.gasUsed != null ? (
          <span className="text-[11px] text-muted-2">{result.gasUsed.toLocaleString()} gas</span>
        ) : null}
        {result.skipped && result.skipped.length > 0 ? (
          <span className="text-[11px] text-muted-2">
            · {t("payments.batchSkipped", { count: result.skipped.length })}
          </span>
        ) : null}
      </motion.div>
    );
  }

  // 501 — signer not configured: guidance, not an error.
  if (result.status === 501) {
    return (
      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        className="flex items-start gap-2 rounded-xl border border-dashed border-border bg-surface/40 px-4 py-2.5"
      >
        <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-2" />
        <p className="text-[11px] leading-relaxed text-muted-2">
          {result.hint ?? t("payments.submitHint", { env: "CREDITCOIN_SIGNER_KEY" })}
        </p>
      </motion.div>
    );
  }

  // 409 — nothing eligible yet.
  if (result.status === 409) {
    return (
      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        className="flex items-center gap-2 rounded-xl border border-warning/25 bg-warning/5 px-4 py-2.5"
        role="status"
      >
        <Clock className="h-4 w-4 shrink-0 text-warning" />
        <p className="wrap-anywhere break-words text-xs text-warning">{result.error ?? t("payments.batchEmpty")}</p>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="flex items-center gap-2 rounded-xl border border-danger/30 bg-danger/5 px-4 py-2.5"
      role="alert"
    >
      <AlertCircle className="h-4 w-4 shrink-0 text-danger" />
      <p className="wrap-anywhere break-words text-xs text-danger">{result.detail ?? result.error ?? t("payments.batchError")}</p>
    </motion.div>
  );
}

// ── Attestcoin watcher liveness strip ────────────────────────────────────────
// The server-side poller's heartbeat, surfaced next to the attestation-state
// filters: "watching N payments · last check Xs ago · M verified". Shares the
// wallet panel's watcher i18n keys so both surfaces speak one vocabulary.
function WatcherStrip({
  poller,
}: {
  poller: {
    lastTickAt: number | null;
    lastTickChecked: number | null;
    flippedTotal: number;
    lastError: string | null;
    watching: number | null;
  };
}) {
  const { t } = useI18n();
  const { timeAgo } = useFormatters();
  const watching = poller.watching;
  return (
    <div
      className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-border/70 bg-surface-2/30 px-3.5 py-2"
      role="status"
    >
      <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
        <Radar className="h-4 w-4 text-primary" aria-hidden />
        <span className="absolute h-1 w-1 animate-pulse rounded-full bg-primary" aria-hidden />
      </span>
      <p className="text-[11px] font-medium text-foreground">
        {watching != null && watching > 0
          ? t("wallet.watcherWatching", { count: watching })
          : t("wallet.watcherIdle")}
      </p>
      <span className="text-[10px] text-muted-3">·</span>
      <p className="text-[11px] text-muted-2">
        {poller.lastTickAt
          ? t("wallet.watcherLastTick", { time: timeAgo(poller.lastTickAt) })
          : t("wallet.watcherStarting")}
      </p>
      {poller.flippedTotal > 0 ? (
        <span className="inline-flex items-center gap-1 text-[11px] text-success">
          <BadgeCheck className="h-3 w-3" aria-hidden />
          {t("wallet.watcherFlips", { count: poller.flippedTotal })}
        </span>
      ) : null}
      {poller.lastError ? (
        <p className="w-full truncate text-[10px] text-warning" title={poller.lastError}>
          {t("wallet.watcherError")}
        </p>
      ) : null}
    </div>
  );
}

function PaymentsPageInner() {
  const { t } = useI18n();
  const askAgent = useAskAgent();
  const { data, isLoading, isFetching, refetch } = usePayments();
  const payments = data?.payments;
  // R13-B: contacts for the empty-state quick actions (shared query key —
  // free after any visit to the contacts page, one local read otherwise).
  const { data: contactsData } = useContacts();
  /** Signed-submission availability (surfaced by GET /api/payments). */
  const submission = data?.submission;
  /** Attestcoin watcher liveness (surfaced by GET /api/payments). */
  const poller = data?.poller;
  const syncPayment = useSyncPayment();
  const deletePayment = useDeletePayment();
  const submitBatch = useSubmitAttestationBatch();
  const [filter, setFilter] = useState<FilterStatus>("all");
  const [sortBy, setSortBy] = useState<"recent" | "amount">("recent");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [verifierOpen, setVerifierOpen] = useState(false);
  const [syncingPaymentId, setSyncingPaymentId] = useState<string | null>(null);
  const [syncErrors, setSyncErrors] = useState<Record<string, string>>({});
  const [deletingPaymentId, setDeletingPaymentId] = useState<string | null>(null);
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const autoSyncedRef = useRef(false);
  const deferredFilter = useDeferredValue(filter);
  const deferredSort = useDeferredValue(sortBy);

  // ── R15 (deep-link): /payments?highlight=<id> from a notification row ──
  // The named row arrives expanded + scrolled into view + ringed for ~3s.
  // Consumed once per mount (the param stays shareable); an unknown id is
  // ignored honestly — no fake highlight on a missing row.
  const searchParams = useSearchParams();
  const highlightParam = searchParams.get("highlight");
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const highlightConsumedRef = useRef(false);

  // ── R17 (contact filter): /payments?contact=<address> from the contacts
  // rollup — rows narrow to ONE recipient with a dismissible context chip.
  // Consumed once per mount (shareable URL, like the highlight param); a
  // non-address param is ignored honestly (no filter applied). The filter
  // is checksum-insensitive (lowercase compare) and stays active across
  // status-filter switches — it's a WHO lens, orthogonal to the status lens.
  const contactParam = searchParams.get("contact");
  const [contactFilter, setContactFilter] = useState<string | null>(null);
  const contactFilterConsumedRef = useRef(false);
  const router = useRouter();

  const rows = useMemo<PaymentDbType[]>(() => payments ?? [], [payments]);

  // ── R17 (WHO-lens base): the rows the contact filter admits. The status
  // census (R12 invariant: counts must agree with what a click shows), the
  // settled-total chips (R15: same reducer as the contacts rollup — the two
  // surfaces can never disagree), and the visible list ALL read from this
  // base, so every number on the page agrees under either lens. ──────────
  const contactRows = useMemo(
    () =>
      contactFilter
        ? rows.filter((p) => p.recipientAddress.toLowerCase() === contactFilter)
        : rows,
    [rows, contactFilter],
  );

  // R15 (settled-total chips): per-token settled sums over the lens base
  // (never cross-symbol — the honesty rule), reusing the contacts-rollup
  // reducer so the payments page and the contacts page can never disagree.
  const settledTotals = useMemo(() => settledTotalsByToken(contactRows), [contactRows]);

  useEffect(() => {
    if (!highlightParam || highlightConsumedRef.current || rows.length === 0) return;
    if (!rows.some((p) => p.id === highlightParam)) return;
    highlightConsumedRef.current = true;
    setHighlightId(highlightParam);
    setExpandedId(highlightParam);
  }, [highlightParam, rows]);

  // Contact-filter consume — once per mount; valid-address gate (a garbage
  // param filters nothing and shows no chip). No rows requirement: a contact
  // with zero payments still gets the honest filtered empty state.
  useEffect(() => {
    if (!contactParam || contactFilterConsumedRef.current) return;
    if (!/^0x[0-9a-f]{40}$/i.test(contactParam)) return;
    contactFilterConsumedRef.current = true;
    setContactFilter(contactParam.toLowerCase());
  }, [contactParam]);

  // Scroll-once — keyed on the highlight STATE (not the rows identity): a
  // background refetch re-runs the consume effect above (early-returning),
  // and its cleanup would otherwise cancel this frame before it fires. The
  // RAF body's element lookup keeps it a no-op after unmount.
  useEffect(() => {
    if (!highlightId) return;
    const raf = requestAnimationFrame(() => {
      document
        .querySelector(`[data-payment-row="${CSS.escape(highlightId)}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(raf);
  }, [highlightId]);

  // Highlight expiry — its own effect so a rows refetch (identity change)
  // never cancels the timer early.
  useEffect(() => {
    if (!highlightId) return;
    const timer = setTimeout(() => setHighlightId(null), 3200);
    return () => clearTimeout(timer);
  }, [highlightId]);

  // R13-B: quick-start chips for the zero-payments empty state — favorites
  // first, then most recently used, capped at 2 (a hint, not a directory).
  const quickContacts = useMemo(() => {
    const list = contactsData ?? [];
    return [...list]
      .sort((a, b) => {
        if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
        return b.lastUsed - a.lastUsed;
      })
      .slice(0, 2);
  }, [contactsData]);

  // R12 (filter counts): the same affordance the notifications page's filters
  // have — each status chip carries its live count so the row reads as a
  // census, not just a switch. Counts use the SAME predicates as the filter
  // below AND the same contact-lens base, so the badge can never disagree
  // with what a click shows (extended to the WHO lens in R17).
  const statusCounts = useMemo(
    () =>
      ({
        all: contactRows.length,
        settled: contactRows.filter((p) => p.status === "settled").length,
        pending: contactRows.filter((p) => isPendingStatus(p.status)).length,
        failed: contactRows.filter((p) => p.status === "failed").length,
      }) as Record<(typeof FILTERS)[number]["value"], number>,
    [contactRows],
  );

  // Auto-sync all stale payments once on initial load.
  // This fixes the case where the app returned before the transaction receipt
  // was available (DB still says "signing"/"settling") — the tx may have since
  // been mined.
  useEffect(() => {
    if (autoSyncedRef.current) return;
    if (rows.length === 0) return;
    autoSyncedRef.current = true;
    const staleIds = rows.filter(isStale).map((p) => p.id);
    if (staleIds.length === 0) return;
    // fire all syncs in parallel
    staleIds.forEach((id) => {
      fetch(`/api/payments/${id}/sync`, { method: "POST" }).catch(() => {});
    });
    // refetch after a short delay to pick up the result
    setTimeout(() => refetch(), 2500);
  }, [rows, refetch]);

  // R17 (contact filter): label resolves through the shared ["contacts"]
  // cache (free after any contacts-page visit); an unknown address falls
  // back to the shortened form — the chip never shows a raw 42-char string.
  const contactFilterLabel = useMemo(() => {
    if (!contactFilter) return null;
    const match = (contactsData ?? []).find(
      (c) => c.address.toLowerCase() === contactFilter,
    );
    return match?.label ?? shortenAddress(contactFilter);
  }, [contactFilter, contactsData]);

  // R17: how many rows the WHO lens matches (before the status lens) — shown
  // on the chip so the count can't disagree with what clearing restores.
  const contactMatchCount = contactRows.length;

  const clearContactFilter = useCallback(() => {
    setContactFilter(null);
    // Strip the param so a refresh or re-share doesn't resurrect the lens.
    router.replace("/payments", { scroll: false });
  }, [router]);

  const sorted = useMemo(() => {
    const hasTx = (p: PaymentDbType) => !!p.txHash && p.txHash !== "0x0" && p.txHash !== "";
    // Source = the WHO-lens base (contactRows): the status predicate runs on
    // the SAME rows the census counted, under either lens.
    const list = contactRows.filter((p) => {
      if (deferredFilter === "all") return true;
      if (deferredFilter === "pending") return isPendingStatus(p.status);
      // Attestation-state lens — settled payments with a broadcast tx only.
      if (deferredFilter === "attested") return p.attestedAt != null;
      if (deferredFilter === "awaiting") return p.status === "settled" && hasTx(p) && p.attestedAt == null;
      if (deferredFilter === "onchain") return p.onchainVerifiedAt != null;
      return p.status === deferredFilter;
    });
    return [...list].sort((a, b) => {
      if (deferredSort === "amount")
        return parseFloat(b.amountHuman) - parseFloat(a.amountHuman);
      return b.createdAt - a.createdAt;
    });
  }, [contactRows, deferredFilter, deferredSort]);

  const handleRefresh = useCallback(() => refetch(), [refetch]);

  const handleToggleSort = useCallback(
    () => setSortBy((s) => (s === "recent" ? "amount" : "recent")),
    [],
  );
  const handleToggleExpand = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const handleSyncPayment = useCallback(
    async (paymentId: string) => {
      setSyncingPaymentId(paymentId);
      setSyncErrors((prev) => {
        const next = { ...prev };
        delete next[paymentId];
        return next;
      });
      try {
        const result = await syncPayment.mutateAsync(paymentId);
        if (!result.synced && result.reason !== "already terminal") {
          setSyncErrors((prev) => ({ ...prev, [paymentId]: result.reason ?? t("payments.syncNoUpdate") }));
        }
      } catch (err) {
        setSyncErrors((prev) => ({
          ...prev,
          [paymentId]: err instanceof Error ? err.message : t("payments.syncFailed"),
        }));
      }
      setSyncingPaymentId(null);
    },
    [syncPayment, t],
  );

  const handleSyncAll = useCallback(async () => {
    const staleIds = rows.filter(isStale).map((p) => p.id);
    if (staleIds.length === 0) return;
    await Promise.all(staleIds.map((id) => handleSyncPayment(id)));
    refetch();
  }, [rows, handleSyncPayment, refetch]);

  // ── Batch attestation submission (verifyAndEmitBatch) ──
  // Eligible: settled with a broadcast tx and no submission on record.
  // The button only renders when a signer is configured; the route still
  // answers 501 with a hint if the env var disappears between render + click.
  const batchEligible = useMemo(
    () =>
      rows.filter(
        (p) =>
          p.status === "settled" &&
          !!p.txHash &&
          p.txHash !== "0x0" &&
          p.txHash !== "" &&
          !p.cc3TxHash,
      ),
    [rows],
  );

  const handleBatchSubmit = useCallback(() => {
    submitBatch.mutate(undefined, {
      onSuccess: (result) => {
        if (result.ok) {
          // Auto-dismiss the success banner after a while.
          setTimeout(() => {
            if (!submitBatch.isPending) submitBatch.reset();
          }, 10_000);
        }
      },
    });
  }, [submitBatch]);

  const handleDeletePayment = useCallback(
    async (paymentId: string) => {
      setDeletingPaymentId(paymentId);
      setDeleteErrors((prev) => {
        const next = { ...prev };
        delete next[paymentId];
        return next;
      });
      try {
        await deletePayment.mutateAsync(paymentId);
        if (expandedId === paymentId) setExpandedId(null);
      } catch (err) {
        setDeleteErrors((prev) => ({
          ...prev,
          [paymentId]: err instanceof Error ? err.message : t("payments.deleteFailed"),
        }));
      }
      setDeletingPaymentId(null);
    },
    [deletePayment, expandedId, t],
  );

  return (
    <PageContainer
      title={t("payments.title")}
      description={t("payments.desc")}
      icon={<Receipt className="h-5 w-5" />}
      action={
        <div className="flex gap-2">
          {rows.some(isStale) ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleSyncAll}
              disabled={syncPayment.isPending}
              title={t("payments.syncAll")}
            >
              <RefreshCcw className={cn("h-3.5 w-3.5", syncPayment.isPending && "animate-spin")} />
              {t("payments.syncAll")}
            </Button>
          ) : null}
          {submission?.configured && batchEligible.length > 0 ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleBatchSubmit}
              disabled={submitBatch.isPending}
              title={t("payments.batchSubmitTitle")}
              className={cn(
                "gap-1.5 border-primary/30 text-primary hover:border-primary/50 hover:bg-primary/10",
              )}
            >
              <Landmark className={cn("h-3.5 w-3.5", submitBatch.isPending && "animate-pulse")} />
              {submitBatch.isPending
                ? t("payments.batchSubmitting")
                : t("payments.batchSubmit", { count: batchEligible.length })}
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" onClick={handleRefresh} disabled={isFetching}>
            <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
            {t("payments.refresh")}
          </Button>
        </div>
      }
    >
      {/* C7: the agent action log — the audit trail of EVERYTHING the agent
          did or attempted, live-updating with lifecycle transitions. */}
      <ActionsView />

      <Card>
        {/* R17 (contact filter): the WHO lens chip — one recipient, live match
            count, one-tap clear (X strips the URL param too). Primary-tinted
            and visually distinct from the status filters below so the two
            lenses never read as one row of filters. */}
        {contactFilter ? (
          <div className="mb-3 flex items-center gap-2 rounded-xl border border-primary/25 bg-primary/5 px-3 py-2 text-xs">
            <UserRound className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">
              {t("payments.contactFilterLabel", { name: contactFilterLabel ?? "" })}
            </span>
            <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-medium tabular-nums text-primary">
              {contactMatchCount}
            </span>
            <button
              type="button"
              onClick={clearContactFilter}
              aria-label={t("payments.contactFilterClear")}
              title={t("payments.contactFilterClear")}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-muted-2 transition-colors hover:bg-primary/10 hover:text-primary cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {FILTERS.map((f) => {
              const isActive = filter === f.value;
              return (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setFilter(f.value)}
                  aria-pressed={isActive}
                  className={cn(
                    "flex min-h-9 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60",
                    isActive
                      ? "bg-primary text-primary-foreground shadow-[0_2px_8px_-1px_rgba(8,145,178,0.4)]"
                      : "glass-item text-muted hover:text-foreground",
                  )}
                >
                  {f.value === "all" ? t("payments.all")
                    : f.value === "settled" ? t("payments.settled")
                    : f.value === "pending" ? t("payments.pending")
                    : t("payments.failed")}
                  {/* R12: live count badge (notifications-filter pattern) */}
                  <span
                    aria-hidden
                    className={cn(
                      "rounded-full px-1.5 py-px text-[10px] font-medium tabular-nums",
                      isActive
                        ? "bg-primary-foreground/25 text-primary-foreground"
                        : "bg-surface-3 text-muted-2",
                    )}
                  >
                    {statusCounts[f.value]}
                  </span>
                </button>
              );
            })}
            {/* Attestation-state lens — visually separated from the status filters */}
            <span aria-hidden className="mx-1 hidden h-4 w-px bg-border sm:inline-block" />
            {ATTEST_FILTERS.map((f) => {
              const Icon = f.icon;
              const isActive = filter === f.value;
              return (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setFilter(isActive && filter === f.value ? "all" : f.value)}
                  aria-pressed={isActive}
                  className={cn(
                    "inline-flex min-h-9 items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60",
                    isActive
                      ? f.activeClass
                      : "glass-item text-muted hover:text-foreground",
                  )}
                  title={
                    f.value === "attested" ? t("payments.filterAttestedHint")
                    : f.value === "awaiting" ? t("payments.filterAwaitingHint")
                    : t("payments.filterOnchainHint")
                  }
                >
                  <Icon className="h-3 w-3" />
                  {f.value === "attested" ? t("payments.filterAttested")
                    : f.value === "awaiting" ? t("payments.filterAwaiting")
                    : t("payments.filterOnchain")}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setVerifierOpen((v) => !v)}
              aria-expanded={verifierOpen}
              className={cn(
                "hit-slop h-8 gap-1.5 text-xs transition-colors",
                verifierOpen
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "hover:border-primary/30 hover:text-primary",
              )}
              title={t("payments.verifyCertificateHint")}
            >
              <FileSearch className="h-3.5 w-3.5" />
              {t("payments.verifyCertificate")}
            </Button>
            <Button variant="secondary" size="sm" onClick={handleToggleSort}>
              <ArrowUpDown className="h-3.5 w-3.5" />
              {sortBy === "recent" ? t("payments.sortRecent") : t("payments.sortHighest")}
            </Button>
          </div>
        </div>
        {/* Attestcoin watcher liveness — same heartbeat as the wallet panel,
            surfaced where the awaiting-attest filter lives. */}
        {poller && poller.running ? <WatcherStrip poller={poller} /> : null}
        {/* Contextual hint while the awaiting-attest lens shows rows: the
            watcher flips them automatically — no user action needed. */}
        {deferredFilter === "awaiting" && sorted.length > 0 ? (
          <p className="mt-2.5 flex items-start gap-1.5 rounded-lg border border-warning/20 bg-warning/5 px-2.5 py-2 text-[11px] leading-relaxed text-warning">
            <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {t("payments.awaitingHint")}
          </p>
        ) : null}
        {/* R15 (settled totals): per-token settled sums over all rows — the
            same reducer the contacts rollup uses, so the two surfaces can
            never disagree. Never cross-symbol (N21/P6 honesty). */}
        {settledTotals.length > 0 ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2.5">
            <span className="flex shrink-0 items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-3">
              <Check className="h-3 w-3 text-success" aria-hidden />
              {t("payments.settledTotalsLabel")}
            </span>
            {settledTotals.slice(0, 2).map((total) => (
              <span
                key={total.token}
                className="inline-flex items-baseline gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] tabular-nums text-success ring-1 ring-inset ring-success/20"
                title={t("payments.settledTotalsHint", { count: total.count, token: total.token })}
              >
                <span className="font-semibold">{total.total}</span>
                <span className="text-[9px] uppercase">{total.token}</span>
              </span>
            ))}
            {settledTotals.length > 2 ? (
              <span
                className="inline-flex items-center rounded-full bg-surface-3/80 px-2 py-0.5 text-[10px] tabular-nums text-muted-2"
                title={settledTotals.slice(2).map((x) => `${x.total} ${x.token}`).join(" · ")}
              >
                +{settledTotals.length - 2}
              </span>
            ) : null}
          </div>
        ) : null}
      </Card>

      {/* Inline certificate verifier — the export → share → re-verify loop
          without leaving the payments page. */}
      <AnimatePresence initial={false}>
        {verifierOpen ? (
          <motion.div
            key="verifier-section"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <CertificateVerifier />
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Batch submission result banner */}
      <AnimatePresence initial={false}>
        {submitBatch.data || submitBatch.error ? (
          <BatchResultBanner
            key="batch-banner"
            result={submitBatch.data}
            isPending={submitBatch.isPending}
            error={submitBatch.error}
          />
        ) : null}
      </AnimatePresence>

      {isLoading ? (
        <Card aria-busy="true">
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="shimmer h-10 w-10 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="shimmer h-3.5 w-1/3 rounded-md" />
                  <div className="shimmer h-2.5 w-1/4 rounded-md" />
                </div>
                <div className="shimmer h-3.5 w-16 rounded-md" />
              </div>
            ))}
          </div>
        </Card>
      ) : sorted.length === 0 ? (
        <EmptyState
          icon={
            deferredFilter === "attested" ? (
              <ShieldCheck className="h-6 w-6" />
            ) : deferredFilter === "awaiting" ? (
              <Clock className="h-6 w-6" />
            ) : deferredFilter === "onchain" ? (
              <BadgeCheck className="h-6 w-6" />
            ) : (
              <Filter className="h-6 w-6" />
            )
          }
          iconTileClassName={
            deferredFilter === "attested"
              ? "bg-success/10 text-success ring-1 ring-inset ring-success/20"
              : deferredFilter === "awaiting"
                ? "bg-warning/10 text-warning ring-1 ring-inset ring-warning/20"
                : deferredFilter === "onchain"
                  ? "bg-primary/10 text-primary ring-1 ring-inset ring-primary/20"
                  : undefined
          }
          title={
            rows.length === 0
              ? t("payments.noPayments")
              : contactFilter && contactMatchCount === 0
                ? t("payments.contactFilterEmpty", { name: contactFilterLabel ?? "" })
                : deferredFilter === "attested"
                ? t("payments.emptyAttestedTitle")
                : deferredFilter === "awaiting"
                  ? t("payments.emptyAwaitingTitle")
                  : deferredFilter === "onchain"
                    ? t("payments.emptyOnchainTitle")
                    : t("payments.noPaymentsFound")
          }
          description={
            rows.length === 0
              ? t("payments.noPaymentsDesc")
              : contactFilter && contactMatchCount === 0
                ? t("payments.contactFilterEmptyDesc", { name: contactFilterLabel ?? "" })
                : deferredFilter === "attested"
                ? t("payments.emptyAttestedDesc")
                : deferredFilter === "awaiting"
                  ? t("payments.emptyAwaitingDesc")
                  : deferredFilter === "onchain"
                    ? t("payments.emptyOnchainDesc")
                    : t("payments.noPaymentsFoundDesc")
          }
          action={
            rows.length === 0 ? (
              <div className="flex flex-col items-center gap-3">
                <Link href="/">
                  <Button variant="primary" size="sm">
                    {t("payments.newViaChat")}
                  </Button>
                </Link>
                {/* R13-B: quick-start chips — favorite/recent contacts when the
                    book has entries, an add-contact nudge when it doesn't. */}
                {quickContacts.length > 0 ? (
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {quickContacts.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() =>
                          askAgent(
                            t("contacts.sendPrompt", {
                              name: c.label,
                              address: c.address,
                            }),
                          )
                        }
                        className="glass-item flex min-h-9 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-muted transition-all duration-200 hover:border-primary/40 hover:bg-primary/10 hover:text-primary cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                        title={t("contacts.sendTo", { name: c.label })}
                      >
                        <Send className="h-3 w-3" aria-hidden />
                        <span className="max-w-[140px] truncate">{c.label}</span>
                        {c.favorite ? (
                          <Star className="h-3 w-3 shrink-0 text-warning" aria-hidden />
                        ) : null}
                      </button>
                    ))}
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
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-2">
          {sorted.map((payment, i) => (
            <motion.div
              key={payment.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: 0.25,
                delay: Math.min(i * 0.04, 0.24),
                ease: "easeOut",
              }}
            >
              <PaymentRow
                payment={payment}
                isExpanded={expandedId === payment.id}
                isHighlighted={highlightId === payment.id}
                onToggle={() => handleToggleExpand(payment.id)}
                onSync={handleSyncPayment}
                isSyncing={syncingPaymentId === payment.id}
                syncError={syncErrors[payment.id] ?? null}
                onDelete={handleDeletePayment}
                isDeleting={deletingPaymentId === payment.id}
                deleteError={deleteErrors[payment.id] ?? null}
              />
            </motion.div>
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

// useSearchParams needs a Suspense boundary for prerendering (Next.js app
// router requirement) — the page body already has its own loading state.
export default function PaymentsPage() {
  return (
    <Suspense fallback={null}>
      <PaymentsPageInner />
    </Suspense>
  );
}
