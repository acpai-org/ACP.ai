"use client";

import { useCallback, useRef, useState } from "react";
import {
  FileSearch,
  Upload,
  Loader2,
  ShieldCheck,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  MinusCircle,
  FileJson,
  Trash2,
  Coins,
  User,
  ExternalLink,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { useFormatters } from "@/lib/use-formatters";
import { sourceExplorerTxUrl } from "@/lib/attestcoin/cc3-links";
import { useVerifyCertificate, type CertificateCheckResult } from "@/lib/api";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Attestcoin certificate verifier — the counterpart of the payments page's
// "Export proof" button. A third party holding an exported attestation
// certificate (JSON) can paste it here (or drop the file) and watch it be
// re-verified against LIVE data: schema, internal consistency, the hosted
// proof builder, and the Creditcoin Block Prover Precompile itself.
// ─────────────────────────────────────────────────────────────────────────────

const CHECK_CONFIG: Record<
  CertificateCheckResult["id"],
  {
    label:
      | "verifier.checkSchemaLabel"
      | "verifier.checkConsistencyLabel"
      | "verifier.checkBuilderLabel"
      | "verifier.checkOnchainLabel"
      | "verifier.checkReceiptLabel";
  }
> = {
  schema: { label: "verifier.checkSchemaLabel" },
  consistency: { label: "verifier.checkConsistencyLabel" },
  builder: { label: "verifier.checkBuilderLabel" },
  onchain: { label: "verifier.checkOnchainLabel" },
  receipt: { label: "verifier.checkReceiptLabel" },
};

function StatusIcon({ status }: { status: CertificateCheckResult["status"] }) {
  if (status === "pass") return <CheckCircle2 className="h-3.5 w-3.5 text-success" />;
  if (status === "fail") return <XCircle className="h-3.5 w-3.5 text-danger" />;
  return <MinusCircle className="h-3.5 w-3.5 text-muted-3" />;
}

function CheckRow({ check, index }: { check: CertificateCheckResult; index: number }) {
  const { t } = useI18n();
  const config = CHECK_CONFIG[check.id];
  const statusLabel =
    check.status === "pass"
      ? t("verifier.checkPass")
      : check.status === "fail"
        ? t("verifier.checkFail")
        : t("verifier.checkSkip");
  return (
    <motion.li
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.05 * index, duration: 0.25, ease: "easeOut" }}
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3 py-2",
        check.status === "pass" && "border-success/20 bg-success/5",
        check.status === "fail" && "border-danger/25 bg-danger/5",
        check.status === "skip" && "border-border/50 bg-surface/40",
      )}
    >
      <span className="mt-0.5 shrink-0">
        <StatusIcon status={check.status} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-1.5">
          <span className="text-xs font-medium text-foreground">{t(config.label)}</span>
          <span
            className={cn(
              "text-[10px] font-semibold uppercase tracking-wider",
              check.status === "pass" && "text-success",
              check.status === "fail" && "text-danger",
              check.status === "skip" && "text-muted-3",
            )}
          >
            {statusLabel}
          </span>
        </div>
        <p className="mt-0.5 break-words font-mono text-[10px] leading-relaxed text-muted-2">
          {check.detail}
        </p>
      </div>
    </motion.li>
  );
}

function SummaryRow({ label, value, mono, href }: { label: string; value: string; mono?: boolean; href?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/25 py-1.5 last:border-b-0">
      <span className="shrink-0 text-[11px] text-muted-2">{label}</span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-w-0 items-center gap-1 truncate font-mono text-[11px] text-primary underline decoration-primary/30 underline-offset-2 hover:text-primary-hover"
        >
          <span className="truncate">{value}</span>
          <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
        </a>
      ) : (
        <span className={cn("truncate text-[11px] text-foreground", mono && "font-mono")}>{value}</span>
      )}
    </div>
  );
}

