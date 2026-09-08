"use client";

import { type ReactNode } from "react";
import { Web3Provider } from "@/components/providers/web3-provider";
import { Navbar } from "@/components/navbar";
import { MobileTabbar } from "@/components/mobile-tabbar";
import { AutomationPoller } from "@/components/automation-poller";
import { RecurringPoller } from "@/components/recurring-poller";
import { NotificationsBadgePoller } from "@/components/notifications-badge-poller";
import { CommandPalette } from "@/components/command-palette";
import { ShortcutsHelp } from "@/components/shortcuts-help";
import { InstallBanner } from "@/components/install-banner";
import { useChainProvisioning } from "@/lib/wagmi/provision";
import { useInstallBanner } from "@/lib/install-banner-store";

/**
 * The app frame that owns the Web3Provider context.
 *
 * Loaded client-only via next/dynamic from app-shell (see the memory
 * rationale there): Web3Provider's module graph — wagmi + Reown AppKit +
 * cdp-sdk — is ~2GB of dev RSS when evaluated in the SSR worker, and every
 * wagmi-hook consumer (Navbar's WalletButton, the chat/wallet/recurring
 * views) needs this context at mount time, so the provider must sit ABOVE
 * the navbar, not just around the page content.
 *
 * Phase 2: also owns connect-time chain provisioning (custom chains get
 * wallet_addEthereumChain'd once per browser — see lib/wagmi/provision.ts)
 * and the app-open engines for automation rules + recurring payments, plus
 * the mobile bottom tab bar (main gets matching bottom padding so the
 * fixed bar never covers content — see mobile-tabbar.tsx) and the PWA
 * install banner (deferred browser prompt / iOS hint — install-banner.tsx).
 */
function ChainProvisioner() {
  useChainProvisioning();
  return null;
}

export function Web3Frame({ children }: { children: ReactNode }) {
  // D7/N6: while the mobile install banner is up it floats exactly over the
  // composer band — the main column takes clearance padding so nothing
  // underneath (⌘K chip, send button, message rows) is covered.
  const bannerVisible = useInstallBanner((s) => s.visible);

  return (
    <Web3Provider>
      <ChainProvisioner />
      <AutomationPoller />
      <RecurringPoller />
      <NotificationsBadgePoller />
      <CommandPalette />
      <ShortcutsHelp />
      <div className="flex h-dvh flex-col overflow-hidden">
        <Navbar />
        {/* pb = tabbar pill height (~64) + float (12) + safe area — mobile only.
            With the banner up: + its own band (banner height ~72 + gap). */}
        <main
          className={
            bannerVisible
              ? "flex-1 overflow-hidden pb-[calc(10.6rem+env(safe-area-inset-bottom))] sm:pb-0"
              : "flex-1 overflow-hidden pb-[calc(5.25rem+env(safe-area-inset-bottom))] sm:pb-0"
          }
        >
          {children}
        </main>
        <MobileTabbar />
        <InstallBanner />
      </div>
    </Web3Provider>
  );
}
