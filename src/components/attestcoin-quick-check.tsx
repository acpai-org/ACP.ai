"use client";

// ─────────────────────────────────────────────────────────────────────────────
// AC11 (Task 8) — Deliverable 2: the composer's "Attestcoin" quick-action.
//
// A hexagon trigger next to the chat composer opens a compact popover with
// NATIVE attestation tools (direct /api/attestcoin/* calls — never routed
// through the agent):
//   • live network glance (attested height vs head per chain + CC3 block,
//     lag in the app's severity color language)
//   • tx hash + chain input → Check attestation (proof lookup, the SAME
//     result card as the per-message action row)
//   • Estimate verify cost (proof route's cost fields, local formula fallback)
//   • Verify certificate (paste an exported certificate JSON → live verdict)
// The hash input is pre-filled with the chat's latest assistant source-chain
// tx — one click from "just sent" to "is it attested?".
//
// Overlay contract mirrors the repo's popover patterns: fixed-position portal,
// Escape closes from any focus state (command-palette N11), outside mousedown
// closes (ai-provider-button), role="dialog", trigger carries aria-expanded.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import Link from "next/link";
import { ArrowRight, Check, FileBadge, Hexagon, Loader2, ShieldCheck, Coins, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n/types";
import { lagSeverity, type AttestcoinStatusData } from "@/lib/use-attestcoin";
import { getChainByChainId } from "@/lib/chains/registry";
import { ChainIcon } from "@/components/chain-icon";
import { AttestProofCard, AttestErrorLine, CopyValue } from "@/components/attestcoin-tx-actions";
import {
  ATTEST_SOURCE_CHAIN_OPTIONS,
  fetchTxProof,
  proofCostLabel,
  verifyCertificate,
  type AttestProofData,
  type CertificateVerdict,
} from "@/lib/chat/attest-tx";
import { cn } from "@/lib/utils";

interface AttestcoinQuickCheckProps {
  /** Latest tracked source-chain tx from the chat's LAST assistant message.
   * Pre-fills the hash + chain the moment the popover opens. */
  prefill?: { txHash: string; chainId: number } | null;
}

const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;
const DEFAULT_CHAIN_ID = 11155111;

type StatusState =
  | { phase: "loading" }
  | { phase: "ready"; data: AttestcoinStatusData }
  | { phase: "error" };

type CheckState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "done"; data: AttestProofData }
  | { phase: "error"; message: string };

type EstimateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "done"; label: string; roots: number | null; stale: boolean }
  | { phase: "unavailable" }
  | { phase: "error"; message: string };

type CertState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "done"; verdict: CertificateVerdict }
  | { phase: "error"; message: string };

/** Lag severity → the app's semantic colors (wallet panel language). */
const LAG_CLS: Record<"fresh" | "delayed" | "stale" | "unknown", string> = {
  fresh: "text-success",
  delayed: "text-warning",
  stale: "text-danger",
  unknown: "text-muted-3",
};

function num(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString();
}

const CHECK_ID_KEYS: Record<CertificateVerdict["checks"][number]["id"], TranslationKey> = {
  schema: "chat.attest.checkSchema",
  consistency: "chat.attest.checkConsistency",
  builder: "chat.attest.checkBuilder",
  onchain: "chat.attest.checkOnchain",
  receipt: "chat.attest.checkReceipt",
};

function CheckStatusIcon({ status }: { status: "pass" | "fail" | "skip" }) {
  if (status === "pass") return <Check className="h-3 w-3 shrink-0 text-success" aria-hidden />;
  if (status === "fail") return <X className="h-3 w-3 shrink-0 text-danger" aria-hidden />;
  return <span className="h-3 w-3 shrink-0 text-center text-[9px] leading-3 text-muted-3" aria-hidden>–</span>;
}

