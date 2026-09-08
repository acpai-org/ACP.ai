"use client";

import { memo, useCallback, useEffect, useState } from "react";
import {
  ShieldCheck,
  ShieldAlert,
  Loader2,
  ExternalLink,
  Hexagon,
  Database,
  Copy,
  BadgeCheck,
  Landmark,
  KeyRound,
  Sparkles,
  FileDown,
  FileSearch,
  ArrowRight,
  Coins,
  Braces,
  Clock3,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { useFormatters } from "@/lib/use-formatters";
import { useAttestPayment, useSubmitAttestation, type PaymentAttestation } from "@/lib/api";
import { cc3ExplorerTxUrl } from "@/lib/attestcoin/cc3-links";
import { AttestStatePill } from "@/components/attest-state-pill";
import { ShareQrButton, AttestationQrModal, type AttestationRef } from "@/components/attestation-qr";
import { cn } from "@/lib/utils";

/** Slim payment summary carried into the exported attestation certificate. */
export interface AttestExportContext {
  recipient: string;
  recipientLabel?: string | null;
  senderAddress?: string | null;
  token: string;
  amountHuman: string;
  memo?: string | null;
  chainId: number;
  createdAt: number;
  settledAt: number | null;
}

function shortenHex(value: string, lead = 10, tail = 8): string {
  if (!value) return "";
  if (value.length <= lead + tail + 2) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

function CopyableHash({ value, label }: { value: string; label: string }) {
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
      className="flex items-center gap-1 font-mono text-[11px] text-muted transition-colors hover:text-foreground"
      title={`${t("common.copy")} ${label}`}
    >
      {shortenHex(value)}
      <Copy className={cn("h-3 w-3 transition-opacity", copied ? "text-success opacity-100" : "opacity-40")} />
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Attestcoin Protocol attestation panel inside a payment's expanded details.
//
// "Verify on Attestcoin" asks the server to fetch a Merkle + continuity
// proof for the payment's transfer tx from the Creditcoin proof builder AND
// to re-check it against the Block Prover Precompile (0x0FD2) via a read-only
// eth_call — so the receipt below reports both the proof data and the
// Creditcoin chain's own verdict.
//
// "Submit on Creditcoin" (the Phase-2 WRITE half) posts the proof on-chain as
// a signed transaction (verifyAndEmitSingle). It requires a funded Creditcoin
// signer (CREDITCOIN_SIGNER_KEY); when unset, the server answers 501 with a
// structured hint that this panel renders as guidance.
// ─────────────────────────────────────────────────────────────────────────────

const DASHBOARD_URLS: Record<string, string> = {
  testnet: "https://dashboard.cc3-testnet.creditcoin.network/",
  mainnet: "https://dashboard.cc3-mainnet-usc.creditcoin.network/",
};

function ProofDetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/25 py-1.5 last:border-b-0">
      <span className="shrink-0 text-[11px] text-muted-2">{label}</span>
      <span className="truncate font-mono text-[11px] text-foreground">{value}</span>
    </div>
  );
}

// ── C2/G4 — decoded tx section (protocol-native, from the proof itself) ──────

function DecodedTxSection({ decoded }: { decoded: NonNullable<PaymentAttestation["decoded"]> }) {
  const { t } = useI18n();
  const receiptOk = decoded.receiptStatus === "success";
  const receiptReverted = decoded.receiptStatus === "reverted";
  return (
    <div
      className={cn(
        "mt-1.5 rounded-lg border px-2.5 py-2",
        receiptReverted
          ? "border-danger/30 bg-danger/5"
          : "border-border bg-surface/40",
      )}
      title={
        decoded.dataPreview
          ? `${t("payments.attestDecodedTitle")} — calldata ${decoded.dataPreview}`
          : t("payments.attestDecodedTitle")
      }
    >
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
        <FileSearch className="h-3 w-3 text-primary/70" />
        {t("payments.attestDecodedTitle")}
      </div>
      <p className="mt-1 truncate font-mono text-[10px] leading-relaxed text-muted">
        {t("payments.attestDecodedRoute", {
          type: decoded.type,
          from: shortenHex(decoded.from, 8, 4),
          to: decoded.to
            ? shortenHex(decoded.to, 8, 4)
            : t("payments.attestDecodedCreation"),
        })}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        {decoded.valueEther !== "0" ? (
          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-2">
            <Coins className="h-3 w-3 opacity-60" />
            {decoded.valueEther} ETH
          </span>
        ) : null}
        {decoded.dataPreview ? (
          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-2">
            <Braces className="h-3 w-3 opacity-60" />
            {decoded.dataPreview}
          </span>
        ) : null}
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-wide",
            receiptOk
              ? "border-success/30 bg-success/10 text-success"
              : receiptReverted
                ? "border-danger/30 bg-danger/10 text-danger"
                : "border-border text-muted-2",
          )}
        >
          {receiptOk ? (
            <BadgeCheck className="h-2.5 w-2.5" />
          ) : (
            <ShieldAlert className="h-2.5 w-2.5" />
          )}
          {t("payments.attestDecodedReceipt")}:{" "}
          {receiptOk
            ? t("payments.attestDecodedReceiptOk")
            : receiptReverted
              ? t("payments.attestDecodedReceiptReverted")
              : "?"}
        </span>
      </div>
    </div>
  );
}

