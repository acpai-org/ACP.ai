"use client";

import { useEffect, useMemo, useState, startTransition } from "react";
import { createPortal } from "react-dom";
import { X, Repeat, Sparkles, ShieldCheck, ArrowRight } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { useBalance, useAccount } from "wagmi";
import { formatUnits } from "viem";
import { useI18n } from "@/lib/i18n";
import { useAskAgent } from "@/lib/use-ask-agent";
import { getChainByChainId } from "@/lib/chains/registry";
import { useTokenBalances } from "@/lib/use-token-balances";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Swap modal (C8): the Wallet tab's swap entry point.
//
// Hard boundary 2: this app has NO swap router integration — swaps execute
// through the agent's FIXED toolset (Attestcoin-secured cross-chain swap /
// same-chain equivalent), always gated by the wallet signature in the wallet
// popup. This modal composes an intent and hands it to the agent via the
// palette-ask bridge; the chat then runs the full traced flow.
//
// Options derive from LIVE balances: the native token plus every discovered
// ERC-20 with a balance > 0.
// ─────────────────────────────────────────────────────────────────────────────

interface SwapOption {
  /** Unique option identity: "native" or the token's contract address. */
  id: string;
  kind: "native" | "erc20";
  symbol: string;
  name: string;
  balanceHuman: string;
  address: string | null;
}

