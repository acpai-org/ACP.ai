"use client";

import { memo } from "react";
import {
  Hexagon,
  Globe,
  Radar,
  KeyRound,
  Server,
  ExternalLink,
  CheckCircle2,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n";
import { useFormatters } from "@/lib/use-formatters";
import { useAttestcoinStatus } from "@/lib/use-attestcoin";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Attestcoin Protocol integration status card (settings page).
//
// One place to see the whole Phase-2 layer: which environment is selected
// (ATTESTCOIN_NETWORK), whether the server-side attestation watcher is alive,
// whether signed proof submission is enabled (CREDITCOIN_SIGNER_KEY), and the
// live endpoints the app talks to. Read-only — configuration stays in env
// vars (12-factor; no secrets in the browser).
// ─────────────────────────────────────────────────────────────────────────────

function InfoRow({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
          <Icon className="h-4 w-4" />
        </div>
        <p className="text-sm font-medium text-foreground">{label}</p>
      </div>
      <div className="min-w-0 text-right text-xs text-muted-2">{children}</div>
    </div>
  );
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span className="relative flex h-2 w-2 shrink-0">
      {ok ? (
        <>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success/60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
        </>
      ) : (
        <span className="relative inline-flex h-2 w-2 rounded-full bg-muted-2/60" />
      )}
    </span>
  );
}

export const AttestcoinSettingsCard = memo(function AttestcoinSettingsCard() {
  const { t } = useI18n();
  const { timeAgo } = useFormatters();
  const { state } = useAttestcoinStatus();

  const ready = state.phase === "ready" ? state.data : state.phase === "error" ? state.data : null;
  const poller = ready?.poller;
  const submission = ready?.submission;
  const endpoints = ready?.endpoints;

  return (
    <Card>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Hexagon className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">{t("settings.attestcoin")}</h2>
        </div>
        {ready ? (
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
              ready.healthy
                ? "border-success/30 bg-success/10 text-success"
                : "border-warning/30 bg-warning/10 text-warning",
            )}
          >
            <StatusDot ok={ready.healthy} />
            {ready.healthy ? t("wallet.attestLive") : t("wallet.attestStale")}
          </span>
        ) : (
          <span className="h-4 w-12 shrink-0 shimmer rounded-full" aria-hidden />
        )}
      </div>
      <p className="mb-2 text-xs leading-relaxed text-muted-2">{t("settings.attestcoinDesc")}</p>

      <div className="divide-y divide-border">
        <InfoRow icon={Globe} label={t("settings.attestEnv")}>
          <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-foreground">
            {ready ? (ready.env === "mainnet" ? t("settings.attestEnvMainnet") : t("settings.attestEnvTestnet")) : "…"}
          </span>
        </InfoRow>

        <InfoRow icon={Radar} label={t("settings.attestWatcher")}>
          {poller?.running ? (
            <span className="inline-flex items-center gap-1.5">
              <StatusDot ok />
              <span className="text-[11px] text-success">{t("settings.attestWatcherRunning")}</span>
              {poller.lastTickAt ? (
                <span className="text-[11px] text-muted-2">· {timeAgo(poller.lastTickAt)}</span>
              ) : null}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-2">
              <XCircle className="h-3.5 w-3.5" />
              {t("settings.attestWatcherStopped")}
            </span>
          )}
        </InfoRow>

        <InfoRow icon={KeyRound} label={t("settings.attestSubmit")}>
          {submission?.configured ? (
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-success" />
              <span className="font-mono text-[11px] text-success">{t("settings.attestSubmitOn")}</span>
            </span>
          ) : (
            <span className="text-[11px] text-muted-2">
              {t("settings.attestSubmitOff", { env: "CREDITCOIN_SIGNER_KEY" })}
            </span>
          )}
        </InfoRow>

        <InfoRow icon={Server} label={t("settings.attestEndpoints")}>
          <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
            {endpoints ? (
              <>
                <a
                  href={endpoints.dashboard}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-2/60 px-2 py-0.5 text-[11px] font-medium text-muted transition-colors hover:border-primary/40 hover:text-primary"
                >
                  {t("wallet.attestDashboard")}
                  <ExternalLink className="h-3 w-3" />
                </a>
                <a
                  href={endpoints.proofBuilder}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-2/60 px-2 py-0.5 text-[11px] font-medium text-muted transition-colors hover:border-primary/40 hover:text-primary"
                >
                  {t("settings.attestBuilder")}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </>
            ) : (
              <span>…</span>
            )}
          </div>
        </InfoRow>
      </div>
    </Card>
  );
});
