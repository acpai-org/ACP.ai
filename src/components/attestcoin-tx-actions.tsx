"use client";

// ─────────────────────────────────────────────────────────────────────────────
// AC11 (Task 8) — Deliverable 1: the per-message Attestcoin action row.
//
// Rendered inside ASSISTANT message bubbles (chat-message.tsx) whenever the
// message's agent trace carries a tx on a tracked Attestcoin SOURCE chain
// (Sepolia 11155111 / Ethereum 1). Three ghost buttons, all NATIVE (direct
// /api/attestcoin/* calls — no LLM round-trip):
//
//   • Verify on Attestcoin → GET /api/attestcoin/proof → inline state card
//     (attested / pending / unknown tx + block, merkle root, continuity
//      roots, estimated verify cost, on-chain precompile verdict)
//   • Proof → expands the full proof details card (root + block + index +
//     roots + explorer/dashboard/CC3 links, copy buttons)
//   • Certificate → downloads the acp.attestation-certificate/v1 JSON via
//     GET /api/attestcoin/certificate?type=action&id=…, resolving the action
//     row id by txHash from the merged recent-attestations feed (AC8)
//
// The AttestProofCard + CopyValue below are shared with the composer
// quick-check popover (src/components/attestcoin-quick-check.tsx).
// ─────────────────────────────────────────────────────────────────────────────

import { memo, useCallback, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  Copy,
  ExternalLink,
  FileDown,
  Hexagon,
  Layers,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import type { ChatMessageData } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { useFormatters } from "@/lib/use-formatters";
import { AttestStatePill } from "@/components/attest-state-pill";
import { ChainIcon } from "@/components/chain-icon";
import { sourceExplorerTxUrl, cc3ExplorerTxUrl } from "@/lib/attestcoin/cc3-links";
import {
  extractTrackedTxs,
  fetchTxProof,
  proofCostLabel,
  downloadActionCertificate,
  fetchRecentActionRows,
  matchActionRowByTx,
  type AttestProofData,
  type RecentActionFeedRow,
} from "@/lib/chat/attest-tx";
import { cn } from "@/lib/utils";

/** Compact copy-to-clipboard chip (S9 pattern: 28px visual + hit-slop —
 * matches the actions-view CopyRef idiom for inline hash/root copies). */
export function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard?.writeText(value).catch(() => {});
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      }}
      className="hit-slop inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-3 transition-colors hover:bg-foreground/[0.07] hover:text-foreground/75 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
    >
      {copied ? <Check className="h-3 w-3 text-success" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
    </button>
  );
}

function shortHash(h: string): string {
  return `${h.slice(0, 10)}…${h.slice(-6)}`;
}

interface AttestProofCardProps {
  data: AttestProofData;
  txHash: string;
  chainId: number;
  /** Step-carried explorer URL (falls back to the chain registry). */
  explorerUrl?: string;
  /** CC3 submission tx hash when the recent feed matched this action. */
  cc3TxHash?: string | null;
  /** Expanded mode adds the full proof details + links row (Proof button). */
  expanded?: boolean;
}

/**
 * Shared proof result card — the SAME rendering for the chat action row and
 * the composer quick-check popover, so the attestation language stays
 * app-wide consistent (AttestStatePill for state, ctcLabel for cost).
 */
