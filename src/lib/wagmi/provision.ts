"use client";

import { useEffect, useRef } from "react";
import { useAccount, useChainId } from "wagmi";
import { CHAIN_REGISTRY, getChainByChainId } from "@/lib/chains/registry";

// ─────────────────────────────────────────────────────────────────────────────
// Connect-time chain provisioning (brief §3).
//
// Goal: after connect, every supported chain exists in the user's wallet, and
// later switches never prompt (wherever the wallet supports that).
//
// Wallet behavior this is built on (researched + verified 2026-09-04):
//  - WalletConnect/Reown: ALL registry chains are already in the session's
//    eip155 namespace (WagmiAdapter `networks`) → one approval covers the set;
//    switching among session chains re-prompts nothing.
//  - MetaMask (chain-permission model, Nov 2024+): chains the wallet already
//    has enabled are auto-permitted per-dapp at connect → silent switches.
//    Custom chains cost exactly ONE wallet_addEthereumChain approval, which
//    also grants the permission; after that, switches are silent.
//  - Rabby auto-switches silently. Some wallets may still prompt per switch —
//    a wallet limitation we document, not an app defect.
//
// Strategy: after the first successful connect (per browser), pre-add ONLY the
// custom chains the wallet almost certainly lacks — the two Creditcoin chains.
// Major networks (Ethereum/Base/Arbitrum/OP/Polygon/BNB) ship wallet-default.
// wallet_switchEthereumChain later falls back to add-on-4902 automatically for
// anything still missing (wagmi handles that), so coverage is eventual anyway.
//
// N23 (popup spam): the record NEVER expires. A chain the wallet has stays
// had — re-calling wallet_addEthereumChain on a 12h-stale record is exactly
// the "Allow this site to add a network" prompt some wallets fire per add
// call. A REJECTED chain is equally final: re-prompting a user who said no
// (half a day later or on every remount) is spam; the honest path back is an
// EXPLICIT user action (switching to that chain via the chain switcher,
// where wagmi's 4902 fallback asks with user intent on the line).
// Clearing site data resets the record.
// ─────────────────────────────────────────────────────────────────────────────

const PROVISIONED_KEY = "acp-ai:chains-provisioned-v1";
/** In-flight guard: provisioning runs AT MOST once per browser session, even
 * across web3-frame remounts (lazy chunk reloads, route churn). */
const INFLIGHT_KEY = "acp-ai:chains-provisioning-inflight";

interface ProvisionRecord {
  at: number;
  added: number[];
  failed: number[];
}

function loadRecord(): ProvisionRecord | null {
  try {
    const raw = localStorage.getItem(PROVISIONED_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as ProvisionRecord;
    if (!Array.isArray(rec.added) || !Array.isArray(rec.failed)) return null;
    return rec;
  } catch {
    return null;
  }
}

function saveRecord(rec: ProvisionRecord) {
  try {
    localStorage.setItem(PROVISIONED_KEY, JSON.stringify(rec));
  } catch {
    /* storage unavailable — provisioning retried next connect; harmless */
  }
}

function claimInflight(): boolean {
  try {
    if (sessionStorage.getItem(INFLIGHT_KEY)) return false;
    sessionStorage.setItem(INFLIGHT_KEY, "1");
    return true;
  } catch {
    return true; // no session storage — the ref guard still applies
  }
}

function hexChainId(id: number): `0x${string}` {
  return `0x${id.toString(16)}`;
}

async function addEthereumChain(
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>,
  chainId: number,
): Promise<"added" | "known" | "rejected"> {
  const chain = getChainByChainId(chainId);
  if (!chain) return "known";
  try {
    await request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hexChainId(chainId),
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: chain.rpcUrls.slice(0, 2),
          blockExplorerUrls: chain.explorerUrl ? [chain.explorerUrl] : [],
        },
      ],
    });
    return "added";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // -32602: wallet already has this chain (MetaMask refuses re-adding) → treated as success.
    if (msg.includes("-32602") || /already|exists|default/i.test(msg)) return "known";
    return "rejected";
  }
}

/**
 * Mount once inside the client-only web3 frame. After a wallet connects, stages
 * wallet_addEthereumChain calls for the custom chains (Creditcoin TN + MN) the
 * wallet doesn't have yet — one at a time, so the user never faces a wall of
 * dialogs. The outcome (added OR rejected) is FINAL for the browser — see the
 * N23 note above.
 */
export function useChainProvisioning(): void {
  const { isConnected, connector } = useAccount();
  const activeChainId = useChainId();
  const attempted = useRef(false);

  useEffect(() => {
    if (!isConnected || !connector || attempted.current) return;
    attempted.current = true;

    const run = async () => {
      const rec = loadRecord();
      // N23: ANY completed record (added or rejected) means we never prompt
      // again automatically.
      if (rec) return;
      if (!claimInflight()) return;
      let request: ((args: { method: string; params?: unknown[] }) => Promise<unknown>) | null = null;
      try {
        const provider = (await connector.getProvider()) as {
          request?: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
        };
        request = provider?.request?.bind(provider) ?? null;
      } catch {
        request = null;
      }
      if (!request) return;

      const added: number[] = [];
      const failed: number[] = [];

      // Only CUSTOM chains (not in typical wallet defaults) get pre-added.
      const customChains = CHAIN_REGISTRY.filter((c) => c.key.startsWith("creditcoin"));
      for (const chain of customChains) {
        // Stagger so the user handles one dialog at a time (if any).
        const outcome = await addEthereumChain(request, chain.chainId);
        if (outcome === "rejected") {
          failed.push(chain.chainId);
        } else {
          added.push(chain.chainId);
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      saveRecord({ at: Date.now(), added, failed });
    };

    void run().catch((err) => {
      console.warn("[chain-provisioning] non-fatal:", err);
    });
  }, [isConnected, connector, activeChainId]);
}
