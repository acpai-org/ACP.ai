"use client";

import { useEffect, useMemo, useState, startTransition } from "react";
import { createPortal } from "react-dom";
import qrcode from "qrcode-generator";
import { X, Copy, Check, QrCode, ScanLine, Wallet, ExternalLink } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { useI18n } from "@/lib/i18n";
import { getChainByChainId } from "@/lib/chains/registry";

// ─────────────────────────────────────────────────────────────────────────────
// Contact QR modal (R4): share a saved recipient's address by QR.
//
// The QR encodes the EIP-681 payment URI (ethereum:<address>@<chainId>) so a
// scanning wallet lands on the right network — same contract as the receive
// modal, mirrored for the address-book side. A plain-address copy row covers
// manual sharing, and an explorer link offers on-chain verification.
// ─────────────────────────────────────────────────────────────────────────────

export function ContactQrModal({
  label,
  address,
  chainId,
  explorerUrl,
  onClose,
}: {
  label: string;
  address: string;
  chainId: number;
  explorerUrl: string | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [mounted, setMounted] = useState(false);
  const [copied, setCopied] = useState<"addr" | "uri" | null>(null);
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
    try {
      // .catch (not try/catch): writeText rejects asynchronously when the
      // clipboard is denied — an unhandled rejection would surface in dev.log.
      navigator.clipboard?.writeText(text).catch(() => {});
    } catch {
      /* clipboard unavailable — feedback icon still swaps */
    }
    setCopied(which);
    window.setTimeout(() => setCopied((cur) => (cur === which ? null : cur)), 1600);
  };

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="contact-qr-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        className="fixed inset-0 z-[300] flex items-center justify-center bg-[var(--overlay-bg)] p-4 backdrop-blur-sm"
        onClick={onClose}
        role="dialog"
        aria-modal="true"
        aria-label={t("contacts.shareQrTitle", { name: label })}
      >
        <motion.div
          key="contact-qr-card"
          initial={{ opacity: 0, scale: 0.92, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 8 }}
          transition={{ type: "spring", stiffness: 380, damping: 30 }}
          className="glass-dropdown w-full max-w-sm rounded-2xl border border-border/70 p-5 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <QrCode className="h-4 w-4 shrink-0 text-primary" />
                <span className="truncate">{t("contacts.shareQrTitle", { name: label })}</span>
              </h3>
              <p className="mt-0.5 text-[11px] text-muted-2">{t("contacts.shareQrDesc")}</p>
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

          {/* QR tile — gradient frame + corner accents for depth detail. */}
          <div className="mt-4 flex justify-center">
            <div className="relative rounded-2xl bg-gradient-to-br from-primary/40 via-primary/15 to-primary/40 p-[2px] shadow-[0_10px_28px_-10px_rgba(0,0,0,0.45)]">
              <div className="rounded-[14px] border border-border/60 bg-white p-3 ring-4 ring-primary/10">
                {qrDataUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- data URL, no optimizer
                  <img
                    src={qrDataUrl}
                    alt={`${t("contacts.shareQrTitle", { name: label })} — ${chainName}`}
                    width={208}
                    height={208}
                    className="block h-52 w-52"
                  />
                ) : null}
              </div>
              {/* Corner accents — optical brackets framing the scannable area. */}
              <span
                aria-hidden
                className="pointer-events-none absolute -left-1 -top-1 h-3.5 w-3.5 rounded-tl-lg border-l-2 border-t-2 border-primary/50"
              />
              <span
                aria-hidden
                className="pointer-events-none absolute -right-1 -top-1 h-3.5 w-3.5 rounded-tr-lg border-r-2 border-t-2 border-primary/50"
              />
              <span
                aria-hidden
                className="pointer-events-none absolute -bottom-1 -left-1 h-3.5 w-3.5 rounded-bl-lg border-b-2 border-l-2 border-primary/50"
              />
              <span
                aria-hidden
                className="pointer-events-none absolute -bottom-1 -right-1 h-3.5 w-3.5 rounded-br-lg border-b-2 border-r-2 border-primary/50"
              />
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
              {t("contacts.address")}
            </label>
            <button
              type="button"
              onClick={() => copy(address, "addr")}
              className="mt-1 flex w-full items-center gap-2 rounded-xl border border-border bg-surface-2/50 px-3 py-2.5 text-left transition-colors hover:border-primary/40 cursor-pointer wrap-anywhere"
              aria-label={t("contacts.copyAddress")}
            >
              <span className="min-w-0 flex-1 font-mono text-[11px] text-foreground wrap-anywhere">{address}</span>
              {copied === "addr" ? (
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
              aria-label={t("contacts.copyUri")}
            >
              <span className="min-w-0 truncate font-mono">{eip681}</span>
              {copied === "uri" ? (
                <Check className="h-3 w-3 shrink-0 text-success" />
              ) : (
                <Copy className="h-3 w-3 shrink-0" />
              )}
            </button>
          </div>

          <div className="mt-3 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-3">
              <ScanLine className="h-3 w-3 shrink-0 text-primary/60" aria-hidden />
              <span className="truncate">{t("contacts.shareQrScanHint")}</span>
            </div>
            {explorerUrl ? (
              <a
                href={explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-medium text-primary transition-colors hover:bg-primary/10"
                title={t("trace.explorer")}
              >
                <ExternalLink className="h-3 w-3" />
                {t("trace.explorer")}
              </a>
            ) : null}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
