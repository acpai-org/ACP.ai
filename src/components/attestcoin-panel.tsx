"use client";

import { memo } from "react";
import Link from "next/link";
import {
  Hexagon,
  RefreshCcw,
  ExternalLink,
  Activity,
  Layers,
  ArrowUpToLine,
  AlertCircle,
  Gauge,
  ShieldCheck,
  Radar,
  CheckCircle2,
  BadgeCheck,
  History,
  ArrowRight,
  type LucideIcon,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { useFormatters } from "@/lib/use-formatters";
import {
  useAttestcoinStatus,
  lagSeverity,
  type AttestChainRow,
  type PollerRow,
} from "@/lib/use-attestcoin";
import { useRecentAttestations, type RecentAttestationRow } from "@/lib/api";
import { shortenAddress } from "@/lib/format";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Live Attestcoin Protocol panel (Creditcoin attestation state).
// Reads GET /api/attestcoin/status — ChainInfo precompile data straight from
// the Creditcoin network selected via ATTESTCOIN_NETWORK.
// ─────────────────────────────────────────────────────────────────────────────

const CC_MAINNET_APPS = process.env.NEXT_PUBLIC_POLKADOT_APPS_MAINNET_URL;
const CC_TESTNET_APPS = process.env.NEXT_PUBLIC_POLKADOT_APPS_TESTNET_URL;

function num(n: number | null): string {
  return n === null ? "—" : n.toLocaleString();
}

const LAG_STYLES: Record<string, string> = {
  fresh: "bg-success/10 text-success border-success/30",
  delayed: "bg-warning/10 text-warning border-warning/30",
  stale: "bg-danger/10 text-danger border-danger/30",
  unknown: "bg-surface-3 text-muted border-border",
};

const LAG_TIP_KEYS = {
  fresh: "wallet.attestLagTipFresh",
  delayed: "wallet.attestLagTipDelayed",
  stale: "wallet.attestLagTipStale",
  unknown: "wallet.attestLagTipUnknown",
} as const;

function LagBadge({ lag }: { lag: number | null }) {
  const { t } = useI18n();
  const severity = lagSeverity(lag);
  const label =
    severity === "unknown"
      ? t("wallet.attestLagUnknown")
      : t("wallet.attestLagBlocks", { blocks: (lag ?? 0).toLocaleString() });
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium tabular-nums",
        LAG_STYLES[severity],
      )}
      title={t(LAG_TIP_KEYS[severity])}
    >
      {severity === "unknown" ? (
        <AlertCircle className="h-3 w-3" />
      ) : (
        <Gauge className="h-3 w-3" />
      )}
      {label}
    </span>
  );
}

function MiniStat({
  icon: Icon,
  label,
  value,
  sublabel,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sublabel?: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-2/40 px-3.5 py-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-2">{label}</p>
        <p className="truncate font-mono text-sm font-semibold tabular-nums text-foreground">
          {value}
        </p>
        {sublabel ? <p className="truncate text-[11px] text-muted-2">{sublabel}</p> : null}
      </div>
    </div>
  );
}

const AttestationChainCard = memo(function AttestationChainCard({
  chain,
}: {
  chain: AttestChainRow;
}) {
  const { t } = useI18n();
  return (
    <div className="group rounded-xl border border-border bg-surface-2/40 p-4 transition-all duration-200 hover:border-primary/25 hover:bg-surface-2/70">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
            <Layers className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{chain.name}</p>
            <p className="font-mono text-[10px] text-muted-2">
              {t("wallet.attestChainKey", { chainKey: chain.chainKey })} · chainId{" "}
              {chain.evmChainId}
            </p>
          </div>
        </div>
        <LagBadge lag={chain.lag} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-surface/60 px-2.5 py-1.5">
          <p className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-2">
            <ShieldCheck className="h-3 w-3 text-success/80" />
            {t("wallet.attestAttestedHeight")}
          </p>
          <p className="font-mono text-xs font-semibold tabular-nums text-foreground">
            {num(chain.attestedHeight)}
          </p>
        </div>
        <div className="rounded-lg bg-surface/60 px-2.5 py-1.5">
          <p className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-2">
            <ArrowUpToLine className="h-3 w-3 text-muted-2" />
            {t("wallet.attestSourceHead")}
          </p>
          <p className="font-mono text-xs font-semibold tabular-nums text-foreground">
            {num(chain.sourceHead)}
          </p>
        </div>
      </div>

      {chain.attestedHash ? (
        <p
          className="mt-2 truncate font-mono text-[10px] text-muted-2"
          title={chain.attestedHash}
        >
          {t("wallet.attestTip")}: {chain.attestedHash}
        </p>
      ) : null}
    </div>
  );
});

function StatusSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true">
      <div className="grid grid-cols-2 gap-2">
        <div className="shimmer h-14 rounded-xl" />
        <div className="shimmer h-14 rounded-xl" />
      </div>
      <div className="shimmer h-24 rounded-xl" />
    </div>
  );
}

/** Server-side attestation watcher liveness — the poller's heartbeat. */
function WatcherRow({ poller }: { poller: PollerRow | undefined }) {
  const { t } = useI18n();
  const { timeAgo } = useFormatters();
  if (!poller || !poller.running) return null;

  const watching = poller.watching;
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-border bg-surface-2/40 px-3.5 py-2.5"
      role="status"
    >
      <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
        <Radar className="h-4 w-4 text-primary" aria-hidden />
        <span className="absolute h-1 w-1 animate-pulse rounded-full bg-primary" aria-hidden />
      </span>
      <p className="text-[11px] font-medium text-foreground">
        {watching != null && watching > 0
          ? t("wallet.watcherWatching", { count: watching })
          : t("wallet.watcherIdle")}
      </p>
      <span className="text-[10px] text-muted-3">·</span>
      <p className="text-[11px] text-muted-2">
        {poller.lastTickAt
          ? t("wallet.watcherLastTick", { time: timeAgo(poller.lastTickAt) })
          : t("wallet.watcherStarting")}
      </p>
      {poller.flippedTotal > 0 ? (
        <span className="inline-flex items-center gap-1 text-[11px] text-success">
          <CheckCircle2 className="h-3 w-3" aria-hidden />
          {t("wallet.watcherFlips", { count: poller.flippedTotal })}
        </span>
      ) : null}
      {poller.lastError ? (
        <p className="w-full truncate text-[10px] text-warning" title={poller.lastError}>
          {t("wallet.watcherError")}
        </p>
      ) : null}
    </div>
  );
}

const RecentRow = memo(function RecentRow({ row }: { row: RecentAttestationRow }) {
  const { timeAgo } = useFormatters();
  return (
    <Link
      href="/payments"
      className="group flex items-center gap-2.5 rounded-xl px-2.5 py-2 transition-colors hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
      title={row.attestRoot ?? undefined}
    >
      <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-success/10 text-success">
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
        {row.onchainVerified ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-surface ring-1 ring-success/40">
            <BadgeCheck className="h-2 w-2 text-success" aria-hidden />
          </span>
        ) : null}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground">
          {row.recipientLabel ?? shortenAddress(row.recipientAddress)}
        </p>
        <p className="truncate text-[10px] text-muted-2">
          {row.amountHuman} {row.token} · {row.chainName} · {timeAgo(row.attestedAt)}
        </p>
      </div>
      <ArrowRight
        className="h-3 w-3 shrink-0 text-muted-3 opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100"
        aria-hidden
      />
    </Link>
  );
});

/**
 * Payment-side attestation feed — the most recent payments the server-side
 * poller flipped to attested (GET /api/attestcoin/recent, local DB only).
 * Each row deep-links to the payments page; the on-chain-verified rows carry
 * a BadgeCheck corner mark.
 */
