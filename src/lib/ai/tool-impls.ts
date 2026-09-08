import { getAttestcoinStatus } from "@/lib/attestcoin/status";

/**
 * Attestcoin status tool implementation (the agent server tool executor
 * shares this). The Phase-1 intent-card tools and the built-in provider tool
 * specs were removed with their dead call paths (C27 / dead /api/chat route).
 */

export interface AttestcoinStatusToolResult {
  ok: boolean;
  env?: string;
  cc3Block?: number;
  chains?: Array<{
    name: string;
    chainKey: number;
    attestedHeight: number | null;
    sourceHead: number | null;
    lag: number | null;
  }>;
  error?: string;
}

/** Live Attestcoin Protocol network status (read-only, cached upstream). */
export async function executeAttestcoinStatus(): Promise<AttestcoinStatusToolResult> {
  try {
    const status = await getAttestcoinStatus();
    return {
      ok: true,
      env: status.env,
      cc3Block: status.cc3Block ?? undefined,
      chains: status.chains.map((c) => ({
        name: c.name,
        chainKey: c.chainKey,
        attestedHeight: c.attestedHeight,
        sourceHead: c.sourceHead,
        lag: c.lag,
      })),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
