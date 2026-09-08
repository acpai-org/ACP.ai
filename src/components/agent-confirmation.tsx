"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  ShieldCheck,
  Check,
  X,
  FileCode2,
  AlertTriangle,
  Fuel,
  Loader2,
} from "lucide-react";
import { getChainByChainId } from "@/lib/chains/registry";
import type { ConfirmationRequest } from "@/lib/agent/events";
import { useFeeEstimate } from "@/lib/agent/use-fee-estimate";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// AgentConfirmation (Phase 3 §5): the pre-deployment confirmation card. The
// session mandate and its quick-grant panel were removed (C26) — routine fund
// actions are confirmed by the wallet signature itself. The one in-app
// confirmation that remains is contract deployment: the user sees the source
// (or template + params) and a plain-English summary before bytecode goes
// on-chain, because the wallet only shows compiled bytecode at signing time.
// This confirmation is never dismissible; only the custom-source warning's
// "don't show again" is per-user dismissible.
// ─────────────────────────────────────────────────────────────────────────────

export function AgentConfirmation({
  request,
  onAnswer,
}: {
  request: ConfirmationRequest;
  onAnswer: (approved: boolean, rememberChoice: boolean) => void;
}) {
  const { t } = useI18n();
  const [showSource, setShowSource] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  // Live gas-price half of the fee estimate (units arrived with the request).
  const fee = useFeeEstimate(request);
  const chain = request.chainId ? getChainByChainId(request.chainId) : undefined;
  const isDeploy = Boolean(request.contract);
  const isCustomDeploy = isDeploy && !request.contract?.template;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.22, ease: "easeOut" }}
      className="mt-3 overflow-hidden rounded-2xl border border-warning/30 bg-gradient-to-b from-warning/[0.07] to-transparent"
      role="alertdialog"
      aria-label={t("confirm.title")}
    >
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-warning/15 text-warning">
          <ShieldCheck className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground/90">{t("confirm.title")}</p>
          <p className="mt-1 text-sm leading-relaxed text-foreground/75">{request.summary}</p>
          <p className="mt-1.5 text-[11px] text-warning/80">{t("confirm.reasonDeployAlways")}</p>
        </div>
      </div>

      <div className="mt-3 grid gap-x-4 gap-y-1.5 px-4 text-[11px] text-foreground/50 sm:grid-cols-2">
        {chain ? (
          <p>
            <span className="text-foreground/35">{t("confirm.chain")}: </span>
            <span className={cn("font-medium", chain.testnet ? "text-amber-600 dark:text-amber-300" : "text-emerald-600 dark:text-emerald-300")}>
              {chain.name}
              {chain.testnet ? " · " + t("chain.testnetChip") : ""}
            </span>
          </p>
        ) : null}
        {request.txCount && request.txCount > 1 ? (
          <p>
            <span className="text-foreground/35">{t("confirm.txCount")}: </span>
            <span className="font-medium text-foreground/75">{request.txCount}</span>
          </p>
        ) : null}
        {fee.state !== "none" ? (
          <div className="col-span-2">
            <div
              className="flex items-center gap-2 rounded-lg border border-foreground/10 bg-foreground/[0.03] px-2.5 py-2"
              title={t("confirm.feeNote")}
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-warning/10 text-warning/90">
                <Fuel className="h-3 w-3" aria-hidden />
              </span>
              <span className="shrink-0 text-foreground/35">{t("confirm.fee")}</span>
              {fee.state === "loading" ? (
                <span className="flex items-center gap-1.5 text-foreground/50">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  {t("confirm.feeEstimating")}
                </span>
              ) : fee.state === "unavailable" ? (
                <span className="text-foreground/50">{t("confirm.feeUnavailable")}</span>
              ) : (
                <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 font-mono text-[11px] tabular-nums">
                  {Object.entries(fee.totals).map(([sym, amt], i) => (
                    <span key={sym} className="text-foreground/75">
                      {i > 0 ? <span className="text-foreground/35">+ </span> : <span className="text-foreground/35">≈ </span>}
                      {amt} <span className="font-sans text-foreground/50">{sym}</span>
                    </span>
                  ))}
                  {fee.state === "partial" ? (
                    <span className="font-sans text-foreground/35">· {t("confirm.feePartial")}</span>
                  ) : null}
                </span>
              )}
            </div>
            {request.feeEstimate?.breakdown && request.feeEstimate.breakdown.length > 1 ? (
              <div className="mt-1 space-y-0.5 rounded-lg border border-foreground/[0.07] bg-foreground/[0.02] px-2.5 py-1.5">
                {fee.entries.map((e, i) => (
                  <p key={i} className="flex items-baseline justify-between gap-3 text-[10px] text-foreground/45">
                    <span className="min-w-0 truncate">{e.label}</span>
                    <span className="shrink-0 font-mono tabular-nums text-foreground/40">
                      {e.feeNative ? `≈ ${e.feeNative} ${e.symbol}` : `${e.gasUnits.toLocaleString("en-US")} gas`}
                    </span>
                  </p>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {isDeploy && request.contract ? (
        <div className="mt-3 px-4">
          <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3">
            <p className="flex items-start gap-2 text-[11px] leading-relaxed text-foreground/65">
              <FileCode2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
              {request.contract.plainSummary}
            </p>
            {request.contract.template ? (
              <p className="mt-1.5 font-mono text-[10px] text-foreground/40">template: {request.contract.template}</p>
            ) : null}
            {request.contract.warnings && request.contract.warnings.length > 0 ? (
              <details className="mt-1.5">
                <summary className="cursor-pointer text-[10px] text-warning/70">
                  {t("confirm.compilerWarnings", { count: String(request.contract.warnings.length) })}
                </summary>
                <pre className="acp-scroll mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg p-2 code-surface font-mono text-[9px] leading-relaxed text-foreground/40">
                  {request.contract.warnings.join("\n")}
                </pre>
              </details>
            ) : null}
            <button
              type="button"
              onClick={() => setShowSource((v) => !v)}
              className="mt-2 text-[11px] font-medium text-primary hover:text-primary-hover"
              aria-expanded={showSource}
            >
              {showSource ? t("confirm.hideSource") : t("confirm.showSource")}
            </button>
            <AnimatePresence initial={false}>
              {showSource ? (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <pre className="acp-scroll mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg p-3 code-surface font-mono text-[9.5px] leading-relaxed text-foreground/60">
                    {request.contract.source}
                  </pre>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>

          {isCustomDeploy ? (
            <div className="mt-2.5 rounded-xl border border-danger/30 bg-danger/[0.07] p-3">
              <p className="flex items-start gap-2 text-[11px] leading-relaxed text-danger">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                {t("confirm.customWarning")}
              </p>
              <label className="mt-2 flex cursor-pointer select-none items-center gap-2 text-[11px] text-foreground/50">
                <input
                  type="checkbox"
                  checked={dontShowAgain}
                  onChange={(e) => setDontShowAgain(e.target.checked)}
                  className="h-3.5 w-3.5 accent-primary"
                />
                {t("confirm.dontShowAgain")}
              </label>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3.5 flex gap-2.5 border-t border-foreground/10 bg-foreground/5 px-4 py-3">
        <button
          type="button"
          onClick={() => onAnswer(true, dontShowAgain)}
          className="glass-btn flex flex-1 items-center justify-center gap-2 rounded-xl bg-primary/20 px-4 py-2.5 text-sm font-semibold text-white transition-all hover:bg-primary/30"
        >
          <Check className="h-4 w-4" aria-hidden />
          {t("confirm.approve")}
        </button>
        <button
          type="button"
          onClick={() => onAnswer(false, false)}
          className="glass-btn flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white/75 transition-all hover:text-white"
        >
          <X className="h-4 w-4" aria-hidden />
          {t("confirm.decline")}
        </button>
      </div>
    </motion.div>
  );
}
