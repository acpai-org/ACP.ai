"use client";

import dynamic from "next/dynamic";
import { RouteSkeleton } from "@/components/ui/route-skeleton";

// WalletPanel is client-only: Reown AppKit + wagmi read/write hooks only
// work in the browser, and keeping the import dynamic keeps wagmi out of
// the server bundle (see app-shell.tsx for the memory rationale).
const WalletPanel = dynamic(
  () => import("@/app/wallet/wallet-panel").then((m) => m.WalletPanel),
  { ssr: false, loading: () => <RouteSkeleton /> },
);

export function WalletPanelLazy() {
  return <WalletPanel />;
}