export function SwapModal({
  chainId,
  defaultFrom,
  onClose,
}: {
  chainId: number;
  defaultFrom?: string | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const askAgent = useAskAgent();
  const [mounted, setMounted] = useState(false);
  const [fromSelection, setFromSelection] = useState<string | null>(defaultFrom ?? null);
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  useEffect(() => { startTransition(() => setMounted(true)); }, []);

  const { address } = useAccount();
  const native = useBalance({ address });
  const tokens = useTokenBalances();

  const chain = getChainByChainId(chainId);
  const chainName = chain?.name ?? `Chain ${chainId}`;

  const options = useMemo<SwapOption[]>(() => {
    const nativeSymbol = native.data?.symbol ?? chain?.nativeCurrency.symbol ?? "ETH";
    const nativeBalance = native.data
      ? Number(formatUnits(native.data.value, native.data.decimals)).toLocaleString(undefined, {
          maximumFractionDigits: 4,
        })
      : "0";
    const opts: SwapOption[] = [
      {
        id: "native",
        kind: "native",
        symbol: nativeSymbol,
        name: native.data?.symbol ? native.data.symbol : (chain?.nativeCurrency.name ?? "Ether"),
        balanceHuman: nativeBalance,
        address: null,
      },
    ];
    const seen = new Set<string>();
    for (const tk of tokens.data ?? []) {
      // Testnet token lists routinely contain same-symbol clones (scam
      // airdrops copy USDC's symbol). Identity = the CONTRACT address —
      // dedupe defensively and key/value by it so React keys stay unique
      // and the user's selection is the exact token they meant.
      if (!tk.address || seen.has(tk.address)) continue;
      seen.add(tk.address);
      opts.push({
        id: tk.address,
        kind: "erc20",
        symbol: tk.symbol,
        name: tk.name,
        balanceHuman: tk.balanceHuman ?? "0",
        address: tk.address,
      });
    }
    return opts;
  }, [native.data, tokens.data, chain]);

  // Effective from-selection: the user's explicit choice, else the requested
  // default when it exists in the live options, else the first option.
  const from = useMemo(() => {
    if (fromSelection && options.some((o) => o.id === fromSelection)) return fromSelection;
    if (defaultFrom && options.some((o) => o.symbol === defaultFrom)) {
      const match = options.find((o) => o.symbol === defaultFrom)!;
      return match.id;
    }
    return options[0]?.id ?? "";
  }, [fromSelection, defaultFrom, options]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const selected = options.find((o) => o.id === from);

  const prompt = useMemo(() => {
    const amt = amount.trim();
    const target = to.trim().toUpperCase();
    if (!amt || !target || !selected) return null;
    return t("wallet.swapPrompt", {
      amount: amt,
      from: selected.symbol.toUpperCase(),
      to: target,
      chain: chainName,
    });
  }, [amount, selected, to, chainName, t]);

  const submit = () => {
    if (!prompt) return;
    askAgent(prompt);
    onClose();
  };

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="swap-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        className="fixed inset-0 z-[300] flex items-center justify-center bg-[var(--overlay-bg)] p-4 backdrop-blur-sm"
        onClick={onClose}
        role="dialog"
        aria-modal="true"
        aria-label={t("wallet.swapTitle")}
      >
        <motion.div
          key="swap-card"
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
                <Repeat className="h-4 w-4 text-primary" />
                {t("wallet.swapTitle")}
              </h3>
              <p className="mt-0.5 text-[11px] text-muted-2">{t("wallet.swapDesc")}</p>
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

          <div className="mt-4 space-y-3">
            <div>
              <label htmlFor="swap-from" className="text-[10px] font-medium uppercase tracking-wider text-muted-2">
                {t("wallet.swapFrom")}
              </label>
              <div className="mt-1 flex gap-2">
                <select
                  id="swap-from"
                  value={from}
                  onChange={(e) => setFromSelection(e.target.value)}
                  className="neumorphic-inset h-9 min-w-0 flex-1 rounded-xl border border-border bg-surface-2/50 px-2.5 text-xs text-foreground focus:border-primary/50 focus:outline-none cursor-pointer"
                >
                  {options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.symbol} · {o.balanceHuman}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder={
                    selected ? t("wallet.swapAmountPlaceholder", { max: selected.balanceHuman }) : "0.0"
                  }
                  aria-label={t("wallet.swapAmount")}
                  className="neumorphic-inset h-9 w-32 rounded-xl border border-border bg-surface-2/50 px-2.5 font-mono text-xs text-foreground focus:border-primary/50 focus:outline-none"
                />
              </div>
              {selected && selected.kind === "native" ? (
                <p className="mt-1 text-[9px] text-muted-3">{t("wallet.swapGasNote")}</p>
              ) : null}
            </div>

            <div className="flex justify-center" aria-hidden>
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary">
                <ArrowRight className="h-3.5 w-3.5 rotate-90" />
              </span>
            </div>

            <div>
              <label htmlFor="swap-to" className="text-[10px] font-medium uppercase tracking-wider text-muted-2">
                {t("wallet.swapTo")}
              </label>
              <input
                id="swap-to"
                type="text"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder={t("wallet.swapToPlaceholder")}
                autoComplete="off"
                spellCheck={false}
                className="neumorphic-inset mt-1 h-9 w-full rounded-xl border border-border bg-surface-2/50 px-2.5 font-mono text-xs uppercase text-foreground placeholder:font-sans placeholder:text-muted-3 focus:border-primary/50 focus:outline-none"
              />
            </div>
          </div>

          {prompt ? (
            <div className="mt-4 rounded-xl border border-primary/25 bg-primary/5 px-3 py-2.5">
              <p className="text-[9px] font-semibold uppercase tracking-wider text-primary/80">
                {t("wallet.swapIntentPreview")}
              </p>
              <p className="mt-1 font-mono text-[11px] leading-relaxed text-foreground/80">&ldquo;{prompt}&rdquo;</p>
            </div>
          ) : null}

          <button
            type="button"
            disabled={!prompt}
            onClick={submit}
            className={cn(
              "mt-4 flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-xs font-semibold transition-all",
              prompt
                ? "btn-bg-primary text-primary-foreground hover:brightness-110 cursor-pointer"
                : "cursor-not-allowed bg-surface-2 text-muted-3",
            )}
          >
            <Sparkles className="h-3.5 w-3.5" />
            {t("wallet.swapAskAgent")}
          </button>

          <p className="mt-3 flex items-start gap-1.5 text-[10px] leading-relaxed text-muted-3">
            <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-primary/60" />
            {t("wallet.swapSecurityNote")}
          </p>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
