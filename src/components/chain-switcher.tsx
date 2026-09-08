"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { ChevronDown, Check, AlertTriangle, ArrowUpDown } from "lucide-react";
import { CHAIN_REGISTRY, getChainByChainId } from "@/lib/chains/registry";
import { ChainIcon } from "@/components/chain-icon";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Network selector — the real chain switcher (brief §3, §9).
//
// - Covers the full supported chain set from the registry.
// - Testnet vs mainnet is unmistakable: amber "Testnet" chip + grouped sections.
// - Switching goes through wagmi's useSwitchChain → wallet_switchEthereumChain
//   with automatic add-on-4902 fallback. Where the wallet supports it (MetaMask
//   chain permissions, WalletConnect session namespaces, Rabby) there is NO
//   per-switch prompt. Wallets that always prompt are a wallet limitation.
// ─────────────────────────────────────────────────────────────────────────────

function ChainTile({ chainId, size = 18 }: { chainId: number; size?: number }) {
  // N14: real chain icons from @web3icons/react (CTC → its token logo on a
  // dark chip; letter tile is the missing-icon fallback only).
  return <ChainIcon chainId={chainId} size={size} />;
}

export function ChainSwitcher({ compact = false, plain = false }: { compact?: boolean; plain?: boolean }) {
  const { t } = useI18n();
  const { isConnected } = useAccount();
  const activeChainId = useChainId();
  const { switchChain, isPending: isSwitching, error: switchError } = useSwitchChain();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const activeChain = activeChainId ? getChainByChainId(activeChainId) : undefined;

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const mainnets = CHAIN_REGISTRY.filter((c) => !c.testnet);
  const testnets = CHAIN_REGISTRY.filter((c) => c.testnet);

  const renderRow = (chainId: number) => {
    const chain = getChainByChainId(chainId)!;
    const isActive = chainId === activeChainId;
    return (
      <button
        key={chain.key}
        type="button"
        onClick={() => {
          if (!isActive) switchChain({ chainId });
          setOpen(false);
        }}
        disabled={isSwitching}
        aria-current={isActive ? "true" : undefined}
        className={cn(
          "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
          "hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none",
          isActive && "bg-foreground/10",
          isSwitching && "opacity-60",
        )}
      >
        <ChainTile chainId={chainId} size={20} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground/90">{chain.name}</span>
          <span className="block text-[11px] text-foreground/40">
            {chain.nativeCurrency.symbol} · ID {chain.chainId}
          </span>
        </span>
        {chain.testnet ? (
          <span
            className="shrink-0 rounded-md border border-amber-600/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300"
            title={t("chain.testnetBadge")}
          >
            {t("chain.testnetChip")}
          </span>
        ) : (
          <span
            className="shrink-0 rounded-md border border-emerald-600/25 bg-emerald-500/10 dark:border-emerald-400/20 dark:bg-emerald-400/5 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-emerald-700/80 dark:text-emerald-300/80"
            title={t("chain.mainnetBadge")}
          >
            {t("chain.mainnetChip")}
          </span>
        )}
        {isActive ? <Check className="h-4 w-4 shrink-0 text-primary" aria-label={t("chain.active")} /> : null}
      </button>
    );
  };

  // C14: a CALM trigger — the Phase-2 saturated gradient pill was exactly
  // the "too ugly, contrastive, oversaturated" complaint. This one sits on
  // the surface, shows the active chain + a quiet testnet marker, and
  // reserves color for state (switching) only.
  // `plain` = flat (no neumorphic) for INSIDE the navbar's neumorphic capsule
  // (C13: never stack shadow-on-shadow); default keeps the calm neumorphic
  // look for standalone/drawer rows. Non-compact renders the chain name
  // (desktop capsule) — compact is icon-only (mobile drawer).
  const trigger = (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      disabled={!isConnected}
      aria-haspopup="listbox"
      aria-expanded={open}
      title={isConnected ? t("chain.switcherTitle") : t("chain.connectFirst")}
      className={cn(
        "group flex items-center gap-2 rounded-2xl px-3 py-2 font-medium transition-all",
        plain ? "bg-transparent hover:bg-surface-2/60" : "neumorphic",
        "text-foreground/90 hover:text-foreground",
        !isConnected && "cursor-not-allowed opacity-50",
        compact && "px-2.5",
      )}
    >
      <AnimatePresence mode="wait" initial={false}>
        {activeChain ? (
          <motion.span
            key={activeChain.chainId}
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.6, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="flex items-center gap-2"
          >
            <ChainTile chainId={activeChain.chainId} size={18} />
            {!compact && (
              <span className="hidden max-w-[150px] shrink-0 truncate text-sm text-foreground/90 sm:inline">
                {activeChain.shortName}
              </span>
            )}
            {activeChain.testnet ? (
              <span className="rounded-md border border-amber-600/30 bg-amber-500/10 px-1.5 py-px text-[9px] font-bold tracking-wide text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300">
                {t("chain.testnetChip")}
              </span>
            ) : null}
          </motion.span>
        ) : (
          <motion.span
            key="none"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-center gap-2 text-sm text-muted"
          >
            <ArrowUpDown className="h-4 w-4" aria-hidden />
            {!compact && <span className="hidden sm:inline">{t("chain.noNetwork")}</span>}
          </motion.span>
        )}
      </AnimatePresence>
      {isSwitching ? (
        <span
          className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-muted/30 border-t-primary"
          aria-label={t("chain.switching")}
        />
      ) : (
        <ChevronDown
          className={cn("h-3.5 w-3.5 shrink-0 text-muted transition-transform", open && "rotate-180")}
          aria-hidden
        />
      )}
    </button>
  );

  return (
    <div ref={rootRef} className="relative">
      {trigger}
      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            role="listbox"
            aria-label={t("chain.switcherTitle")}
            className="glass-dropdown acp-scroll absolute right-0 top-[calc(100%+10px)] z-50 max-h-[70vh] w-72 overflow-y-auto rounded-2xl p-2"
          >
            {switchError ? (
              <div className="mb-2 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 p-2.5 text-xs text-danger">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>{t("chain.switchFailed")}</span>
              </div>
            ) : null}
            <p className="px-3 pb-1 pt-1 text-[10px] font-bold uppercase tracking-widest text-foreground/30">
              {t("chain.sectionMainnet")}
            </p>
            {mainnets.map((c) => renderRow(c.chainId))}
            <p className="px-3 pb-1 pt-3 text-[10px] font-bold uppercase tracking-widest text-amber-700/50 dark:text-amber-300/50">
              {t("chain.sectionTestnet")}
            </p>
            {testnets.map((c) => renderRow(c.chainId))}
            <p className="px-3 pb-1 pt-3 text-[10px] leading-relaxed text-foreground/25">{t("chain.switchHint")}</p>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
