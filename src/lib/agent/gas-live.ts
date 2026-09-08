import { createPublicClient, http, type PublicClient } from "viem";
import { getChainByChainId, VIEM_CHAINS } from "@/lib/chains/registry";

// ─────────────────────────────────────────────────────────────────────────────
// LIVE gas estimation (P5): eth_estimateGas against the target chain's real
// RPC for the exact transaction shape — the same estimation the wallet will
// refine at signing time. Server-side only (uses the registry's RPC set and
// the app's public-client cache).
//
// Contract: returns a REAL estimate or null. Null means "not estimable" —
// callers omit the fee row honestly; nobody invents a number (P5: the
// estimate shown is the estimate received, or an honest absence).
// ─────────────────────────────────────────────────────────────────────────────

const G = globalThis as unknown as { __acpPublicClients?: Map<number, PublicClient> };

function publicClient(chainId: number): PublicClient | null {
  const chain = getChainByChainId(chainId);
  if (!chain || !VIEM_CHAINS[chainId]) return null;
  if (!G.__acpPublicClients) G.__acpPublicClients = new Map();
  let client = G.__acpPublicClients.get(chainId);
  if (!client) {
    client = createPublicClient({
      chain: VIEM_CHAINS[chainId],
      transport: http(chain.rpcUrls[0], { timeout: 10_000, retryCount: 1 }),
    });
    G.__acpPublicClients.set(chainId, client);
  }
  return client;
}

export interface EstimateGasParams {
  /** Sender for the simulation (the connected wallet, when known). */
  account?: string | null;
  to?: string | null;
  value?: bigint;
  data?: `0x${string}`;
}

/**
 * Estimate the gas units for one exact transaction shape. Never throws:
 * any RPC/validation failure returns null (honest "unavailable").
 */
export async function estimateGasLive(chainId: number, params: EstimateGasParams): Promise<bigint | null> {
  const client = publicClient(chainId);
  if (!client) return null;
  try {
    const estimate = await client.estimateGas({
      ...(params.account ? { account: params.account as `0x${string}` } : {}),
      ...(params.to ? { to: params.to as `0x${string}` } : {}),
      ...(params.value ? { value: params.value } : {}),
      ...(params.data ? { data: params.data } : {}),
    });
    if (typeof estimate !== "bigint" || estimate <= 0n) return null;
    return estimate;
  } catch {
    return null;
  }
}
