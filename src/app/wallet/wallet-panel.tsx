"use client";

import {
  Wallet,
  Copy,
  ExternalLink,
  Check,
  Network,
  Zap,
  AlertCircle,
  Link2,
  QrCode,
  Repeat,
  Send,
} from "lucide-react";
import { useState, useEffect, useCallback, memo, startTransition } from "react";
import { useAppKitSafe } from "@/lib/wagmi/appkit-init";
import {
  useAccount,
  useBalance,
  useChainId,
  useSwitchChain,
} from "wagmi";
import { formatUnits } from "viem";
import { PageContainer } from "@/components/page-container";
import { Card, EmptyState } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  BASE_NETWORKS,
  networkName,
  NETWORKS_BY_ID,
  rpcUrl,
  explorerAddressUrl,
} from "@/lib/wagmi/chains";
import { cn } from "@/lib/utils";
import { getChainByChainId } from "@/lib/chains/registry";
import { useI18n } from "@/lib/i18n";
import { useAskAgent } from "@/lib/use-ask-agent";
import { AttestcoinPanel } from "@/components/attestcoin-panel";
import { TokenAssets } from "@/components/wallet/token-assets";
import { ActivityLog } from "@/components/wallet/activity-log";
import { ChainBreakdown } from "@/components/wallet/chain-breakdown";
import { ReceiveModal } from "@/components/wallet/receive-modal";
import { SwapModal } from "@/components/wallet/swap-modal";

function shorten(address: string) {
  if (!address) return "";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const NetworkRow = memo(function NetworkRow({
  net,
  active,
  onSwitch,
}: {
  net: { id: number | string; name: string };
  active: boolean;
  onSwitch: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      className={cn(
        "flex items-center justify-between rounded-xl border px-4 py-3 transition-all",
        active
          ? "border-primary/40 bg-primary/10"
          : "border-border bg-surface-2/40 hover:border-primary/30",
      )}
    >
      <button type="button" onClick={onSwitch} disabled={active} className="flex-1 text-left">
        <p className="text-sm font-medium text-foreground">{net.name}</p>
        <p className="text-xs text-muted-2">{t("wallet.chainIdWithId", { chainId: net.id })}</p>
      </button>
      <div className="flex items-center gap-2">
        {active ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/20 px-2 py-0.5 text-[11px] font-medium text-primary">
            <Check className="h-3 w-3" /> {t("wallet.active")}
          </span>
        ) : null}
      </div>
    </div>
  );
});

