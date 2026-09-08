"use client";

import { useEffect, useMemo, useState } from "react";
import {
  useAccount,
  useBlockNumber,
  useTransactionReceipt,
  type UseTransactionReceiptParameters,
} from "wagmi";

const FINALIZED_CONFIRMATIONS = 12;
const STUCK_AFTER_MS = 60_000;
const STUCK_TICK_MS = 5000;
const STUCK_TICK_THRESHOLD = Math.ceil(STUCK_AFTER_MS / STUCK_TICK_MS);

export type OnChainState = "unknown" | "pending" | "confirmed" | "reverted";

export interface TxReceiptState {
  state: OnChainState;
  blockNumber: bigint | null;
  confirmations: number;
  finalized: boolean;
  stuck: boolean;
  revertReason: string | null;
}

export function useTxReceipt(
  txHash?: string,
  chainId?: number,
): TxReceiptState {
  const { chain } = useAccount();
  const effectiveChainId = chainId ?? chain?.id;

  const enabled = Boolean(txHash) && Boolean(effectiveChainId);

  const receiptParams = useMemo(
    () =>
      ({
        hash: (txHash ?? "0x0") as `0x${string}`,
        chainId: effectiveChainId,
        query: {
          enabled,
          retry: false,
          refetchInterval: enabled ? 3000 : false,
          staleTime: 1_000,
        },
      }) satisfies UseTransactionReceiptParameters,
    [txHash, effectiveChainId, enabled],
  );

  const receipt = useTransactionReceipt(
    enabled
      ? receiptParams
      : ({ hash: "0x0" as `0x${string}`, query: { enabled: false } } as UseTransactionReceiptParameters),
  );

  const isConfirmed = receipt.status === "success" && Boolean(receipt.data);
  const txBlock = receipt.data?.blockNumber ?? null;

  const head = useBlockNumber({
    chainId: effectiveChainId,
    query: {
      enabled: Boolean(enabled && isConfirmed && txBlock !== null),
      refetchInterval: 4000,
      staleTime: 3_000,
    },
  });

  const isWaiting = enabled && (receipt.status === "pending" || receipt.isLoading);

  const [ticks, setTicks] = useState(0);
  const [prevWaiting, setPrevWaiting] = useState(isWaiting);
  if (prevWaiting !== isWaiting) {
    setPrevWaiting(isWaiting);
    setTicks(0);
  }

  useEffect(() => {
    if (!isWaiting) return;
    const id = setInterval(() => setTicks((t) => t + 1), STUCK_TICK_MS);
    return () => clearInterval(id);
  }, [isWaiting]);

  const stuck = isWaiting && ticks >= STUCK_TICK_THRESHOLD;

  if (!enabled || !txHash) {
    return { state: "unknown", blockNumber: null, confirmations: 0, finalized: false, stuck: false, revertReason: null };
  }

  if (receipt.status === "pending" || receipt.isLoading) {
    return { state: "pending", blockNumber: null, confirmations: 0, finalized: false, stuck, revertReason: null };
  }

  if (receipt.status === "error" || receipt.isError) {
    return {
      state: "pending",
      blockNumber: null,
      confirmations: 0,
      finalized: false,
      stuck: false,
      revertReason: receipt.error instanceof Error ? receipt.error.message : null,
    };
  }

  const r = receipt.data;
  if (!r) {
    return { state: "pending", blockNumber: null, confirmations: 0, finalized: false, stuck, revertReason: null };
  }

  if (r.status === "success") {
    const hb = head.data ?? txBlock;
    let raw = 0n;
    if (hb && txBlock) {
      raw = hb - txBlock;
      if (raw < 0n) raw = 0n;
    }
    return {
      state: "confirmed",
      blockNumber: txBlock,
      confirmations: Number(raw) + 1,
      finalized: raw >= BigInt(FINALIZED_CONFIRMATIONS),
      stuck: false,
      revertReason: null,
    };
  }

  return {
    state: "reverted",
    blockNumber: txBlock,
    confirmations: 0,
    finalized: false,
    stuck: false,
    revertReason: decodeRevertReason(r),
  };
}

function decodeRevertReason(r: {
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  status?: string;
}): string | null {
  if (r.status !== "reverted") return null;
  const gas = r.gasUsed ?? 0n;
  if (gas === 0n) return "transaction reverted during execution (out of gas or require failed)";
  return "transaction reverted on-chain — the transfer was rejected by the token contract (e.g. insufficient balance, allowance, or blocklist)";
}