function RecentAttestations() {
  const { t } = useI18n();
  const { data: recent, isLoading } = useRecentAttestations();

  const rows = recent ?? [];
  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-2.5">
      <div className="flex items-center justify-between px-0.5 pb-1.5">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
          <History className="h-3 w-3 text-primary/70" aria-hidden />
          {t("wallet.recentTitle")}
        </div>
        <span className="text-[10px] tabular-nums text-muted-3">{rows.length}</span>
      </div>

      {isLoading ? (
        <div className="space-y-1.5" aria-busy="true">
          <div className="shimmer h-9 rounded-xl" />
          <div className="shimmer h-9 rounded-xl" />
          <div className="shimmer h-9 rounded-xl" />
        </div>
      ) : rows.length === 0 ? (
        <p className="px-1 py-1.5 text-[11px] leading-relaxed text-muted-2">
          {t("wallet.recentEmpty")}
        </p>
      ) : (
        <div className="acp-scroll max-h-64 space-y-0.5 overflow-y-auto pr-0.5">
          {rows.map((row) => (
            <RecentRow key={row.id} row={row} />
          ))}
          {rows.length > 0 ? (
            <Link
              href="/payments"
              className="flex items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[10px] font-medium text-muted-2 transition-colors hover:bg-surface-2/60 hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
            >
              {t("wallet.recentViewAll")}
              <ArrowRight className="h-3 w-3" aria-hidden />
            </Link>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function AttestcoinPanel() {
  const { t } = useI18n();
  const { timeAgo } = useFormatters();
  const { state, refresh } = useAttestcoinStatus();

  const appsUrl = state.phase === "ready" && state.data.env === "mainnet" ? CC_MAINNET_APPS : CC_TESTNET_APPS;

  return (
    <Card>
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Hexagon className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">{t("wallet.creditcoinTitle")}</h2>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
              state.phase === "ready"
                ? "border-success/30 bg-success/10 text-success"
                : "border-primary/30 bg-primary/10 text-primary",
            )}
          >
            {state.phase === "ready" ? (
              <>
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success/70" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
                </span>
                {t("wallet.attestLive")}
              </>
            ) : (
              t("wallet.attestConnecting")
            )}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="hit-slop h-8 gap-1.5 px-2.5 text-xs"
            onClick={refresh}
            disabled={state.phase === "loading"}
            title={t("wallet.attestRefresh")}
            aria-label={t("wallet.attestRefresh")}
          >
            <RefreshCcw
              className={cn("h-3.5 w-3.5", state.phase === "ready" && state.refreshing && "animate-spin")}
            />
          </Button>
        </div>
      </div>

      <p className="mb-4 text-xs leading-relaxed text-muted">{t("wallet.creditcoinDesc")}</p>

      {state.phase === "loading" ? <StatusSkeleton /> : null}

      {state.phase === "ready" ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <MiniStat
              icon={Activity}
              label={t("wallet.attestCc3Block")}
              value={num(state.data.cc3Block)}
              sublabel={t("wallet.creditcoinTestnet")}
            />
            <MiniStat
              icon={Layers}
              label={t("wallet.attestSupportedChains")}
              value={String(state.data.chains.length)}
              sublabel={state.data.chains.map((c) => c.name).join(" · ")}
            />
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {state.data.chains.map((chain) => (
              <AttestationChainCard key={chain.chainKey} chain={chain} />
            ))}
          </div>

          <WatcherRow poller={state.data.poller} />

          <RecentAttestations />

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <p className="flex items-center gap-1.5 text-[11px] text-muted-2">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-success/60" />
              {t("wallet.attestUpdated", { time: timeAgo(state.data.fetchedAt) })}
            </p>
            <div className="flex items-center gap-1.5">
              {state.data.endpoints?.dashboard ? (
                <a
                  href={state.data.endpoints.dashboard}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2/60 px-2.5 py-1 text-[11px] font-medium text-muted transition-colors hover:border-primary/40 hover:text-primary"
                >
                  <ExternalLink className="h-3 w-3" />
                  {t("wallet.attestDashboard")}
                </a>
              ) : null}
              {appsUrl ? (
                <a
                  href={appsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2/60 px-2.5 py-1 text-[11px] font-medium text-muted transition-colors hover:border-primary/40 hover:text-primary"
                >
                  <ExternalLink className="h-3 w-3" />
                  {t("wallet.creditcoinApps")}
                </a>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {state.phase === "error" ? (
        <div className="space-y-3">
          {state.data ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <MiniStat
                  icon={Activity}
                  label={t("wallet.attestCc3Block")}
                  value={num(state.data.cc3Block)}
                  sublabel={t("wallet.attestLastKnown")}
                />
                <MiniStat
                  icon={Layers}
                  label={t("wallet.attestSupportedChains")}
                  value={String(state.data.chains.length)}
                  sublabel={state.data.chains.map((c) => c.name).join(" · ")}
                />
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {state.data.chains.map((chain) => (
                  <AttestationChainCard key={chain.chainKey} chain={chain} />
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-6 text-center">
              <AlertCircle className="mx-auto h-5 w-5 text-danger" />
              <p className="mt-2 text-xs text-danger">{t("wallet.attestUnavailable")}</p>
              <Button variant="secondary" size="sm" className="mt-3" onClick={refresh}>
                <RefreshCcw className="h-3.5 w-3.5" />
                {t("wallet.attestRetry")}
              </Button>
            </div>
          )}
          {state.data ? (
            <p className="flex items-center gap-1.5 text-[11px] text-warning">
              <AlertCircle className="h-3 w-3" />
              {t("wallet.attestStale")} · {t("wallet.attestRetryHint")}
            </p>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