function ChainSwitchError({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3">
      <AlertCircle className="h-4 w-4 shrink-0 text-danger" />
      <p className="flex-1 text-xs text-danger">{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="text-danger/60 hover:text-danger transition-colors"
      >
        <AlertCircle className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function WalletPanel() {
  const { t } = useI18n();
  const askAgent = useAskAgent();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { startTransition(() => setMounted(true)); }, []);

  const { open } = useAppKitSafe();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const [copied, setCopied] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [swapOpen, setSwapOpen] = useState(false);
  const [swapFrom, setSwapFrom] = useState<string | null>(null);

  const native = useBalance({ address });

  const chain = NETWORKS_BY_ID[chainId];
  const chainDef = getChainByChainId(chainId);

  const nativeDisplay = native.data
    ? Number(formatUnits(native.data.value, native.data.decimals)).toLocaleString(undefined, {
        maximumFractionDigits: 4,
      })
    : "0";
  const nativeSymbol = native.data?.symbol ?? chain?.nativeCurrency.symbol ?? "ETH";
  const nativeName = chain?.nativeCurrency.name ?? "Ether";

  const copyAddress = useCallback(() => {
    if (!address) return;
    navigator.clipboard?.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [address]);

  const handleSwitchChain = useCallback(
    async (targetId: number) => {
      setSwitchError(null);
      try {
        await switchChainAsync({ chainId: targetId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : t("wallet.switchFailed");
        if (msg.includes("rejected") || msg.includes("denied")) {
          setSwitchError(t("wallet.switchRejected"));
        } else if (msg.includes("Unrecognized chain")) {
          setSwitchError(t("wallet.switchUnrecognized"));
        } else {
          setSwitchError(t("wallet.switchFailed"));
        }
      }
    },
    [switchChainAsync, t],
  );

  const openSwap = useCallback((fromSymbol?: string) => {
    setSwapFrom(fromSymbol ?? null);
    setSwapOpen(true);
  }, []);

  const sendViaAgent = useCallback(() => {
    askAgent(t("wallet.sendPromptGeneric", { chain: chainDef?.name ?? `Chain ${chainId}` }));
  }, [askAgent, t, chainDef, chainId]);

  if (!mounted) {
    return (
      <PageContainer
        title={t("wallet.title")}
        description={t("wallet.description")}
        icon={<Wallet className="h-5 w-5" />}
      >
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
          {t("wallet.loading")}
        </div>
      </PageContainer>
    );
  }

  if (!isConnected || !address) {
    return (
      <PageContainer
        title={t("wallet.title")}
        description={t("wallet.description")}
        icon={<Wallet className="h-5 w-5" />}
      >
        <EmptyState
          icon={<Wallet className="h-6 w-6" />}
          title={t("wallet.notConnectedTitle")}
          description={t("wallet.notConnectedDesc")}
          action={
            <Button variant="primary" size="md" onClick={() => open()}>
              <Wallet className="h-4 w-4" />
              {t("wallet.connect")}
            </Button>
          }
        />

        <Card>
          <h2 className="mb-4 text-sm font-semibold text-foreground">{t("wallet.supportedNetworks")}</h2>
          <div className="space-y-2">
            {BASE_NETWORKS.map((net) => (
              <div
                key={net.id}
                className="flex items-center justify-between rounded-xl border border-border bg-surface-2/40 px-4 py-3"
              >
                <div>
                  <p className="text-sm font-medium text-foreground">{net.name}</p>
                  <p className="text-xs text-muted-2">
                    {net.nativeCurrency.symbol} · {t("wallet.chainIdWithId", { chainId: net.id })}
                  </p>
                </div>
                {/* D14: URLs must never overflow the row — truncate with the
                    full value on hover/long-press (title) instead of clipping
                    mid-character (live-observed at 390px: mainnet RPC 257px
                    span extended 15px past the viewport edge). */}
                <span
                  title={net.rpcUrls.default.http[0]}
                  className="min-w-0 max-w-[52%] truncate font-mono text-xs text-muted sm:max-w-xs"
                >
                  {net.rpcUrls.default.http[0]}
                </span>
              </div>
            ))}
          </div>
        </Card>

        <AttestcoinPanel />
      </PageContainer>
    );
  }

  return (
    <PageContainer
      title={t("wallet.title")}
      description={t("wallet.description")}
      icon={<Wallet className="h-5 w-5" />}
    >
      {switchError ? (
        <ChainSwitchError message={switchError} onDismiss={() => setSwitchError(null)} />
      ) : null}

      {/* ── Account header: address, native balance, portfolio, actions ── */}
      <Card className="bg-gradient-to-br from-primary/5 to-transparent">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs text-muted">{t("wallet.connectedWallet")}</p>
            <button
              type="button"
              onClick={copyAddress}
              className="mt-1 flex items-center gap-2 font-mono text-sm text-foreground hover:text-primary transition-colors cursor-pointer"
              aria-label={t("wallet.copyAddress")}
            >
              {shorten(address)}
              {copied ? (
                <Check className="h-3.5 w-3.5 text-success" />
              ) : (
                <Copy className="h-3.5 w-3.5 text-muted-2" />
              )}
            </button>
            <p className="mt-1.5 text-[11px] text-muted-3">{t("wallet.addressHint")}</p>
          </div>
          <div className="text-left sm:text-right">
            <p className="text-xs text-muted">{t("wallet.nativeBalance")}</p>
            <p className="font-mono text-2xl font-semibold tabular-nums text-foreground">
              {native.isLoading ? "…" : `${nativeDisplay} ${nativeSymbol}`}
            </p>
            {/* N21: the "≈ $… priced assets" portfolio valuation is fully
                removed (owner: it never evaluated a wallet correctly). No
                replacement — per-token live prices stay in the asset list. */}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" size="sm" onClick={sendViaAgent}>
            <Send className="h-4 w-4" />
            {t("wallet.send")}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setReceiveOpen(true)}>
            <QrCode className="h-4 w-4" />
            {t("wallet.receive")}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => openSwap()}>
            <Repeat className="h-4 w-4" />
            {t("wallet.swap")}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => open()}>
            <Zap className="h-4 w-4" />
            {t("wallet.manage")}
          </Button>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <div className="glass-item rounded-2xl p-5 transition-all duration-300 hover:-translate-y-0.5">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted">{t("wallet.network")}</p>
            <Network className="h-4 w-4 text-muted-2" aria-hidden />
          </div>
          <p className="mt-2 truncate text-2xl font-semibold tracking-tight text-foreground tabular-nums">
            {networkName(chainId).split(" ")[0]}
          </p>
          <p className="mt-1 text-xs text-muted-2">
            {chain ? t("wallet.chainIdWithId", { chainId: chain.id }) : t("wallet.unsupported")}
          </p>
        </div>
        <div className="glass-item rounded-2xl p-5 transition-all duration-300 hover:-translate-y-0.5">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted">{t("wallet.nativeToken")}</p>
            <span className="text-sm font-semibold text-muted-2">{nativeSymbol}</span>
          </div>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground tabular-nums">
            {native.isLoading ? "…" : nativeDisplay}
          </p>
          <p className="mt-1 truncate text-xs text-muted-2">{nativeName}</p>
        </div>
      </div>

      {/* ── R10 Feature C: native balance on EVERY registry chain, broken
          down by symbol with share bars + tap-to-switch rows (public RPC
          reads; no fiat valuation — N21 stays honored). ── */}
      <ChainBreakdown key={address} address={address} activeChainId={chainId} onSwitch={handleSwitchChain} />

      {/* ── Assets: real token discovery + native (C8) ── */}
      <TokenAssets
        chainId={chainId}
        nativeBalanceHuman={nativeDisplay}
        nativeSymbol={nativeSymbol}
        nativeName={nativeName}
        onSwap={openSwap}
      />

      {/* ── Activity: on-chain txs + agent signatures merged (C8) ── */}
      <ActivityLog address={address} chainId={chainId} />

      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">{t("wallet.networks")}</h2>
        </div>

        <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {BASE_NETWORKS.map((net) => (
            <NetworkRow
              key={net.id}
              net={{ id: net.id as number, name: net.name }}
              active={net.id === chainId}
              onSwitch={() => handleSwitchChain(net.id as number)}
            />
          ))}
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm text-muted">
              <Network className="h-4 w-4" /> {t("wallet.rpcEndpoint")}
            </span>
            <a
              href={rpcUrl(chainId)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 font-mono text-xs text-primary hover:underline"
            >
              {rpcUrl(chainId)}
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm text-muted">
              <Link2 className="h-4 w-4" /> {t("wallet.blockExplorer")}
            </span>
            <a
              href={explorerAddressUrl(chainId, address)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 font-mono text-xs text-primary hover:underline"
            >
              {NETWORKS_BY_ID[chainId]?.blockExplorers?.default.url ?? "#"}
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted">{t("wallet.chainId")}</span>
            <span className="font-mono text-sm text-foreground">{chainId}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted">{t("wallet.nativeDecimals")}</span>
            <span className="font-mono text-sm text-foreground">
              {chain?.nativeCurrency.decimals ?? 18}
            </span>
          </div>
        </div>
      </Card>

      <AttestcoinPanel />

      {receiveOpen ? (
        <ReceiveModal address={address} chainId={chainId} onClose={() => setReceiveOpen(false)} />
      ) : null}
      {swapOpen ? (
        <SwapModal
          chainId={chainId}
          defaultFrom={swapFrom}
          onClose={() => setSwapOpen(false)}
        />
      ) : null}
    </PageContainer>
  );
}
