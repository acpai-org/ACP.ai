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
/** N11: bound each HTTP request — a hung /api/attestcoin/proof would park the
 * poller's in-flight check forever (the interval keeps firing but every check
 * early-returns nothing). */
const CHECK_TIMEOUT_MS = 12_000;

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
        { cache: "no-store", signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) },
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
        // N12: a transient failure (502/503 from a hiccuping builder) must not
        // flip the phase to "unavailable" mid-poll — the next interval tick
        // retries. Only a persistent failure (budget exhaustion, handled
        // above) ends the poll, and that stays "pending" honestly.
        setResult((prev) => (prev.phase === "attested" ? prev : prev.phase === "checking" ? { phase: "pending", checkedAt: Date.now() } : prev));
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
        // N12: keep the pending phase on an "error" state — the server-side
        // poller remains the long-running authority.
        setResult((prev) => (prev.phase === "attested" ? prev : { phase: "pending", dashboardUrl: data.dashboard, checkedAt: Date.now() }));
      }
    } catch {
      // N12: network throw — same treatment: stay pending, next tick retries.
      setResult((prev) => (prev.phase === "attested" ? prev : prev.phase === "checking" ? { phase: "pending", checkedAt: Date.now() } : prev));
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
        // N12 fix: budget exhausted ≠ attestation failed. The server-side
        // Attestcoin poller keeps watching for up to 14 DAYS and flips the
        // payment row + fires a notification when the proof lands. The old
        // code latched "unavailable", which the intent-card timeline rendered
        // as attestation SKIPPED — a real attestation minutes later looked
        // like the feature was broken. Keep the honest "pending" state (the
        // poll simply stops burning client requests).
        setResult((prev) =>
          prev.phase === "attested" ? prev : { phase: "pending", dashboardUrl: prev.dashboardUrl, checkedAt: prev.checkedAt },
        );
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