export function CertificateVerifier() {
  const { t } = useI18n();
  const { formatFullDate } = useFormatters();
  const verify = useVerifyCertificate();
  const [text, setText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const readFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const content = typeof reader.result === "string" ? reader.result : "";
      setText(content);
      setJsonError(null);
    };
    reader.readAsText(file);
  }, []);

  const onVerify = useCallback(() => {
    setJsonError(null);
    if (!text.trim()) return;
    try {
      JSON.parse(text);
    } catch {
      setJsonError(t("verifier.verifyInvalid"));
      return;
    }
    verify.mutate(text);
  }, [text, verify, t]);

  const onClear = useCallback(() => {
    setText("");
    setJsonError(null);
    verify.reset();
  }, [verify]);

  const result = verify.data;
  const hasResult = verify.isSuccess && result !== undefined;
  const payment = hasResult ? (result.payment ?? null) : null;

  return (
    <Card className="relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-success/5 via-success/2 to-transparent"
      />
      <div className="relative">
        {/* Header */}
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-success/10 text-success ring-1 ring-inset ring-success/20">
            <FileSearch className="h-4 w-4" />
          </span>
          <h2 className="text-sm font-semibold text-foreground">{t("verifier.verifyTitle")}</h2>
        </div>
        <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted-2">{t("verifier.verifyDesc")}</p>

        {/* Drop zone */}
        <div
          role="button"
          tabIndex={0}
          aria-label={t("verifier.verifyDropzone")}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files?.[0];
            if (file) readFile(file);
          }}
          className={cn(
            "mt-3 flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed px-4 py-5 text-center transition-all duration-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60",
            dragOver
              ? "border-primary/60 bg-primary/10 scale-[1.01]"
              : "border-border bg-surface/30 hover:border-primary/30 hover:bg-surface/50",
          )}
        >
          <Upload
            className={cn(
              "h-5 w-5 transition-colors",
              dragOver ? "text-primary" : "text-muted-2",
            )}
          />
          <p className="text-xs text-muted-2">
            {t("verifier.verifyDropzone")}{" "}
            <span className="font-medium text-primary underline underline-offset-2 decoration-primary/40">
              {t("verifier.verifyBrowse")}
            </span>
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) readFile(file);
              e.target.value = "";
            }}
          />
        </div>

        {/* Paste area */}
        <p className="mt-3 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-3">
          <FileJson className="h-3 w-3" aria-hidden />
          {t("verifier.verifyPaste")}
        </p>
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setJsonError(null);
          }}
          placeholder={t("verifier.verifyPlaceholder")}
          aria-label={t("verifier.verifyPlaceholder")}
          spellCheck={false}
          rows={4}
          className={cn(
            "mt-1.5 w-full resize-y rounded-xl border bg-surface/50 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-foreground transition-colors placeholder:text-muted-3 focus:outline-none",
            jsonError ? "border-danger/50" : "border-border focus:border-primary/40",
          )}
        />

        {/* Actions */}
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={onVerify}
            disabled={verify.isPending || !text.trim()}
            title={t("verifier.verifyButton")}
          >
            {verify.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
            {verify.isPending ? t("verifier.verifying") : t("verifier.verifyButton")}
          </Button>
          {(text || hasResult) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={onClear}
              disabled={verify.isPending}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("verifier.verifyClear")}
            </Button>
          )}
        </div>

        {/* Input-level errors (invalid JSON / empty) */}
        {jsonError ? (
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-danger">
            <XCircle className="h-3.5 w-3.5 shrink-0" />
            {jsonError}
          </p>
        ) : null}
        {!jsonError && !text.trim() && hasResult === false && verify.isIdle ? (
          <p className="mt-2 text-[11px] text-muted-3">{t("verifier.verifyEmpty")}</p>
        ) : null}
        {verify.isError ? (
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-danger">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
            {verify.error instanceof Error ? verify.error.message : t("verifier.verifyRequestError")}
          </p>
        ) : null}

        {/* Results */}
        <AnimatePresence initial={false}>
          {hasResult && result ? (
            <motion.div
              key="verify-result"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              className="mt-3 space-y-2.5"
            >
              {/* Verdict banner */}
              <div
                className={cn(
                  "flex items-start gap-3 rounded-xl border px-3.5 py-3",
                  result.ok
                    ? "border-success/30 border-l-2 border-l-success bg-gradient-to-r from-success/15 via-success/5 to-transparent"
                    : "border-danger/30 border-l-2 border-l-danger bg-gradient-to-r from-danger/15 via-danger/5 to-transparent",
                )}
                role="status"
                aria-live="polite"
              >
                <span
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset",
                    result.ok
                      ? "bg-success/15 text-success ring-success/25"
                      : "bg-danger/10 text-danger ring-danger/25",
                  )}
                >
                  {result.ok ? <ShieldCheck className="h-5 w-5" /> : <ShieldAlert className="h-5 w-5" />}
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className={cn("text-sm font-semibold", result.ok ? "text-success" : "text-danger")}>
                      {result.ok ? t("verifier.verifyVerdictOk") : t("verifier.verifyVerdictFail")}
                    </p>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 font-mono text-[10px] font-medium ring-1 ring-inset",
                        result.ok ? "bg-success/10 text-success ring-success/25" : "bg-danger/10 text-danger ring-danger/25",
                      )}
                      aria-label={t("verifier.checkPass")}
                    >
                      {
                        t("verifier.verifyChecksPassed", {
                          passed: result.checks.filter((c) => c.status === "pass").length,
                          total: result.checks.length,
                        })
                      }
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-2">
                    {result.ok
                      ? t("verifier.verifyVerdictOkDesc", { network: result.network })
                      : t("verifier.verifyVerdictFailDesc")}
                  </p>
                </div>
              </div>

              {/* Per-check results (staggered) */}
              <ul className="space-y-1.5">
                {result.checks.map((check, i) => (
                  <CheckRow key={check.id} check={check} index={i} />
                ))}
              </ul>

              {/* Certificate summary */}
              {result.chain || result.txHash ? (
                <div className="rounded-xl border border-border bg-surface/40 px-3 py-2">
                  <SummaryRow label={t("verifier.verifyChain")} value={result.chain?.name ?? "—"} />
                  {(() => {
                    // N27.1: the verified source tx links to its explorer page
                    // (registry-truth URL from the chain's EVM id).
                    const txUrl =
                      result.txHash && result.chain
                        ? sourceExplorerTxUrl(result.chain.evmChainId, result.txHash)
                        : null;
                    return (
                      <SummaryRow
                        label={t("verifier.verifyTx")}
                        value={result.txHash ?? "—"}
                        mono
                        href={txUrl ?? undefined}
                      />
                    );
                  })()}
                  <SummaryRow label={t("verifier.verifyNetwork")} value={result.network} />
                  {result.certificateExportedAt ? (
                    <SummaryRow
                      label={t("verifier.verifyExportedAt")}
                      value={formatFullDate(new Date(result.certificateExportedAt).getTime())}
                    />
                  ) : null}
                </div>
              ) : null}

              {/* Payment echo (which payment this certificate attests) */}
              {payment ? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2">
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-foreground">
                    <Coins className="h-3 w-3 text-primary/70" aria-hidden />
                    {typeof payment.amountHuman === "string" && typeof payment.token === "string"
                      ? `${payment.amountHuman} ${payment.token}`
                      : t("verifier.verifyPayment")}
                  </span>
                  {typeof payment.recipient === "string" && payment.recipient ? (
                    <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-muted-2">
                      <User className="h-3 w-3 text-primary/70" aria-hidden />
                      {payment.recipient}
                    </span>
                  ) : null}
                  {typeof payment.memo === "string" && payment.memo ? (
                    <span className="text-[10px] italic text-muted-3">“{payment.memo}”</span>
                  ) : null}
                </div>
              ) : null}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </Card>
  );
}