export function AttestProofCard({ data, txHash, chainId, explorerUrl, cc3TxHash, expanded = false }: AttestProofCardProps) {
  const { t } = useI18n();
  const { timeAgo } = useFormatters();
  const proof = data.state === "proof" ? data.proof : undefined;
  const costLabel = proofCostLabel(data);
  const srcUrl = explorerUrl ?? sourceExplorerTxUrl(chainId, txHash) ?? undefined;
  const cc3Url = cc3TxHash ? cc3ExplorerTxUrl(data.env, cc3TxHash) : null;
  const stale = data.cost?.stale === true;

  return (
    <div
      aria-live="polite"
      className="rounded-xl border border-border/60 bg-surface-2/30 p-2.5 text-[11px] leading-relaxed text-muted"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <AttestStatePill state={data.state} size="xs" />
        <span className="inline-flex items-center gap-1 text-muted-2">
          <ChainIcon chainId={data.chain.evmChainId} size={12} />
          {data.chain.name}
        </span>
        <span
          className={cn(
            "rounded-full border px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide",
            data.env === "mainnet" ? "border-primary/30 bg-primary/10 text-primary" : "border-border bg-surface-3 text-muted-2",
          )}
        >
          {data.env === "mainnet" ? t("wallet.creditcoinMainnet") : t("wallet.creditcoinTestnet")}
        </span>
        <span className="ml-auto text-muted-3" title={new Date(data.fetchedAt).toISOString()}>
          {timeAgo(data.fetchedAt)}
        </span>
      </div>

      {proof ? (
        <div className="mt-1.5 space-y-1">
          <p className="tabular-nums text-foreground/70">
            {t("chat.attest.blockInfo", { block: proof.headerNumber.toLocaleString(), index: proof.txIndex })}
          </p>
          <p className="flex min-w-0 items-center gap-0.5 font-mono text-foreground/60">
            <span className="truncate" title={proof.merkleRoot}>
              ⬡ {proof.merkleRoot.slice(0, 10)}…{proof.merkleRoot.slice(-8)}
            </span>
            <CopyValue value={proof.merkleRoot} label={t("chat.attest.merkleRoot")} />
          </p>
          <p className="tabular-nums text-muted-2">
            {t("chat.attest.roots", { count: proof.continuityRoots })}
            {costLabel ? <span className="ml-2 text-primary/80">{costLabel}</span> : null}
            {stale ? <span className="ml-2 text-warning">{t("chat.attest.staleWarning")}</span> : null}
          </p>
          {data.onchain ? (
            <p className={data.onchain.verified ? "text-success" : "text-muted-2"}>
              {data.onchain.verified ? `✓ ${t("actions.onchainVerified")}` : t("chat.attest.onchainUnverified")}
            </p>
          ) : null}
          {expanded ? (
            <>
              <p className="tabular-nums text-muted-2">{t("chat.attest.siblings", { count: proof.merkleSiblings })}</p>
              {proof.continuityLowerEndpoint ? (
                <p className="flex min-w-0 items-center gap-0.5 font-mono text-muted-3">
                  <span className="truncate" title={proof.continuityLowerEndpoint}>
                    ⧉ {proof.continuityLowerEndpoint.slice(0, 10)}…{proof.continuityLowerEndpoint.slice(-8)}
                  </span>
                  <CopyValue value={proof.continuityLowerEndpoint} label={t("chat.attest.endpoint")} />
                </p>
              ) : null}
              {proof.generatedAt ? (
                <p className="text-muted-3">
                  {proof.cached ? t("chat.attest.cached") : t("chat.attest.fresh")}
                  <time dateTime={proof.generatedAt}> · {timeAgo(Date.parse(proof.generatedAt) || data.fetchedAt)}</time>
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : data.bounds ? (
        <p className="mt-1.5 tabular-nums text-muted-2">
          {t("chat.attest.bounds", { from: data.bounds.parentHeight.toLocaleString(), to: data.bounds.childHeight.toLocaleString() })}
        </p>
      ) : null}

      {expanded ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex min-w-0 items-center gap-0.5 font-mono text-muted-2">
            <span className="truncate" title={txHash}>
              {shortHash(txHash)}
            </span>
            <CopyValue value={txHash} label={t("trace.copy")} />
          </span>
          {srcUrl ? (
            <a
              href={srcUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 text-primary/80 transition-colors hover:text-primary"
            >
              <ExternalLink className="h-2.5 w-2.5" aria-hidden />
              {t("trace.explorer")}
            </a>
          ) : null}
          {data.dashboard ? (
            <a
              href={data.dashboard}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 text-primary/80 transition-colors hover:text-primary"
            >
              <ExternalLink className="h-2.5 w-2.5" aria-hidden />
              {t("trace.dashboard")}
            </a>
          ) : null}
          {cc3Url ? (
            <a
              href={cc3Url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 text-primary/80 transition-colors hover:text-primary"
            >
              <ExternalLink className="h-2.5 w-2.5" aria-hidden />
              {t("chat.attest.cc3Submission")}
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Error line for a failed lookup — honest message + retry (AC11: never swallow). */
export function AttestErrorLine({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-danger/30 bg-danger/10 p-2.5 text-[11px] text-danger">
      <span className="min-w-0 flex-1 break-words">{t("chat.attest.errorHint")} — {message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="hit-slop inline-flex h-8 cursor-pointer items-center rounded-lg px-2 text-[11px] font-medium text-danger transition-colors hover:bg-danger/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-danger/60"
      >
        {t("chat.attest.retry")}
      </button>
    </div>
  );
}

// ── Per-tx state ─────────────────────────────────────────────────────────────

type VerifyState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "done"; data: AttestProofData }
  | { phase: "error"; message: string };

type CertState =
  | { phase: "idle" }
  | { phase: "downloading" }
  | { phase: "done"; filename: string }
  | { phase: "not_found" }
  | { phase: "error"; message: string };

const GHOST_BTN =
  "hit-slop inline-flex h-8 cursor-pointer items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-muted-2 transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-2";

const TxAttestRow = memo(function TxAttestRow({ txHash, chainId, explorerUrl }: { txHash: string; chainId: number; explorerUrl?: string }) {
  const { t } = useI18n();
  const [verify, setVerify] = useState<VerifyState>({ phase: "idle" });
  const [proofOpen, setProofOpen] = useState(false);
  /** undefined = feed not fetched yet; null = fetched, no matching row. */
  const [feedRow, setFeedRow] = useState<RecentActionFeedRow | null | undefined>(undefined);
  const [cert, setCert] = useState<CertState>({ phase: "idle" });

  const runVerify = useCallback(async () => {
    setVerify({ phase: "checking" });
    setCert({ phase: "idle" });
    try {
      const data = await fetchTxProof(txHash, chainId);
      setVerify({ phase: "done", data });
    } catch (err) {
      setVerify({ phase: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [txHash, chainId]);

  /**
   * Lazily resolve the recent-feed action row for this tx — needed for BOTH
   * the certificate download (row id) and the CC3 submission link (cc3TxHash).
   * One fetch, cached in component state; failures degrade to null (links
   * hidden, certificate reports "not found") rather than throwing.
   */
  const ensureFeedRow = useCallback(async (): Promise<RecentActionFeedRow | null> => {
    if (feedRow !== undefined) return feedRow;
    try {
      const rows = await fetchRecentActionRows();
      const match = matchActionRowByTx(rows, txHash);
      setFeedRow(match);
      return match;
    } catch {
      setFeedRow(null);
      return null;
    }
  }, [feedRow, txHash]);

  const handleProof = useCallback(() => {
    // No data yet → fetch first (the details card needs the proof), then open.
    if (verify.phase === "idle" || verify.phase === "error") {
      void runVerify();
    }
    setProofOpen((v) => !v);
    void ensureFeedRow();
  }, [verify.phase, runVerify, ensureFeedRow]);

  /**
   * Certificate download: only meaningful once the verify click proved the tx
   * attested (button disabled otherwise). The message doesn't know the action
   * row id, so it is resolved by txHash from the merged recent-attestations
   * feed (AC8) and the certificate fetched via type=action&id. Not found →
   * honest inline note (the feed window is 6 rows; older attestations won't
   * match). Payment certificates are NOT reachable here — payment feed rows
   * carry no txHash to match on (they're exported from the Actions page).
   */
  const handleCertificate = useCallback(async () => {
    if (cert.phase === "downloading") return;
    setCert({ phase: "downloading" });
    const row = await ensureFeedRow();
    if (!row) {
      setCert({ phase: "not_found" });
      return;
    }
    const outcome = await downloadActionCertificate(row.id);
    if (outcome.ok) setCert({ phase: "done", filename: outcome.filename });
    else if (outcome.reason === "not_found") setCert({ phase: "not_found" });
    else setCert({ phase: "error", message: outcome.message ?? "HTTP error" });
  }, [cert.phase, ensureFeedRow]);

  const attested = verify.phase === "done" && verify.data.state === "proof";
  const verifying = verify.phase === "checking";
  const certDisabled = !attested || cert.phase === "downloading";

  return (
    <div className="flex flex-col gap-1.5">
      <div role="group" aria-label={t("chat.attest.title")} className="flex flex-wrap items-center gap-1">
        <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-muted-2">
          <Hexagon className="h-3 w-3 text-primary/70" aria-hidden />
          <ChainIcon chainId={chainId} size={12} />
          <span className="font-mono" title={txHash}>
            {shortHash(txHash)}
          </span>
        </span>
        <button type="button" onClick={() => void runVerify()} className={GHOST_BTN} title={t("chat.attest.verifyTip")}>
          {verifying ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
          )}
          {verifying ? t("payments.attestVerifying") : t("chat.attest.verify")}
        </button>
        <button
          type="button"
          onClick={handleProof}
          aria-expanded={proofOpen}
          className={GHOST_BTN}
          title={t("chat.attest.proofTip")}
        >
          <Layers className="h-3.5 w-3.5" aria-hidden />
          {t("chat.attest.proof")}
        </button>
        <button
          type="button"
          onClick={() => void handleCertificate()}
          disabled={certDisabled}
          className={GHOST_BTN}
          title={attested ? t("chat.attest.certificateTip") : t("chat.attest.certificatePending")}
          aria-disabled={certDisabled}
        >
          {cert.phase === "downloading" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <FileDown className="h-3.5 w-3.5" aria-hidden />
          )}
          {t("chat.attest.certificate")}
        </button>
      </div>

      <AnimatePresence initial={false}>
        {verify.phase === "done" || verify.phase === "error" ? (
          <motion.div
            key="verify-result"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            {verify.phase === "done" ? (
              <AttestProofCard
                data={verify.data}
                txHash={txHash}
                chainId={chainId}
                explorerUrl={explorerUrl}
                cc3TxHash={feedRow?.cc3TxHash ?? null}
                expanded={proofOpen}
              />
            ) : (
              <AttestErrorLine message={verify.message} onRetry={() => void runVerify()} />
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>

      {cert.phase !== "idle" && cert.phase !== "downloading" ? (
        <p
          role="status"
          className={cn(
            "text-[10.5px]",
            cert.phase === "done" ? "text-success" : cert.phase === "not_found" ? "text-warning" : "text-danger",
          )}
        >
          {cert.phase === "done"
            ? `✓ ${t("chat.attest.certificateDone")} (${cert.filename})`
            : cert.phase === "not_found"
              ? t("chat.attest.certificateMissing")
              : `${t("chat.attest.errorHint")} — ${cert.message}`}
        </p>
      ) : null}
    </div>
  );
});

/**
 * The per-message Attestcoin action row. Renders nothing unless the message's
 * trace carries a tracked source-chain tx. Hidden while the message streams
 * (the tx set can still change; the row is a post-completion affordance).
 */
export function AttestcoinTxActions({ message }: { message: ChatMessageData }) {
  // Post-completion affordance only: while the message streams the tx set is
  // still mutating (steps landing), and the parent renders nothing for user
  // messages anyway. Early-exit keeps the extraction off the hot path.
  if (message.streaming) return null;
  const txs = extractTrackedTxs(message);
  if (txs.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 pt-0.5">
      {txs.map((tx) => (
        <TxAttestRow key={`${tx.txHash.toLowerCase()}:${tx.chainId}`} txHash={tx.txHash} chainId={tx.chainId} explorerUrl={tx.explorerUrl} />
      ))}
    </div>
  );
}