// ── C2/G7 — verification cost row ────────────────────────────────────────────

function CostRow({ cost }: { cost: NonNullable<PaymentAttestation["cost"]> }) {
  const { t } = useI18n();
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 border-b border-border/25 py-1.5",
        cost.stale && "bg-warning/5",
      )}
      title={
        cost.staleGapBlocks != null
          ? `${cost.continuityRoots} continuity roots · ${cost.staleGapBlocks.toLocaleString()} blocks behind the attested head`
          : `${cost.continuityRoots} continuity roots`
      }
    >
      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-2">
        <Coins className="h-3 w-3 opacity-60" />
        {t("payments.attestCost")}
      </span>
      <span className="inline-flex items-center gap-2 truncate font-mono text-[11px]">
        <span className="text-foreground">{cost.ctcLabel}</span>
        {cost.stale ? (
          <span className="rounded-full border border-warning/30 bg-warning/10 px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-warning">
            {t("payments.attestCostStale")}
          </span>
        ) : null}
      </span>
    </div>
  );
}

// ── C2/G6 — attestation bracket (pending state) ─────────────────────────────

function BoundsSection({ bounds }: { bounds: NonNullable<PaymentAttestation["bounds"]> }) {
  const { t } = useI18n();
  const kind = (isAttestation: boolean) => (isAttestation ? "attestation" : "checkpoint");
  return (
    <div className="mt-2 rounded-lg border border-border/50 bg-surface/40 px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
        <Clock3 className="h-3 w-3 text-warning/70" />
        {t("payments.attestBoundsTitle")}
      </div>
      <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px] text-muted">
        <span className="rounded-md border border-border/60 bg-surface px-1.5 py-0.5">
          #{bounds.parentHeight.toLocaleString()}
        </span>
        <ArrowRight className="h-3 w-3 shrink-0 text-muted-2" />
        {bounds.childHeight > 0 ? (
          <span className="rounded-md border border-border/60 bg-surface px-1.5 py-0.5">
            #{bounds.childHeight.toLocaleString()}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-md border border-dashed border-warning/30 px-1.5 py-0.5 text-warning/80">
            <Clock3 className="h-2.5 w-2.5" />
            {t("payments.attestBoundsPending")}
          </span>
        )}
        <span
          className={cn(
            "ml-auto rounded-full border px-1.5 py-px text-[9px] font-medium uppercase tracking-wide",
            bounds.isAttested
              ? "border-success/30 bg-success/10 text-success"
              : "border-warning/30 bg-warning/10 text-warning",
          )}
        >
          {bounds.isAttested
            ? t("payments.attestBoundsAttested")
            : t("payments.attestBoundsPending")}
        </span>
      </div>
      {bounds.childHeight > 0 ? (
        <p className="mt-1 text-[10px] leading-relaxed text-muted-2">
          {t("payments.attestBoundsLine", {
            parent: bounds.parentHeight.toLocaleString(),
            parentKind: kind(bounds.parentIsAttestation),
            child: bounds.childHeight.toLocaleString(),
            childKind: kind(bounds.childIsAttestation),
          })}
        </p>
      ) : (
        <p className="mt-1 text-[10px] leading-relaxed text-muted-2">
          {t("payments.attestBoundsParentOnly", {
            parent: bounds.parentHeight.toLocaleString(),
            parentKind: kind(bounds.parentIsAttestation),
          })}
        </p>
      )}
      {!bounds.isAttested ? (
        <p className="mt-0.5 text-[10px] leading-relaxed text-muted-3">
          {t("payments.attestEtaNote")}
        </p>
      ) : null}
    </div>
  );
}

