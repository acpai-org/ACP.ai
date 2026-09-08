"use client";

import { useChainId } from "wagmi";
import { networkName } from "@/lib/wagmi/chains";
import { useI18n } from "@/lib/i18n";

/**
 * Client-only description line for the settings "Active network" row.
 * Extracted from the settings page so the wagmi import stays out of the
 * server bundle (see app-shell.tsx for the memory rationale) — the rest
 * of the settings page renders server-side immediately.
 */
export function ActiveNetworkDesc() {
  const { t } = useI18n();
  const chainId = useChainId();
  return (
    <>{t("settings.activeNetworkDesc", { network: networkName(chainId), chainId })}</>
  );
}
