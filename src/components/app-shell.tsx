"use client";

import { type ReactNode, useEffect } from "react";
import dynamic from "next/dynamic";
import { LoadingOverlay } from "@/components/ui/loading-overlay";
import { useI18n } from "@/lib/i18n";

// The whole web3 frame (provider + navbar + main) is client-only ON PURPOSE:
// the provider's module graph (wagmi + Reown AppKit + cdp-sdk via
// @wagmi/connectors) costs ~2GB of dev memory when evaluated inside the SSR
// worker — it was the reason the dev server kept getting OOM-killed while
// routes were being previewed. The server still paints the branded boot
// overlay below instantly; the frame + page content mount on the client
// (chunks are cached after the first visit). Wallet state is browser-only
// anyway. See web3-frame.tsx for why the provider must wrap the navbar.
const Web3Frame = dynamic(
  () => import("@/components/web3-frame").then((m) => m.Web3Frame),
  {
    ssr: false,
    loading: () => <FrameSkeleton />,
  },
);

/** Navbar-shaped placeholder so the frame mount never flashes empty. */
function FrameSkeleton() {
  return (
    <div className="flex h-dvh flex-col overflow-hidden" aria-busy="true">
      {/* navbar bar placeholder — mirrors the real bar's shape/positioning */}
      <div className="flex justify-center px-4 pt-3 sm:px-6 sm:pt-4">
        <div className="flex w-full max-w-5xl items-center justify-between neumorphic px-6 py-3">
          <div className="shimmer h-7 w-24 rounded-lg" />
          <div className="hidden items-center gap-1 sm:flex">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="shimmer h-6 w-16 rounded-2xl" />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <div className="shimmer h-7 w-7 rounded-xl" />
            <div className="shimmer h-8 w-28 rounded-full" />
          </div>
        </div>
      </div>
      {/* main content placeholder — pb mirrors web3-frame's mobile tab-bar
          inset so the skeleton→frame handoff doesn't jump on phones */}
      <div className="mx-auto mt-8 w-full max-w-4xl flex-1 overflow-y-auto px-4 pb-[calc(5.25rem+env(safe-area-inset-bottom))] sm:px-6 sm:pb-0">
        <div className="mb-6 flex items-start gap-3">
          <div className="shimmer h-10 w-10 shrink-0 rounded-xl" />
          <div className="space-y-2 pt-0.5">
            <div className="shimmer h-6 w-44 rounded-lg" />
            <div className="shimmer h-3.5 w-64 rounded-md" />
          </div>
        </div>
        <div className="glass-panel space-y-3 p-5">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex items-center gap-3 rounded-xl border border-border bg-surface-2/40 px-4 py-3.5"
            >
              <div className="shimmer h-9 w-9 shrink-0 rounded-full" />
              <div className="flex-1 space-y-2">
                <div className="shimmer h-3.5 w-1/3 rounded-md" />
                <div className="shimmer h-3 w-1/2 rounded-md" />
              </div>
            </div>
          ))}
        </div>
      </div>
      {/* mobile tab-bar placeholder — mirrors the real pill's footprint */}
      <div className="flex justify-center px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:hidden">
        <div className="shimmer h-14 w-full max-w-md" style={{ borderRadius: 32 }} />
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const hydrate = useI18n((s) => s.hydrate);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  return (
    <>
      <LoadingOverlay />
      <Web3Frame>{children}</Web3Frame>
    </>
  );
}