/** The Creditcoin chain's own verdict on the proof (read-only precompile call). */
function OnchainVerdictRow({ onchain }: { onchain: NonNullable<PaymentAttestation["onchain"]> }) {
  const { t } = useI18n();
  const { timeAgo } = useFormatters();
  return (
    <div
      className={cn(
        "mt-1 flex items-start gap-2 rounded-lg border px-2.5 py-2",
        onchain.verified
          ? "border-success/25 bg-gradient-to-r from-success/10 via-success/5 to-transparent"
          : "border-border bg-surface/50",
      )}
      title={onchain.precompile}
    >
      <BadgeCheck
        className={cn(
          "mt-0.5 h-4 w-4 shrink-0",
          onchain.verified ? "text-success" : "text-muted-2",
        )}
      />
      <div className="min-w-0">
        <p className="text-[11px] font-medium leading-tight text-foreground">
          {onchain.verified ? t("payments.attestOnchainPassed") : t("payments.attestOnchainUnknown")}
        </p>
        <p className="mt-0.5 font-mono text-[10px] leading-tight text-muted-2">
          {t("payments.attestOnchainHow", {
            precompile: shortenHex(onchain.precompile, 8, 4),
            time: timeAgo(onchain.verifiedAt),
          })}
        </p>
      </div>
    </div>
  );
}

/** Receipt shown once a signed on-chain submission exists (cc3TxHash on record). */
function SubmittedReceipt({
  cc3TxHash,
  event,
  gasUsed,
  env,
}: {
  cc3TxHash: string;
  event?: { chainKey: number; height: number; transactionIndex: number } | null;
  gasUsed?: number | null;
  env?: string;
}) {
  const { t } = useI18n();
  return (
    <div className="mt-2 space-y-0.5 rounded-lg border border-primary/25 border-l-2 border-l-primary/60 bg-gradient-to-r from-primary/10 to-transparent px-3 py-2">
      <div className="flex items-center gap-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-primary">
        <Landmark className="h-3 w-3" />
        {t("payments.submitDone")}
      </div>
      <div className="flex items-center justify-between gap-3 py-1">
        <span className="shrink-0 text-[11px] text-muted-2">{t("payments.submitCc3Tx")}</span>
        <span className="flex min-w-0 items-center gap-1.5">
          <CopyableHash value={cc3TxHash} label={t("payments.submitCc3Tx")} />
          {(() => {
            // N27.1: the CC3 receipt is deep-linkable to the environment's
            // Blockscout explorer — every record viewable, not just copyable.
            const cc3Url = cc3ExplorerTxUrl(env, cc3TxHash);
            if (!cc3Url) return null;
            return (
              <a
                href={cc3Url}
                target="_blank"
                rel="noopener noreferrer"
                title={t("actions.cc3ExplorerTip")}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-primary/70 transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
              >
                <ExternalLink className="h-3 w-3" aria-hidden />
                <span className="sr-only">{t("actions.cc3ExplorerTip")}</span>
              </a>
            );
          })()}
        </span>
      </div>
      {event ? (
        <ProofDetailRow
          label={t("payments.submitEvent")}
          value={`chainKey ${event.chainKey} · block ${event.height.toLocaleString()} · index ${event.transactionIndex}`}
        />
      ) : null}
      {gasUsed != null ? (
        <ProofDetailRow label={t("payments.submitGas")} value={gasUsed.toLocaleString()} />
      ) : null}
      {env ? (
        <ProofDetailRow label={t("payments.submitNetwork")} value={env} />
      ) : null}
    </div>
  );
}

interface SubmitSectionProps {
  paymentId: string;
  submissionConfigured: boolean | undefined;
  alreadySubmittedCc3Tx: string | null;
}

