"use client";

import { useCallback, useState } from "react";
import { useAccount } from "wagmi";
import { type Address, type Hash, encodePacked, getAddress, keccak256 } from "viem";
import { useCreateRecurring, useUpdateRecurring } from "@/lib/api";
import type { CreateRecurringPayload } from "@/lib/api";
import {
  CADENCE_PRESETS,
  cadenceIntervalMs,
  cadenceStorage,
  clampCustom,
  type CadencePreset,
  type CadenceSpec,
  type CadenceUnit,
} from "@/lib/recurring/cadence";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 recurring schedules are recorded in the local database only.
// TODO(phase-2): wire registration/cancellation to the Attestcoin Protocol —
// the previous implementation registered schedules on a chain-specific
// on-chain anchor contract (mainnet). Phase 2 replaces that with
// Attestcoin-backed schedule attestations; the register/cancel result shapes
// below are intentionally kept stable so the UI does not need restructuring
// when the on-chain step is reintroduced.
// ─────────────────────────────────────────────────────────────────────────────

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export type RegisterResult =
  | { status: "registered"; txHash: string | null; alreadyExisted?: boolean }
  | { status: "failed"; error: string }
  | { status: "declined"; reason: string };

export type CancelResult =
  | { status: "cancelled"; txHash?: string }
  | { status: "failed"; error: string }
  | { status: "declined"; reason: string };

export interface RegisterScheduleInput {
  recipientAddress: string;
  tokenAddress: string;
  amountBaseUnits: string;
  amountHuman: string;
  /** C37: preset name or a full custom spec — stored via cadenceStorage(). */
  cadence: CadencePreset | { unit: CadenceUnit; n: number };
  firstFireAt: number;
  maxExecutions: number;
  recipientLabel?: string | null;
  token?: string;
  /** Target chain for the Phase-2 executor (poller dispatches on this chain). */
  chainId?: number | null;
}

export type { CadencePreset, CadenceSpec, CadenceUnit };

// The preset order the form offers (shortest → longest).
export const RECURRING_PRESET_LIST: CadencePreset[] = CADENCE_PRESETS.map((p) => p.preset);

/**
 * Deterministic schedule identity (C37: cadence slot widened from uint8 to
 * uint32 interval-SECONDS — custom intervals up to 365d = 31,536,000s fit;
 * the legacy uint8 encoding overflowed for any cadence > 255 units). Purely
 * local uniqueness (Phase 3 records schedules in the local DB only).
 */
function deriveScheduleId(
  author: Address,
  recipient: Address,
  token: Address,
  amount: bigint,
  cadence: CadencePreset | { unit: CadenceUnit; n: number },
  firstFireAt: number,
): Hash {
  const intervalMs = typeof cadence === "string" ? cadenceIntervalMs(cadence) : clampCustom(cadence.unit, cadence.n).intervalMs;
  const intervalSec = Math.floor(intervalMs / 1000);
  return keccak256(
    encodePacked(
      ["address", "address", "address", "uint128", "uint32", "uint64"],
      [author, recipient, token, amount, intervalSec, BigInt(firstFireAt)] as const,
    ),
  );
}

export function useRecurringSchedule() {
  const { address, isConnected } = useAccount();
  const createRecurring = useCreateRecurring();
  const updateRecurring = useUpdateRecurring();
  const [isRegistering, setIsRegistering] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  const register = useCallback(
    async (input: RegisterScheduleInput): Promise<RegisterResult> => {
      if (!isConnected || !address) {
        return { status: "declined", reason: "no-wallet" };
      }

      let amount: bigint;
      try {
        amount = BigInt(input.amountBaseUnits);
      } catch {
        return { status: "failed", error: "Invalid amount." };
      }

      const recipient = getAddress(input.recipientAddress);
      const token = input.tokenAddress && /^0x[a-fA-F0-9]{40}$/.test(input.tokenAddress)
        ? getAddress(input.tokenAddress)
        : ZERO_ADDRESS;
      const scheduleId = deriveScheduleId(getAddress(address), recipient, token, amount, input.cadence, input.firstFireAt);

      setIsRegistering(true);
      try {
        // C37: the stored cadence is the canonical spec string ("weekly",
        // "every-10d", "every-6h"…) — legacy numeric dialects are no
        // longer written.
        const storedCadence =
          typeof input.cadence === "string"
            ? input.cadence
            : cadenceStorage({ kind: "custom", unit: input.cadence.unit, n: input.cadence.n, intervalMs: 0 });
        const dbPayload: CreateRecurringPayload = {
          id: crypto.randomUUID(),
          recipientLabel: input.recipientLabel ?? null,
          recipientAddress: recipient,
          token: input.token ?? "USDC",
          tokenAddress: input.tokenAddress || null,
          amountHuman: input.amountHuman,
          amountBaseUnits: input.amountBaseUnits,
          cadence: storedCadence,
          chainId: input.chainId ?? null,
          nextFireAt: input.firstFireAt,
          maxExecutions: input.maxExecutions,
          scheduleIdHash: scheduleId,
          senderAddress: address,
        };

        await createRecurring.mutateAsync(dbPayload);

        // TODO(phase-2): additionally register the schedule on-chain via the
        // Attestcoin Protocol and store the attestation reference here.
        return { status: "registered", txHash: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Registration failed.";
        return { status: "failed", error: message };
      } finally {
        setIsRegistering(false);
      }
    },
    [address, isConnected, createRecurring],
  );

  const cancel = useCallback(
    async (scheduleIdHash: string, dbId: string): Promise<CancelResult> => {
      // Cancel is a pure local-ledger write — no funds move, no signature:
      // a wallet connection is NOT required (the C37 pause/resume pair must
      // work on any device state).
      void scheduleIdHash;
      setIsCancelling(true);
      try {
        // TODO(phase-2): also cancel the on-chain schedule via the Attestcoin
        // Protocol once schedules are attested on-chain.
        await updateRecurring.mutateAsync({ id: dbId, active: false, lastStatus: "paused" });
        return { status: "cancelled" };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Cancel failed.";
        return { status: "failed", error: message };
      } finally {
        setIsCancelling(false);
      }
    },
    [updateRecurring],
  );

  return {
    register,
    cancel,
    isRegistering,
    isCancelling,
    canRegister: true,
  };
}
