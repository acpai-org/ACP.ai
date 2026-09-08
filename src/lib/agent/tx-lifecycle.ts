"use client";

import { create } from "zustand";

// ─────────────────────────────────────────────────────────────────────────────
// Transaction lifecycle state machine (Phase 3 §4.6 / C3).
//
// States (brief §4.6):
//   requested  → sent to the wallet (signature prompt up)
//   signed     → user approved; tx hash known
//   broadcast  → hash submitted to the chain
//   confirmed  → receipt; success or revert
//   rejected   → user declined in the wallet (first-class outcome)
//   failed     → broadcast/receipt error
//   timeout    → wallet never responded within a sane window
//   unknown    → broadcast but no receipt within the wait window. NEVER
//                auto-resend (double-spend risk — hard boundary 7); the only
//                honest state is "unknown" until the user checks.
//
// Every transition updates EVERY surface immediately: the chat trace (via the
// executor progress callback), the Actions/Wallet surfaces (this store), and
// the persistent action log (POSTed to /api/agent/respond as tool_status so
// the server can patch the DB row while the tool call is still parked).
// ─────────────────────────────────────────────────────────────────────────────

export type TxLifecycleStatus =
  | "requested"
  | "signed"
  | "broadcast"
  | "confirmed"
  | "rejected"
  | "failed"
  | "timeout"
  | "unknown";

export interface TxLifecycleEntry {
  callId: string;
  status: TxLifecycleStatus;
  txHash?: string;
  chainId?: number;
  blockNumber?: number;
  error?: string;
  updatedAt: number;
}

interface TxLifecycleStore {
  entries: Record<string, TxLifecycleEntry>;
  record: (callId: string, patch: Partial<Omit<TxLifecycleEntry, "callId" | "updatedAt">>) => void;
  clear: () => void;
}

export const useTxLifecycle = create<TxLifecycleStore>((set) => ({
  entries: {},
  record: (callId, patch) =>
    set((state) => ({
      entries: {
        ...state.entries,
        [callId]: {
          ...state.entries[callId],
          callId,
          ...patch,
          updatedAt: Date.now(),
        },
      },
    })),
  clear: () => set({ entries: {} }),
}));

/** Record a lifecycle transition locally (all surfaces re-render) AND
 * best-effort report it to the server so the persistent action log row
 * reflects the live state while the tool call is parked. */
export function recordTxEvent(
  callId: string,
  sessionId: string,
  patch: Partial<Omit<TxLifecycleEntry, "callId" | "updatedAt">>,
): void {
  useTxLifecycle.getState().record(callId, patch);
  const { status, txHash, chainId, blockNumber, error } = patch;
  void fetch("/api/agent/respond", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, callId, kind: "tool_status", status, txHash, chainId, blockNumber, error }),
  }).catch(() => {
    /* best-effort: the final tool_result carries the authoritative outcome */
  });
}

/** Map a lifecycle status to the action-log row status vocabulary. */
export function lifecycleToActionStatus(status: TxLifecycleStatus): string {
  switch (status) {
    case "requested":
      return "awaiting_signature";
    case "signed":
    case "broadcast":
      return "broadcast";
    case "confirmed":
      return "succeeded";
    case "rejected":
      return "declined";
    case "failed":
      return "failed";
    case "timeout":
      return "failed";
    case "unknown":
      return "unknown";
  }
}
