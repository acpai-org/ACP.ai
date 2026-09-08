import { WalletPanelLazy } from "@/components/lazy/wallet-panel-lazy";

// Wallet state is fully client-side and the app frame is client-rendered
// (see app-shell.tsx) — no route caching.

export default function WalletPage() {
  return <WalletPanelLazy />;
}
