"use client";


import NetworkEthereum from "@web3icons/react/icons/networks/NetworkEthereum";
import NetworkSepolia from "@web3icons/react/icons/networks/NetworkSepolia";
import NetworkBase from "@web3icons/react/icons/networks/NetworkBase";
import NetworkArbitrumOne from "@web3icons/react/icons/networks/NetworkArbitrumOne";
import NetworkOptimism from "@web3icons/react/icons/networks/NetworkOptimism";
import NetworkPolygon from "@web3icons/react/icons/networks/NetworkPolygon";
import NetworkBinanceSmartChain from "@web3icons/react/icons/networks/NetworkBinanceSmartChain";
import TokenCTC from "@web3icons/react/icons/tokens/TokenCTC";
import { getChainByChainId } from "@/lib/chains/registry";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// ChainIcon (N14) — the ONE app-wide chain-icon component.
//
//  • Chain icons come from @web3icons/react (verified export surface; static
//    deep imports — tree-shaken, NOT the /dynamic registry which compiles
//    500+ icon chunks and OOM-killed the dev server).
//  • CTC's network is NOT in the pack (owner's note) — the CTC chain icon is
//    the CTC token's logo (TokenCTC), on a dark chip so the white symbol
//    reads on BOTH themes.
//  • Letter tile is the FALLBACK only (N15): a chain missing from the map
//    degrades to its registry letter tile. Never the primary.
//  • CHAIN icons only. Token logos come from the fetch pipeline (N15) —
//    never import token icons here for token lists.
// ─────────────────────────────────────────────────────────────────────────────

interface IconLike {
  (props: { size?: number | string; variant?: string; className?: string }): React.ReactElement;
}

const NETWORK_ICONS: Record<number, IconLike> = {
  1: NetworkEthereum as unknown as IconLike,
  11155111: NetworkSepolia as unknown as IconLike,
  8453: NetworkBase as unknown as IconLike,
  42161: NetworkArbitrumOne as unknown as IconLike,
  10: NetworkOptimism as unknown as IconLike,
  137: NetworkPolygon as unknown as IconLike,
  56: NetworkBinanceSmartChain as unknown as IconLike,
};

const CTC_CHAIN_IDS = new Set([102031, 102030]);

export function ChainIcon({ chainId, size = 18, className }: { chainId: number; size?: number; className?: string }) {
  if (CTC_CHAIN_IDS.has(chainId)) {
    return (
      <span
        aria-hidden
        className={cn("flex shrink-0 items-center justify-center rounded-[4px] bg-[#17181a]", className)}
        style={{ width: size, height: size }}
      >
        <TokenCTC size={Math.round(size * 0.82)} variant="branded" />
      </span>
    );
  }

  const Icon = NETWORK_ICONS[chainId];
  if (Icon) {
    return (
      <span className={cn("inline-flex shrink-0 items-center justify-center", className)} style={{ width: size, height: size }}>
        <Icon size={size} variant="branded" />
      </span>
    );
  }

  // Fallback only (N15) — registry letter tile.
  const chain = getChainByChainId(chainId);
  if (!chain) return null;
  return (
    <span
      aria-hidden
      className={cn("flex items-center justify-center rounded-[4px] font-bold text-white/95", className)}
      style={{ width: size, height: size, background: chain.tileColor, fontSize: size * 0.55 }}
    >
      {chain.tileLetter}
    </span>
  );
}
