"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Polls the Attestcoin proof endpoint for a (txHash, evmChainId) pair while a
// payment card is in a state worth checking (settled + tx known). Stops as
// soon as a proof is available. Errors degrade to "unavailable" without
// throwing — the timeline step just skips.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";

export type AttestationPhase =
  | "disabled" // not checking (no tx / not settled)
  | "checking" // first request in flight
  | "attested" // Merkle + continuity proof available
  | "pending" // tx known but block not attested yet (keep polling)
  | "unavailable" // network/upstream failure / poll budget spent — stop
  | "unsupported"; // chain not tracked by the integration

export interface TxAttestation {
  phase: AttestationPhase;
  merkleRoot?: string;
  headerNumber?: number;
  continuityRoots?: number;
  /** ASC dashboard URL for the active Attestcoin environment (from the proof API). */
  dashboardUrl?: string;
  checkedAt?: number;
}

const POLL_MS = 20_000;
/** Give up polling after this long without a proof (the card keeps the last state). */
const MAX_POLL_MS = 15 * 60_000;

export function useAttestationForTx(
  txHash?: string,
  evmChainId?: number,
  enabled?: boolean,
): TxAttestation {
  const [result, setResult] = useState<TxAttestation>({ phase: "disabled" });
  /** Terminal latch — once true the poller stops for this (tx, chain) pair. */
  const doneRef = useRef(false);
  const startedAtRef = useRef(0);

  const active = Boolean(txHash && evmChainId && enabled);

  const check = useCallback(async (hash: string, chain: number) => {
    try {
      const res = await fetch(
        `/api/attestcoin/proof?evmChainId=${chain}&txHash=${hash}`,
        { cache: "no-store" },
      );
      if (res.status === 404) {
        const body = (await res.json().catch(() => ({}))) as { state?: string };
        if (body.state === "unsupported") {
          doneRef.current = true;
          setResult({ phase: "unsupported" });
          return;
        }
      }
      if (!res.ok) {
        setResult((prev) => (prev.phase === "attested" ? prev : { phase: "unavailable", checkedAt: Date.now() }));
        return;
      }
      const data = (await res.json()) as {
        state: "proof" | "pending" | "unknown_tx" | "error";
        proof?: { merkleRoot: string; headerNumber: number; continuityRoots: number };
        dashboard?: string;
      };
      if (data.state === "proof" && data.proof) {
        doneRef.current = true;
        setResult({
          phase: "attested",
          merkleRoot: data.proof.merkleRoot,
          headerNumber: data.proof.headerNumber,
          continuityRoots: data.proof.continuityRoots,
          dashboardUrl: data.dashboard,
          checkedAt: Date.now(),
        });
      } else if (data.state === "pending" || data.state === "unknown_tx") {
        setResult({ phase: "pending", dashboardUrl: data.dashboard, checkedAt: Date.now() });
      } else {
        setResult((prev) => (prev.phase === "attested" ? prev : { phase: "unavailable", checkedAt: Date.now() }));
      }
    } catch {
      setResult((prev) => (prev.phase === "attested" ? prev : { phase: "unavailable", checkedAt: Date.now() }));
    }
  }, []);

  useEffect(() => {
    if (!active || !txHash || !evmChainId) return;
    doneRef.current = false;
    startedAtRef.current = Date.now();

    // Defer ALL state transitions out of the effect body (lint: setState
    // synchronously within an effect triggers cascading renders).
    const kickoff = setTimeout(() => {
      setResult({ phase: "checking" });
      void check(txHash, evmChainId);
    }, 0);
    const timer = setInterval(() => {
      if (doneRef.current) {
        clearInterval(timer);
        return;
      }
      if (Date.now() - startedAtRef.current > MAX_POLL_MS) {
        clearInterval(timer);
        doneRef.current = true;
        setResult((prev) => (prev.phase === "attested" ? prev : { phase: "unavailable", checkedAt: prev.checkedAt }));
        return;
      }
      void check(txHash, evmChainId);
    }, POLL_MS);

    return () => {
      clearTimeout(kickoff);
      clearInterval(timer);
    };
  }, [active, txHash, evmChainId, check]);

  if (!active) {
    return { phase: "disabled" };
  }
  return result;
}
