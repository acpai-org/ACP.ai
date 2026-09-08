"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Client-side hook for the Attestcoin Protocol network status
// (GET /api/attestcoin/status). Server caches 30s; the hook re-polls on a
// longer interval and exposes manual refresh + last-known-state on error.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";

export interface AttestChainRow {
  chainKey: number;
  evmChainId: number;
  name: string;
  attestedHeight: number | null;
  attestedHash: string | null;
  sourceHead: number | null;
  lag: number | null;
  hasAttestations: boolean;
}

export interface PollerRow {
  running: boolean;
  startedAt: number | null;
  lastTickAt: number | null;
  lastTickChecked: number | null;
  lastFlipAt: number | null;
  flippedTotal: number;
  lastError: string | null;
  watching: number | null;
}

export interface SubmissionRow {
  configured: boolean;
  signerAddress?: string;
  requiredEnv?: string;
}

export interface AttestcoinStatusData {
  env: "testnet" | "mainnet";
  cc3Block: number | null;
  chains: AttestChainRow[];
  fetchedAt: number;
  healthy: boolean;
  endpoints?: { rpc: string; proofBuilder: string; dashboard: string };
  poller?: PollerRow;
  submission?: SubmissionRow;
}

export type AttestcoinLoadState =
  | { phase: "loading" }
  | { phase: "ready"; data: AttestcoinStatusData; refreshing: boolean }
  | { phase: "error"; data: AttestcoinStatusData | null; error: string };

const POLL_MS = 60_000;

export function useAttestcoinStatus() {
  const [state, setState] = useState<AttestcoinLoadState>({ phase: "loading" });
  const inFlight = useRef(false);

  const load = useCallback(async (force: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState((prev) =>
      prev.phase === "ready"
        ? { phase: "ready", data: prev.data, refreshing: true }
        : prev.phase === "error" && prev.data
          ? { phase: "error", data: prev.data, error: prev.error }
          : { phase: "loading" },
    );
    try {
      const res = await fetch(`/api/attestcoin/status${force ? "?force=1" : ""}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as AttestcoinStatusData;
      setState({ phase: "ready", data, refreshing: false });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      setState((prev) => ({
        phase: "error",
        data: prev.phase === "ready" ? prev.data : prev.phase === "error" ? prev.data : null,
        error,
      }));
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    // Defer the first fetch so no setState runs synchronously inside the effect.
    const kickoff = setTimeout(() => void load(false), 0);
    const timer = setInterval(() => void load(false), POLL_MS);
    return () => {
      clearTimeout(kickoff);
      clearInterval(timer);
    };
  }, [load]);

  const refresh = useCallback(() => void load(true), [load]);

  return { state, refresh };
}

/** Severity bucket for an attestation lag (in blocks). */
export function lagSeverity(lag: number | null): "fresh" | "delayed" | "stale" | "unknown" {
  if (lag === null) return "unknown";
  if (lag <= 200) return "fresh";
  if (lag <= 2_000) return "delayed";
  return "stale";
}
