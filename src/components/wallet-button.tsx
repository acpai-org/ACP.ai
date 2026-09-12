"use client";

import { useState, useCallback, type ReactNode } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Loader2,
  Wallet,
  Copy,
  Check,
  ExternalLink,
  LogOut,
  ChevronDown,
  Network as NetworkIcon,
} from "lucide-react";
import { useAppKitSafe } from "@/lib/wagmi/appkit-init";
import { useAccount, useChainId, useDisconnect } from "wagmi";
import { networkName, explorerAddressUrl } from "@/lib/wagmi/chains";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

function truncateAddress(address: string) {
  if (!address) return "";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function WalletButton({ boxed = true }: { boxed?: boolean }) {
  const { t } = useI18n();
  const { open } = useAppKitSafe();
  const { address, isConnecting, isReconnecting, isConnected } = useAccount();
  const chainId = useChainId();
  const { disconnect } = useDisconnect();
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const isPending = isConnecting || isReconnecting;

  const copyAddress = useCallback(() => {
    if (!address) return;
    navigator.clipboard?.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [address]);

  const handleOpenAppKit = useCallback(() => open(), [open]);
  const handleCloseMenu = useCallback(() => setMenuOpen(false), []);
  const handleToggleMenu = useCallback(() => setMenuOpen((v) => !v), []);
  const handleSwitchNetwork = useCallback(() => {
    setMenuOpen(false);
    open();
  }, [open]);
  const handleDisconnect = useCallback(() => {
    setMenuOpen(false);
    disconnect();
  }, [disconnect]);

  if (!isConnected || !address) {
    // N8: `boxed={false}` renders the bare control (Android contexts) — no
    // button chrome, still a 44px tap target with a visible focus ring.
    if (!boxed) {
      return (
        <button
          type="button"
          onClick={handleOpenAppKit}
          disabled={isPending}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-xl text-sm font-medium text-foreground transition-colors hover:bg-foreground/5 active:bg-foreground/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 disabled:opacity-60"
          aria-label={t("wallet.connectAria")}
        >
          {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />}
          {isPending ? t("wallet.connecting") : t("wallet.connect")}
        </button>
      );
    }
    return (
      <Button
        onClick={handleOpenAppKit}
        disabled={isPending}
        size="md"
        variant="secondary"
        // S10-b (round-5 styling, VLM-guided): "Connect Wallet" is THE primary
        // CTA when disconnected, but the header rendered it as a bare ghost
        // while the wallet panel renders a solid primary button — two
        // different weights for the same action. Primary-tinted resting
        // border (the payments batch-submit treatment) keeps it secondary-
        // sized in the navbar while reading as the same action.
        className={cn(
          "shrink-0 h-10 gap-1.5 border-primary/30 text-primary transition-colors hover:border-primary/50 hover:bg-primary/10",
        )}
        aria-label={t("wallet.connectAria")}
      >
        {isPending ? (
          <span className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("wallet.connecting")}
          </span>
        ) : (
          <span className="flex items-center gap-2">
            <Wallet className="h-4 w-4" />
            {t("wallet.connect")}
          </span>
        )}
      </Button>
    );
  }

  return (
    <div className="relative">
      {menuOpen ? (
        <div
          onClick={handleCloseMenu}
          className="fixed inset-0 z-40 cursor-default"
          aria-hidden="true"
        />
      ) : null}

      <motion.button
        type="button"
        onClick={handleToggleMenu}
        whileTap={{ scale: 0.97 }}
        className={cn(
          "relative z-50 inline-flex h-10 items-center gap-2 rounded-xl px-3 backdrop-blur",
          boxed
            ? "border border-border bg-surface-2/60 transition-all duration-200 hover:border-primary/30"
            : "w-full justify-center transition-colors hover:bg-foreground/5",
          menuOpen && "border-primary/40",
        )}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        <span className="relative flex h-2 w-2" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
        </span>
        <span className="font-mono text-sm text-foreground">
          {truncateAddress(address)}
        </span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-muted transition-transform",
            menuOpen && "rotate-180",
          )}
        />
      </motion.button>

      <AnimatePresence>
        {menuOpen ? (
          <motion.div
            key="menu"
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 500, damping: 32 }}
            className="glass-tight absolute right-0 top-12 z-50 w-64 overflow-hidden rounded-2xl p-1.5"
            role="menu"
          >
            <div className="px-3 py-2.5">
              <p className="text-[11px] uppercase tracking-wider text-muted-2">
                {t("wallet.connected")}
              </p>
              <p className="mt-0.5 truncate font-mono text-xs text-foreground">
                {address}
              </p>
              <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-surface-3 px-2 py-0.5 text-[11px] text-muted">
                <NetworkIcon className="h-3 w-3" />
                {networkName(chainId)}
              </p>
            </div>

            <div className="my-1 h-px bg-border" />

            <MenuItem
              icon={copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
              label={copied ? t("wallet.copied") : t("wallet.copyAddress")}
              onClick={copyAddress}
            />
            <MenuItem
              icon={<ExternalLink className="h-4 w-4" />}
              label={t("wallet.viewOnExplorer")}
              href={explorerAddressUrl(chainId, address)}
            />
            <MenuItem
              icon={<NetworkIcon className="h-4 w-4" />}
              label={t("wallet.switchNetwork")}
              onClick={handleSwitchNetwork}
            />
            <MenuItem
              icon={<LogOut className="h-4 w-4" />}
              label={t("wallet.disconnect")}
              danger
              onClick={handleDisconnect}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  href,
  danger,
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  href?: string;
  danger?: boolean;
}) {
  const content = (
    <span
      className={cn(
        "flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors",
        danger
          ? "text-danger hover:bg-danger/10"
          : "text-foreground hover:bg-surface-2",
      )}
    >
      {icon}
      {label}
    </span>
  );

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        role="menuitem"
        className="block"
      >
        {content}
      </a>
    );
  }

  return (
    <button type="button" role="menuitem" onClick={onClick} className="block w-full text-left">
      {content}
    </button>
  );
}