function SubmitSection({ paymentId, submissionConfigured, alreadySubmittedCc3Tx }: SubmitSectionProps) {
  const { t } = useI18n();
  const submit = useSubmitAttestation();
  // Stable reference (same pattern as the verify mutation) so effects that
  // depend on it don't re-fire on every state change.
  const { mutate: submitProof } = submit;

  const onSubmit = useCallback(() => {
    submitProof(paymentId);
  }, [submitProof, paymentId]);

  const result = submit.data;
  const submittedCc3 =
    alreadySubmittedCc3Tx ?? (submit.isSuccess && result?.ok ? (result.cc3TxHash ?? null) : null);

  // ── Not configured: guidance instead of a dead button ──
  if (submissionConfigured === false) {
    return (
      <div className="mt-2 rounded-lg border border-dashed border-border bg-surface/40 px-3 py-2">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
          <KeyRound className="h-3 w-3" />
          {t("payments.submitNotConfigured")}
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-2">
          {t("payments.submitHint", { env: "CREDITCOIN_SIGNER_KEY" })}
        </p>
      </div>
    );
  }

  // ── Submission receipt (already on record or just performed) ──
  if (submittedCc3) {
    return (
      <SubmittedReceipt
        cc3TxHash={submittedCc3}
        event={result?.event}
        gasUsed={result?.gasUsed}
        env={result?.env}
      />
    );
  }

  // ── Actionable submit button ──
  return (
    <div className="mt-1">
      <Button
        variant="secondary"
        size="sm"
        className={cn(
          "h-7 gap-1.5 text-xs",
          "border-primary/30 text-primary hover:border-primary/50 hover:bg-primary/10",
        )}
        onClick={onSubmit}
        disabled={submit.isPending}
        title={t("payments.submitTitle")}
      >
        {submit.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
        {submit.isPending ? t("payments.submitting") : t("payments.submitTitle")}
      </Button>
      {submit.isError ? (
        <p className="mt-1 flex items-center gap-1 text-[11px] text-danger">
          <ShieldAlert className="h-3 w-3 shrink-0" />
          <span className="truncate">
            {submit.error instanceof Error ? submit.error.message : t("payments.submitError")}
          </span>
        </p>
      ) : null}
      {submit.isSuccess && result && !result.ok && result.status === 501 ? (
        <p className="mt-1 wrap-anywhere break-words text-[11px] leading-relaxed text-muted-2">{result.hint}</p>
      ) : null}
      {submit.isSuccess && result && !result.ok && result.status !== 501 ? (
        <p className="mt-1 wrap-anywhere break-words text-[11px] leading-relaxed text-danger">
          {result.detail ?? result.error ?? t("payments.submitError")}
        </p>
      ) : null}
    </div>
  );
}

function PhaseNote() {
  const { t } = useI18n();
  return (
    <p className="mt-1.5 flex items-start gap-1.5 text-[10px] leading-relaxed text-muted-3">
      <Hexagon className="mt-0.5 h-3 w-3 shrink-0 text-primary/50" />
      <span>{t("payments.attestPhaseNote")}</span>
    </p>
  );
}

export const PaymentAttestationCard = memo(function PaymentAttestationCard({
  paymentId,
  txHash,
  serverAttestedAt,
  serverCc3TxHash,
  paymentContext,
}: {
  paymentId: string;
  txHash: string;
  /** Set when the server-side poller already flipped this payment to attested. */
  serverAttestedAt?: number | null;
  /** Creditcoin tx hash already on record for this payment's proof submission. */
  serverCc3TxHash?: string | null;
  /** Payment metadata embedded in the exported JSON certificate. */
  paymentContext?: AttestExportContext;
}) {
  const { t } = useI18n();
  const { formatFullDate } = useFormatters();
  const attestation = useAttestPayment();
  // Stable reference from TanStack — depending on the whole useMutation result
  // object would re-fire the auto-verify effect on every state change (infinite loop).
  const { mutate: fetchAttestation } = attestation;
  const [qrOpen, setQrOpen] = useState(false);

  const verify = useCallback(() => {
    attestation.mutate(paymentId);
  }, [attestation, paymentId]);

  // The poller already saw a proof for this tx — fetch the details right away
  // so the receipt renders without waiting for a manual "Verify" click.
  useEffect(() => {
    if (serverAttestedAt) fetchAttestation(paymentId);
  }, [serverAttestedAt, paymentId, fetchAttestation]);

  const result = attestation.data;
  const hasResult = attestation.isSuccess && result !== undefined;
  const dashboard =
    result?.network?.env && DASHBOARD_URLS[result.network.env]
      ? DASHBOARD_URLS[result.network.env]
      : DASHBOARD_URLS.testnet;

  // ── Proof certificate export (client-side JSON download) ──
  // Bundles the payment summary, the Merkle + continuity proof, the Creditcoin
  // chain's own on-chain verdict, and the network snapshot into a portable
  // audit artifact. The raw proof payload (txBytes + Merkle siblings +
  // continuity roots) is fetched on demand via ?include=raw so the certificate
  // is REPLAYABLE — a third party can re-run the on-chain verification
  // themselves with the verifier tool.
  const exportCertificate = useCallback(async () => {
    if (!hasResult || result.state !== "proof" || !result.proof) return;
    // Fetch the replayable proof payload (degrades to summary-only if it fails).
    let rawProof: { chainKey: number; headerNumber: number; txBytes: string; merkleProof: unknown; continuityProof: unknown } | null = null;
    try {
      const res = await fetch(`/api/payments/${paymentId}/attestcoin?include=raw`, { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { rawProof?: typeof rawProof };
        rawProof = data.rawProof ?? null;
      }
    } catch {
      rawProof = null;
    }
    const certificate = {
      schema: "acp.attestation-certificate/v1",
      exportedAt: new Date().toISOString(),
      payment: paymentContext
        ? {
            id: paymentId,
            recipient: paymentContext.recipient,
            recipientLabel: paymentContext.recipientLabel ?? null,
            sender: paymentContext.senderAddress ?? null,
            token: paymentContext.token,
            amountHuman: paymentContext.amountHuman,
            memo: paymentContext.memo ?? null,
            chainId: paymentContext.chainId,
            createdAt: paymentContext.createdAt,
            settledAt: paymentContext.settledAt,
            attestedAt: serverAttestedAt ?? null,
          }
        : { id: paymentId },
      source: {
        chain: result.chain.name,
        chainKey: result.chain.chainKey,
        evmChainId: result.chain.evmChainId,
        txHash: result.txHash,
      },
      proof: {
        headerNumber: result.proof.headerNumber,
        transactionIndex: result.proof.txIndex,
        merkleRoot: result.proof.merkleRoot,
        merkleSiblings: result.proof.merkleSiblings,
        continuityRoots: result.proof.continuityRoots,
        continuityLowerEndpoint: result.proof.continuityLowerEndpoint,
        generatedAt: result.proof.generatedAt,
        servedFromCache: result.proof.cached,
        // Replayable proof objects — present when the ?include=raw fetch above
        // succeeded. This is what the certificate verifier re-submits to the
        // Block Prover Precompile.
        ...(rawProof ? { raw: rawProof } : {}),
      },
      onchain: result.onchain
        ? {
            verified: result.onchain.verified,
            transactionIndex: result.onchain.txIndex,
            precompile: result.onchain.precompile,
            verifiedAt: new Date(result.onchain.verifiedAt).toISOString(),
          }
        : null,
      network: result.network ?? null,
      creditcoinSubmission: serverCc3TxHash ? { cc3TxHash: serverCc3TxHash } : null,
    };
    const blob = new Blob([JSON.stringify(certificate, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `attestation-${paymentId}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, [hasResult, result, paymentId, paymentContext, serverAttestedAt, serverCc3TxHash]);

  const pillState: PaymentAttestation["state"] | "loading" = attestation.isPending
    ? "loading"
    : hasResult
      ? result.state
      : serverAttestedAt
        ? "loading"
        : "proof";

  return (
    <div
      className="rounded-xl border border-border bg-surface/40 p-3 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.02)]"
      title={txHash}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
          <Hexagon className="h-3 w-3 text-primary" />
          {t("payments.attestTitle")}
        </div>
        {hasResult || attestation.isPending || serverAttestedAt ? (
          <AttestStatePill state={pillState} />
        ) : null}
      </div>

      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-2">
        {t("payments.attestDesc")}
      </p>

      {attestation.isError ? (
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-danger">
          <ShieldAlert className="h-3 w-3 shrink-0" />
          <span className="truncate">
            {attestation.error instanceof Error ? attestation.error.message : t("payments.attestError")}
          </span>
        </div>
      ) : null}

      {hasResult && result.state === "proof" && result.proof ? (
        <div className="mt-2.5 rounded-lg border border-success/20 border-l-2 border-l-success/60 bg-gradient-to-r from-success/5 to-transparent px-3 py-2">
          <div className="divide-y divide-border/25">
            <ProofDetailRow
              label={t("payments.attestHeaderBlock")}
              value={`#${result.proof.headerNumber.toLocaleString()}`}
            />
            {serverAttestedAt ? (
              <ProofDetailRow
                label={t("payments.attestRecordedAt")}
                value={formatFullDate(serverAttestedAt)}
              />
            ) : null}
            <ProofDetailRow
              label={t("payments.attestTxIndex")}
              value={String(result.proof.txIndex)}
            />
            <div className="flex items-center justify-between gap-3 py-1.5">
              <span className="shrink-0 text-[11px] text-muted-2">{t("payments.attestMerkleRoot")}</span>
              <CopyableHash value={result.proof.merkleRoot} label={t("payments.attestMerkleRoot")} />
            </div>
            <ProofDetailRow
              label={t("payments.attestContinuity")}
              value={t("payments.attestContinuityValue", { roots: result.proof.continuityRoots })}
            />
            {result.cost ? <CostRow cost={result.cost} /> : null}
          </div>

          {result.decoded ? <DecodedTxSection decoded={result.decoded} /> : null}

          {result.onchain ? <OnchainVerdictRow onchain={result.onchain} /> : null}

          <div className="flex items-center justify-between gap-2 pt-2">
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-2">
              {result.proof.cached ? (
                <>
                  <Database className="h-3 w-3" />
                  {t("payments.attestFromCache")}
                </>
              ) : null}
            </span>
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => {
                  void exportCertificate();
                }}
                className="inline-flex items-center gap-1 rounded-sm text-[11px] text-muted-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                title={t("payments.exportProofTitle")}
              >
                <FileDown className="h-3 w-3" />
                {t("payments.exportProof")}
              </button>
              {hasResult && result.state === "proof" && result.proof && result.network ? (
                <ShareQrButton
                  onClick={() => {
                    setQrOpen(true);
                  }}
                />
              ) : null}
              <a
                href={dashboard}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-primary transition-colors hover:underline"
              >
                {t("payments.attestViewDashboard")}
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </div>
        </div>
      ) : null}

      {hasResult && result.state === "pending" ? (
        <div className="mt-2.5 rounded-lg border border-warning/20 bg-warning/5 px-3 py-2">
          <p className="text-[11px] leading-relaxed text-warning">
            {t("payments.attestPendingDesc")}
          </p>
          {result.network?.attestedHeight !== null && result.network?.attestedHeight !== undefined ? (
            <p className="mt-1 font-mono text-[10px] text-muted-2">
              {t("payments.attestNetworkLine", {
                chain: result.chain.name,
                height: result.network.attestedHeight.toLocaleString(),
              })}
            </p>
          ) : null}
          {result.bounds ? <BoundsSection bounds={result.bounds} /> : null}
        </div>
      ) : null}

      {hasResult && (result.state === "unknown_tx" || result.state === "error") ? (
        <div className="mt-2.5 rounded-lg border border-warning/20 bg-warning/5 px-3 py-2">
          <p className="text-[11px] leading-relaxed text-muted">
            {result.state === "unknown_tx"
              ? t("payments.attestUnknownTxDesc")
              : (result.detail ?? t("payments.attestErrorDesc"))}
          </p>
        </div>
      ) : null}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={verify}
          disabled={attestation.isPending}
          title={t("payments.attestVerify")}
        >
          {attestation.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <ShieldCheck className="h-3 w-3" />
          )}
          {attestation.isPending ? t("payments.attestVerifying") : t("payments.attestVerify")}
        </Button>
      </div>

      {hasResult && result.state === "proof" ? (
        <SubmitSection
          paymentId={paymentId}
          submissionConfigured={result.submission?.configured}
          alreadySubmittedCc3Tx={serverCc3TxHash ?? null}
        />
      ) : null}

      {qrOpen && hasResult && result.state === "proof" && result.proof && result.network ? (
        <AttestationQrModal
          attestRef={{
            chainKey: result.chain.chainKey,
            chainName: result.chain.name,
            txHash: result.txHash,
            merkleRoot: result.proof.merkleRoot,
            headerNumber: result.proof.headerNumber,
            txIndex: result.proof.txIndex,
            env: result.network.env,
          } satisfies AttestationRef}
          onClose={() => setQrOpen(false)}
        />
      ) : null}

      <div className="mt-1">
        <PhaseNote />
      </div>
    </div>
  );
});
