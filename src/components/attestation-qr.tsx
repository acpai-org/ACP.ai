"use client";

import { useEffect, useMemo, useState, startTransition } from "react";
import { createPortal } from "react-dom";
import qrcode from "qrcode-generator";
import { X, Copy, Check, QrCode, ScanLine } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Attestcoin attestation reference QR.
//
// The full certificate JSON is far too large for a QR (the replayable proof
// alone runs tens of KB), so the QR encodes a compact *reference*
// (acp.attestation-ref/v1): chain, tx, merkle root, block height. Anyone can
// paste that reference into the certificate verifier (help page or the
// payments page tool) — it re-fetches the proof from the live builder and
// re-runs the Block Prover Precompile verdict against it.
// ─────────────────────────────────────────────────────────────────────────────

export interface AttestationRef {
  chainKey: number;
  chainName: string;
  txHash: string;
  merkleRoot: string;
  headerNumber: number;
  txIndex: number | null;
  env: string;
}

export function buildAttestationRefJson(ref: AttestationRef): string {
  return JSON.stringify(
    {
      schema: "acp.attestation-ref/v1",
      chainKey: ref.chainKey,
      chain: ref.chainName,
      txHash: ref.txHash,
      merkleRoot: ref.merkleRoot,
      headerNumber: ref.headerNumber,
      ...(ref.txIndex != null ? { txIndex: ref.txIndex } : {}),
      network: ref.env,
    },
    null,
    2,
  );
}

/** Trigger button — sits next to "Export proof" in the attestation card. */
export function ShareQrButton({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-sm text-[11px] text-muted-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
      title={t("payments.shareQrTitle")}
    >
      <QrCode className="h-3 w-3" />
      {t("payments.shareQr")}
    </button>
  );
}

export function AttestationQrModal({ attestRef, onClose }: { attestRef: AttestationRef; onClose: () => void }) {
  const { t } = useI18n();
  const [mounted, setMounted] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => { startTransition(() => setMounted(true)); }, []);

  // Escape closes; backdrop click closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const refJson = useMemo(() => buildAttestationRefJson(attestRef), [attestRef]);

  const qrDataUrl = useMemo(() => {
    try {
      const qr = qrcode(0, "M");
      qr.addData(refJson);
      qr.make();
      return qr.createDataURL(4, 2);
    } catch {
      return null;
    }
  }, [refJson]);

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="qr-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        className="fixed inset-0 z-[300] flex items-center justify-center bg-[var(--overlay-bg)] p-4 backdrop-blur-sm"
        onClick={onClose}
        role="dialog"
        aria-modal="true"
        aria-label={t("payments.shareQrTitle")}
      >
        <motion.div
          key="qr-card"
          initial={{ opacity: 0, scale: 0.92, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 8 }}
          transition={{ type: "spring", stiffness: 380, damping: 30 }}
          className="glass-dropdown w-full max-w-sm rounded-2xl border border-border/70 p-5 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <QrCode className="h-4 w-4 text-primary" />
                {t("payments.shareQrTitle")}
              </h3>
              <p className="mt-0.5 text-[11px] text-muted-2">{t("payments.shareQrDesc")}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("chat.close")}
              className="rounded-lg p-1.5 text-muted-2 transition-colors hover:bg-surface-2 hover:text-foreground cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-4 flex justify-center">
            <div className="rounded-2xl border border-border/60 bg-white p-3 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.4)] ring-4 ring-primary/10">
              {qrDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- data URL, no optimizer
                <img src={qrDataUrl} alt={t("payments.shareQrTitle")} width={208} height={208} className="block h-52 w-52" />
              ) : (
                <div className="flex h-52 w-52 items-center justify-center text-[11px] text-muted-2">
                  {t("payments.shareQrTooLarge")}
                </div>
              )}
            </div>
          </div>

          <div className="mt-3 flex items-center gap-1.5 text-[10px] text-muted-3">
            <ScanLine className="h-3 w-3 shrink-0 text-primary/60" />
            {t("payments.shareQrScanHint")}
          </div>

          <div className="mt-3">
            <label className="text-[10px] font-medium uppercase tracking-wider text-muted-2">
              {t("payments.shareQrRefLabel")}
            </label>
            <div className="relative mt-1">
              <textarea
                readOnly
                value={refJson}
                rows={5}
                aria-label={t("payments.shareQrRefLabel")}
                className="w-full resize-none rounded-xl border border-border bg-surface-2/50 px-3 py-2 pr-9 font-mono text-[10px] leading-relaxed text-foreground focus:border-primary/50 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(refJson);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                aria-label={t("common.copy")}
                className="absolute right-2 top-2 rounded-md p-1.5 text-muted-2 transition-colors hover:bg-surface-2 hover:text-foreground cursor-pointer"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
            <p className="mt-1.5 text-[10px] leading-relaxed text-muted-3">
              {t("payments.shareQrVerifyHint")}
            </p>
          </div>

          <div className={cn("mt-3 flex items-center justify-between gap-2 border-t border-border/50 pt-3")}>
            <span className="truncate font-mono text-[10px] text-muted-2" title={attestRef.txHash}>
              {attestRef.txHash.slice(0, 10)}…{attestRef.txHash.slice(-8)}
            </span>
            <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[9px] font-medium text-primary">
              {attestRef.env} · {attestRef.chainName}
            </span>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
