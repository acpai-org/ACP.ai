"use client";

import { useEffect, useMemo, useState, startTransition } from "react";
import { createPortal } from "react-dom";
import qrcode from "qrcode-generator";
import { X, Copy, Check, QrCode, Wallet, AlertTriangle } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { useI18n } from "@/lib/i18n";
import { getChainByChainId } from "@/lib/chains/registry";

// ─────────────────────────────────────────────────────────────────────────────
// Receive modal (C8): QR + full address for the connected wallet on the
// active chain. The QR encodes the EIP-681 payment URI
// (ethereum:<address>@<chainId>) so scanning wallets land on the right
// network; a plain-address fallback row covers manual copy.
// ─────────────────────────────────────────────────────────────────────────────

export function ReceiveModal({
  address,
  chainId,
  onClose,
}: {
  address: string;
  chainId: number;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [mounted, setMounted] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedUri, setCopiedUri] = useState(false);
  useEffect(() => { startTransition(() => setMounted(true)); }, []);

  const chain = getChainByChainId(chainId);
  const chainName = chain?.name ?? `Chain ${chainId}`;

  // Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const eip681 = useMemo(() => `ethereum:${address}@${chainId}`, [address, chainId]);

  const qrDataUrl = useMemo(() => {
    try {
      const qr = qrcode(0, "M");
      qr.addData(eip681);
      qr.make();
      return qr.createDataURL(4, 2);
    } catch {
      return null;
    }
  }, [eip681]);

  const copy = (text: string, which: "addr" | "uri") => {
    navigator.clipboard?.writeText(text);
    if (which === "addr") {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } else {
      setCopiedUri(true);
      setTimeout(() => setCopiedUri(false), 1600);
    }
  };

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="receive-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        className="fixed inset-0 z-[300] flex items-center justify-center bg-[var(--overlay-bg)] p-4 backdrop-blur-sm"
        onClick={onClose}
        role="dialog"
        aria-modal="true"
        aria-label={t("wallet.receiveTitle")}
      >
        <motion.div
          key="receive-card"
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
                {t("wallet.receiveTitle")}
              </h3>
              <p className="mt-0.5 text-[11px] text-muted-2">{t("wallet.receiveDesc")}</p>
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
                <img
                  src={qrDataUrl}
                  alt={`${t("wallet.receiveTitle")} — ${chainName}`}
                  width={208}
                  height={208}
                  className="block h-52 w-52"
                />
              ) : null}
            </div>
          </div>

          <div className="mt-3 flex items-center justify-center gap-2">
            <span className="flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-medium text-primary">
              <Wallet className="h-3 w-3" />
              {chainName}
            </span>
            {chain?.testnet ? (
              <span className="rounded-full bg-warning/10 px-2.5 py-1 text-[10px] font-medium text-warning">
                {t("chain.testnetChip")}
              </span>
            ) : null}
          </div>

          <div className="mt-3">
            <label className="text-[10px] font-medium uppercase tracking-wider text-muted-2">
              {t("wallet.receiveAddressLabel")}
            </label>
            <button
              type="button"
              onClick={() => copy(address, "addr")}
              className="mt-1 flex w-full items-center gap-2 rounded-xl border border-border bg-surface-2/50 px-3 py-2.5 text-left transition-colors hover:border-primary/40 cursor-pointer"
              aria-label={t("wallet.copyAddress")}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                {address}
              </span>
              {copied ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-success" />
              ) : (
                <Copy className="h-3.5 w-3.5 shrink-0 text-muted-2" />
              )}
            </button>
          </div>

          <div className="mt-2">
            <button
              type="button"
              onClick={() => copy(eip681, "uri")}
              className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-[10px] text-muted-3 transition-colors hover:text-foreground cursor-pointer"
            >
              <span className="truncate font-mono">{eip681}</span>
              {copiedUri ? (
                <Check className="h-3 w-3 shrink-0 text-success" />
              ) : (
                <Copy className="h-3 w-3 shrink-0" />
              )}
            </button>
          </div>

          {chain ? (
            <div className="mt-3 flex items-start gap-1.5 rounded-lg border border-warning/25 bg-warning/5 px-2.5 py-2 text-[10px] leading-relaxed text-warning">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              {t("wallet.receiveNetworkWarning", { chain: chain.shortName })}
            </div>
          ) : null}
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