export function AttestcoinQuickCheck({ prefill }: AttestcoinQuickCheckProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [txInput, setTxInput] = useState("");
  const [chainId, setChainId] = useState<number>(DEFAULT_CHAIN_ID);
  const [prefilled, setPrefilled] = useState(false);
  const [status, setStatus] = useState<StatusState>({ phase: "loading" });
  const [check, setCheck] = useState<CheckState>({ phase: "idle" });
  const [estimate, setEstimate] = useState<EstimateState>({ phase: "idle" });
  const [showCertInput, setShowCertInput] = useState(false);
  const [certText, setCertText] = useState("");
  const [cert, setCert] = useState<CertState>({ phase: "idle" });
  /** Popover position (fixed, portal) — computed in the open effect, never
   * during render. Null until the first recompute lands. */
  const [panelPos, setPanelPos] = useState<{ right: number; bottom: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const hashInputRef = useRef<HTMLInputElement>(null);

  const trimmed = txInput.trim();
  const validHash = TX_HASH_RE.test(trimmed);

  // ── Open/close plumbing ────────────────────────────────────────────────────
  const close = useCallback(() => {
    setOpen(false);
    // Soft reset of the transient result surfaces — the typed hash/chain stay
    // (a reopen shouldn't make the user re-paste), but stale verdicts and the
    // anchored position go (the open effect recomputes it from the trigger).
    setCheck({ phase: "idle" });
    setEstimate({ phase: "idle" });
    setCert({ phase: "idle" });
    setShowCertInput(false);
    setPanelPos(null);
  }, []);

  const openPopover = useCallback(() => {
    setOpen(true);
    setStatus((prev) => (prev.phase === "ready" ? prev : { phase: "loading" }));
    setPrefilled(false);
    // Auto-prefill: one click from "just sent" to "is it attested?" — only
    // when the user hasn't typed their own hash yet. (Direct setState — this
    // is a user event, not a render-phase transition.)
    if (!txInput.trim() && prefill) {
      setPrefilled(true);
      setChainId(prefill.chainId);
      setTxInput(prefill.txHash);
    }
    // Focus the hash input once the popover mounts (rAF — see model-picker).
    requestAnimationFrame(() => hashInputRef.current?.focus());
    // Live network glance: ONE status fetch per open (no interval — the
    // wallet panel owns continuous polling; this is a glance, not a monitor).
    void (async () => {
      try {
        const res = await fetch("/api/attestcoin/status", {
          cache: "no-store",
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setStatus({ phase: "ready", data: (await res.json()) as AttestcoinStatusData });
      } catch {
        setStatus((prev) => (prev.phase === "ready" ? prev : { phase: "error" }));
      }
    })();
  }, [prefill, txInput]);

  // Escape closes from ANY focus state (N11 overlay contract) — not only when
  // the hash input holds focus (e.g. after tabbing to a button inside).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Outside mousedown closes (ai-provider-button pattern).
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, close]);

  // S6 (model-picker pattern): the popover is a fixed-position portal — its
  // position must be (re)computed from the trigger's rect on open AND on
  // resize / visualViewport / any inner scroll (rAF-throttled), clamped to
  // the viewport, or a mobile keyboard or transcript scroll leaves it
  // floating away from its trigger. Ref reads live inside the effect (never
  // during render — react-hooks/refs).
  useEffect(() => {
    if (!open) return;
    const recompute = () => {
      const rect = btnRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPanelPos({
        right: Math.max(8, window.innerWidth - rect.right),
        bottom: Math.min(window.innerHeight - rect.top + 8, window.innerHeight - 8),
      });
    };
    recompute();
    let raf = 0;
    const scheduled = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        recompute();
      });
    };
    window.addEventListener("resize", scheduled);
    window.visualViewport?.addEventListener("resize", scheduled);
    // scroll events don't bubble — capture on window catches every inner scroller.
    window.addEventListener("scroll", scheduled, true);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", scheduled);
      window.visualViewport?.removeEventListener("resize", scheduled);
      window.removeEventListener("scroll", scheduled, true);
    };
  }, [open]);

  // ── Actions (all NATIVE — direct API calls, no agent round-trip) ───────────
  const runCheck = useCallback(async () => {
    if (!validHash) return;
    setCheck({ phase: "checking" });
    setEstimate({ phase: "idle" });
    try {
      const data = await fetchTxProof(trimmed, chainId);
      setCheck({ phase: "done", data });
    } catch (err) {
      setCheck({ phase: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [validHash, trimmed, chainId]);

  /**
   * Cost estimate: the proof route computes `cost` (server formula
   * 2.3e-5 + 2.9e-7 × roots) whenever it serves a proof — that value wins.
   * Without a proof there is nothing to price (roots are proof data), so we
   * say so honestly instead of inventing a number.
   */
  const runEstimate = useCallback(async () => {
    if (!validHash) return;
    setEstimate({ phase: "checking" });
    try {
      const data = await fetchTxProof(trimmed, chainId);
      if (data.state === "proof" && data.proof) {
        setEstimate({
          phase: "done",
          label: proofCostLabel(data) ?? "",
          roots: data.proof.continuityRoots,
          stale: data.cost?.stale === true,
        });
      } else {
        setEstimate({ phase: "unavailable" });
      }
    } catch (err) {
      setEstimate({ phase: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [validHash, trimmed, chainId]);

  const runCertVerify = useCallback(async () => {
    const text = certText.trim();
    if (!text) return;
    setCert({ phase: "checking" });
    try {
      const verdict = await verifyCertificate(text);
      setCert({ phase: "done", verdict });
    } catch (err) {
      setCert({ phase: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [certText]);

  const certJsonTouched = certText.trim().length > 0;
  let certJsonValid = true;
  try {
    if (certJsonTouched) JSON.parse(certText);
  } catch {
    certJsonValid = false;
  }

  // ── Trigger ────────────────────────────────────────────────────────────────
  const trigger = (
    <button
      ref={btnRef}
      type="button"
      onClick={() => (open ? close() : openPopover())}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={t("chat.attest.quickTrigger")}
      title={t("chat.attest.quickTrigger")}
      className={cn(
        "hit-slop flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl transition-all duration-200",
        "bg-primary/10 text-primary ring-1 ring-primary/25 hover:bg-primary/20 hover:ring-primary/40",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        open && "bg-primary/20 ring-primary/45",
      )}
    >
      <Hexagon className="h-[18px] w-[18px]" aria-hidden />
    </button>
  );

  if (!open || !panelPos) return trigger;

  // ── Popover (portal; anchored above the trigger like the model picker) ─────
  const style = panelPos;

  const popover = createPortal(
    <motion.div
      ref={panelRef}
      role="dialog"
      aria-label={t("chat.attest.quickTitle")}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      className="glass-dropdown fixed z-[401] flex max-h-[min(34rem,calc(100vh-2rem))] w-[min(24rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-border shadow-2xl"
      style={style}
    >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-border/40 px-3.5 py-2">
          <Hexagon className="h-3.5 w-3.5 text-primary" aria-hidden />
          <span className="text-[12px] font-semibold text-foreground">{t("chat.attest.quickTitle")}</span>
          {status.phase === "ready" ? (
            <span
              className={cn(
                "rounded-full border px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide",
                status.data.env === "mainnet"
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : "border-border bg-surface-3 text-muted-2",
              )}
            >
              {status.data.env === "mainnet" ? t("wallet.creditcoinMainnet") : t("wallet.creditcoinTestnet")}
            </span>
          ) : null}
          <button
            type="button"
            onClick={close}
            aria-label={t("chat.close")}
            className="hit-slop ml-auto flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-muted-2 transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        {/* Live network glance — one /api/attestcoin/status fetch per open */}
        <div className="border-b border-border/40 px-3.5 py-2">
          {status.phase === "loading" ? (
            <p className="flex items-center gap-1.5 text-[10.5px] text-muted-2">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              {t("payments.attestVerifying")}
            </p>
          ) : status.phase === "error" ? (
            <p className="text-[10.5px] text-muted-2">{t("chat.ctx.attestcoin.unavailable")}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-2">
              {status.data.chains.map((chain) => {
                const severity = lagSeverity(chain.lag);
                return (
                  <span
                    key={chain.chainKey}
                    className="inline-flex items-center gap-1 tabular-nums"
                    title={`${chain.name}: ${t("wallet.attestAttestedHeight")} ${num(chain.attestedHeight)} / ${t("wallet.attestSourceHead")} ${num(chain.sourceHead)}`}
                  >
                    <ChainIcon chainId={chain.evmChainId} size={11} />
                    <span>{num(chain.attestedHeight)}/{num(chain.sourceHead)}</span>
                    <span className={LAG_CLS[severity]}>
                      {chain.lag == null ? t("wallet.attestLagUnknown") : t("wallet.attestLagBlocks", { blocks: chain.lag.toLocaleString() })}
                    </span>
                  </span>
                );
              })}
              <span className="inline-flex items-center gap-1 tabular-nums" title={t("wallet.attestCc3Block")}>
                {t("wallet.attestCc3Block")} #{num(status.data.cc3Block)}
              </span>
            </div>
          )}
        </div>

        {/* Body: input + actions + results */}
        <div className="acp-scroll flex-1 overflow-y-auto p-3">
          <p className="text-[11px] leading-relaxed text-muted-2">{t("chat.attest.quickDesc")}</p>

          {/* Tx hash + chain select */}
          <div className="mt-2">
            <label htmlFor="attest-quick-hash" className="text-[10px] font-semibold uppercase tracking-wider text-muted-3">
              {t("chat.attest.txLabel")}
            </label>
            <div className="mt-1 flex items-center gap-1.5">
              <input
                id="attest-quick-hash"
                ref={hashInputRef}
                type="text"
                spellCheck={false}
                autoComplete="off"
                value={txInput}
                onChange={(e) => {
                  setTxInput(e.target.value);
                  // Manual edits clear the prefill provenance hint (the value
                  // is no longer "from your latest transaction").
                  if (prefilled) setPrefilled(false);
                }}
                placeholder="0x…"
                aria-invalid={txInput.length > 0 && !validHash}
                className={cn(
                  "min-w-0 flex-1 rounded-lg border bg-surface-2/50 px-2.5 py-2 font-mono text-[12px] text-foreground placeholder:text-muted-3 focus:outline-none focus:ring-1",
                  txInput.length > 0 && !validHash
                    ? "border-danger/50 focus:border-danger/60 focus:ring-danger/30"
                    : "border-border focus:border-primary/50 focus:ring-primary/30",
                )}
              />
            </div>
            {txInput.length > 0 && !validHash ? (
              <p role="alert" className="mt-1 text-[10.5px] text-danger">
                {t("chat.attest.txInvalid")}
              </p>
            ) : prefilled ? (
              <p className="mt-1 text-[10.5px] text-primary/70">{t("chat.attest.prefilled")}</p>
            ) : null}
            <div className="mt-1.5 flex items-center gap-1.5" role="radiogroup" aria-label={t("chat.attest.chainLabel")}>
              {ATTEST_SOURCE_CHAIN_OPTIONS.map((id) => {
                const chain = getChainByChainId(id);
                const active = chainId === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setChainId(id)}
                    className={cn(
                      "hit-slop inline-flex h-9 min-w-11 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60",
                      active
                        ? "border-primary/40 bg-primary/12 text-primary"
                        : "border-border bg-surface-2/40 text-muted-2 hover:bg-surface-2/70",
                    )}
                  >
                    <ChainIcon chainId={id} size={13} />
                    {chain?.shortName ?? chain?.name}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Action buttons — disabled until the hash is valid */}
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => void runCheck()}
              disabled={!validHash || check.phase === "checking"}
              className="hit-slop inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-primary/25 bg-primary/10 px-2.5 text-[11px] font-medium text-primary transition-colors hover:border-primary/45 hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {check.phase === "checking" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <ShieldCheck className="h-3.5 w-3.5" aria-hidden />}
              {check.phase === "checking" ? t("payments.attestVerifying") : t("chat.attest.check")}
            </button>
            <button
              type="button"
              onClick={() => void runEstimate()}
              disabled={!validHash || estimate.phase === "checking"}
              className="hit-slop inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-surface-2/40 px-2.5 text-[11px] font-medium text-muted-2 transition-colors hover:bg-surface-2/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {estimate.phase === "checking" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Coins className="h-3.5 w-3.5" aria-hidden />}
              {t("chat.attest.estimate")}
            </button>
            <button
              type="button"
              onClick={() => setShowCertInput((v) => !v)}
              aria-expanded={showCertInput}
              className="hit-slop inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-surface-2/40 px-2.5 text-[11px] font-medium text-muted-2 transition-colors hover:bg-surface-2/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
            >
              <FileBadge className="h-3.5 w-3.5" aria-hidden />
              {t("chat.attest.verifyCert")}
            </button>
          </div>

          {/* Certificate JSON textarea (Verify certificate toggle) */}
          {showCertInput ? (
            <div className="mt-2 rounded-lg border border-border bg-surface-2/30 p-2">
              <label htmlFor="attest-quick-cert" className="text-[10px] font-semibold uppercase tracking-wider text-muted-3">
                {t("chat.attest.pasteCert")}
              </label>
              <textarea
                id="attest-quick-cert"
                value={certText}
                onChange={(e) => setCertText(e.target.value)}
                rows={4}
                spellCheck={false}
                placeholder='{"schema":"acp.attestation-certificate/v1"…}'
                className="acp-scroll mt-1 w-full resize-y rounded-md border border-border bg-surface/60 p-2 font-mono text-[10.5px] leading-relaxed text-foreground placeholder:text-muted-3 focus:border-primary/50 focus:outline-none"
              />
              {certJsonTouched && !certJsonValid ? (
                <p role="alert" className="mt-1 text-[10.5px] text-danger">
                  {t("chat.attest.certInvalid")}
                </p>
              ) : null}
              <button
                type="button"
                onClick={() => void runCertVerify()}
                disabled={!certJsonTouched || !certJsonValid || cert.phase === "checking"}
                className="hit-slop mt-1.5 inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-primary/25 bg-primary/10 px-2.5 text-[11px] font-medium text-primary transition-colors hover:border-primary/45 hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {cert.phase === "checking" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <ShieldCheck className="h-3.5 w-3.5" aria-hidden />}
                {t("chat.attest.certRun")}
              </button>
            </div>
          ) : null}

          {/* Results area */}
          {(check.phase !== "idle" || estimate.phase !== "idle" || cert.phase !== "idle") ? (
            <div className="mt-2.5 flex flex-col gap-2 border-t border-border/40 pt-2.5">
              {check.phase === "checking" ? (
                <p className="flex items-center gap-1.5 text-[11px] text-muted-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  {t("payments.attestVerifying")}
                </p>
              ) : null}
              {check.phase === "done" ? (
                <AttestProofCard data={check.data} txHash={trimmed} chainId={chainId} expanded />
              ) : null}
              {check.phase === "error" ? (
                <AttestErrorLine message={check.message} onRetry={() => void runCheck()} />
              ) : null}

              {estimate.phase === "checking" ? (
                <p className="flex items-center gap-1.5 text-[11px] text-muted-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  {t("chat.attest.estimate")}
                </p>
              ) : null}
              {estimate.phase === "done" ? (
                <div className="rounded-xl border border-border/60 bg-surface-2/30 p-2.5 text-[11px]">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-muted-2">{t("chat.attest.cost")}</span>
                    <span className="font-semibold text-primary">{estimate.label}</span>
                    {estimate.roots != null ? (
                      <span className="tabular-nums text-muted-2">{t("chat.attest.roots", { count: estimate.roots })}</span>
                    ) : null}
                    {estimate.stale ? <span className="text-warning">{t("chat.attest.staleWarning")}</span> : null}
                  </p>
                  <p className="mt-0.5 text-muted-3">{t("chat.attest.costNote")}</p>
                </div>
              ) : null}
              {estimate.phase === "unavailable" ? (
                <p className="rounded-xl border border-warning/30 bg-warning/10 p-2.5 text-[11px] text-warning">
                  {t("chat.attest.estimateUnavailable")}
                </p>
              ) : null}
              {estimate.phase === "error" ? (
                <AttestErrorLine message={estimate.message} onRetry={() => void runEstimate()} />
              ) : null}

              {cert.phase === "checking" ? (
                <p className="flex items-center gap-1.5 text-[11px] text-muted-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  {t("chat.attest.certRun")}
                </p>
              ) : null}
              {cert.phase === "done" ? (
                <div
                  role="status"
                  className={cn(
                    "rounded-xl border p-2.5 text-[11px]",
                    cert.verdict.ok ? "border-success/30 bg-success/10" : "border-danger/30 bg-danger/10",
                  )}
                >
                  <p className={cn("flex items-center gap-1.5 font-semibold", cert.verdict.ok ? "text-success" : "text-danger")}>
                    {cert.verdict.ok ? <Check className="h-3.5 w-3.5" aria-hidden /> : <X className="h-3.5 w-3.5" aria-hidden />}
                    {cert.verdict.ok ? t("chat.attest.verdictValid") : t("chat.attest.verdictInvalid")}
                  </p>
                  {cert.verdict.txHash ? (
                    <p className="mt-1 flex min-w-0 items-center gap-0.5 font-mono text-[10px] text-muted">
                      <span className="truncate" title={cert.verdict.txHash}>
                        {cert.verdict.txHash.slice(0, 12)}…{cert.verdict.txHash.slice(-8)}
                      </span>
                      <CopyValue value={cert.verdict.txHash} label={t("trace.copy")} />
                    </p>
                  ) : null}
                  <ul className="mt-1.5 space-y-1">
                    {cert.verdict.checks.map((c) => (
                      <li key={c.id} className="flex items-start gap-1.5">
                        <CheckStatusIcon status={c.status} />
                        <span className="min-w-0 flex-1">
                          <span className={cn("font-medium", c.status === "fail" ? "text-danger" : c.status === "pass" ? "text-foreground/80" : "text-muted-2")}>
                            {t(CHECK_ID_KEYS[c.id])}
                          </span>
                          <span className="block break-words text-[10px] leading-snug text-muted-3">{c.detail}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {cert.phase === "error" ? (
                <AttestErrorLine message={cert.message} onRetry={() => void runCertVerify()} />
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border/40 px-3.5 py-2">
          <Link
            href="/actions"
            className="inline-flex items-center gap-1 text-[11px] font-medium text-primary transition-colors hover:text-primary-hover"
            onClick={close}
          >
            {t("chat.attest.viewActions")}
            <ArrowRight className="h-3 w-3" aria-hidden />
          </Link>
          <span className="text-[10px] text-muted-3">{t("chat.attest.nativeNote")}</span>
        </div>
      </motion.div>,
    document.body,
  );

  return (
    <>
      {trigger}
      {popover}
    </>
  );
}
