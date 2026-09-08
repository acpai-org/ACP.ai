"use client";

import { useEffect, useRef } from "react";
import { useAccount, useBalance, useChainId } from "wagmi";
import { useAgentRun } from "@/lib/agent/use-agent-run";
import { useAiProvider } from "@/lib/ai/provider-store";
import { useTokenBalances } from "@/lib/use-token-balances";
import {
  dispatchAgentUserMessage,
  activeSessionBusy,
  chainDisplayName,
} from "@/lib/agent/agent-dispatch";
import type { RecurringSchedule } from "@/lib/api";

// ─────────────────────────────────────────────────────────────────────────────
// RecurringPoller (brief §5) — the app-open engine for recurring payments.
// Mounted inside Web3Frame (needs wagmi context), beside AutomationPoller.
// Every 20s while the tab is VISIBLE:
//
//   1. loads active schedules (GET /api/recurring?active=true),
//   2. finds DUE ones (nextFireAt ≤ now, executions < maxExecutions),
//   3. requires an open wallet + a usable AI provider + an idle chat (else
//      the schedule stays eligible — nothing fires hidden or headless),
//   4. fires: POST /api/recurring/[id]/fire (atomic latch + catch-up
//      advance + action-log row), then routes the transfer through the
//      AGENT LOOP — same seam as chat sends and automation rules — so the
//      wallet signature gate applies to every scheduled spend.
//      A synthetic user message lands in the ACTIVE chat session.
//   5. a busy-run race requeues the pre-fire state (PATCH requeue) and the
//      next tick retries.
//
// Missed-while-away semantics: the fire route burns exactly ONE execution
// for however many slots were missed and advances nextFireAt to the next
// future slot — queue-and-run without double-charging.
// ─────────────────────────────────────────────────────────────────────────────

const TICK_MS = 20_000;

interface FireResponse {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  schedule?: RecurringSchedule;
  previous?: { executions: number; nextFireAt: number; active: boolean };
}

export function RecurringPoller() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const agentRun = useAgentRun();
  const { config, configured } = useAiProvider();
  const { data: nativeBalance } = useBalance({ address });
  const tokenBalances = useTokenBalances();

  /** True while a recurring agent run is starting/streaming (own dispatch). */
  const dispatchingRef = useRef(false);
  /** In-flight tick guard (StrictMode double-mount, visibility + interval overlap). */
  const tickingRef = useRef(false);

  const latestRef = useRef({
    address,
    isConnected,
    chainId,
    config,
    configured,
    nativeBalance,
    tokenBalancesData: tokenBalances.data,
    run: agentRun.run,
  });
  useEffect(() => {
    latestRef.current = {
      address,
      isConnected,
      chainId,
      config,
      configured,
      nativeBalance,
      tokenBalancesData: tokenBalances.data,
      run: agentRun.run,
    };
  }, [
    address,
    isConnected,
    chainId,
    config,
    configured,
    nativeBalance,
    tokenBalances.data,
    agentRun.run,
  ]);

  useEffect(() => {
    const reportStatus = async (id: string, status: string): Promise<void> => {
      try {
        await fetch(`/api/recurring/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ lastStatus: status }),
        });
      } catch {
        /* best-effort — next tick's GET re-syncs state */
      }
    };

    const fireSchedule = async (schedule: RecurringSchedule): Promise<void> => {
      const L = latestRef.current;
      let fired: FireResponse | null = null;
      try {
        const res = await fetch(`/api/recurring/${schedule.id}/fire`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "dispatched" }),
        });
        if (!res.ok) return;
        fired = (await res.json()) as FireResponse;
      } catch {
        return; // latch failed — schedule stays due, retry next tick
      }
      if (!fired || fired.skipped || !fired.schedule || !fired.previous) return; // dedup / inactive / complete

      // The transfer → the AGENT LOOP (wallet signature + action log for free).
      const chainName = chainDisplayName(schedule.chainId);
      const label = schedule.recipientLabel ? ` "${schedule.recipientLabel}"` : "";
      const userText = `Recurring payment${label} due: transfer ${schedule.amountHuman} ${schedule.token} to ${schedule.recipientAddress} on ${chainName}.`;

      const result = await dispatchAgentUserMessage({
        run: L.run,
        providerConfig: L.config,
        wallet: L.isConnected
          ? {
              address: L.address ?? null,
              chainId: L.chainId ?? null,
              holdings: (() => {
                const h: Record<string, { address: string | null; balance: string }> = {};
                if (L.nativeBalance?.value) {
                  const nativeSym = L.nativeBalance.symbol ?? "ETH";
                  h[nativeSym] = { address: null, balance: L.nativeBalance.value.toString() };
                }
                if (L.tokenBalancesData) {
                  for (const tk of L.tokenBalancesData) {
                    h[tk.symbol] = { address: tk.address, balance: tk.balance };
                  }
                }
                return Object.keys(h).length > 0 ? h : null;
              })(),
            }
          : null,
        userText,
      });

      if (result.errorCode === "busy") {
        // Lost a race with an active run — restore pre-fire state; the next
        // tick (or the run finishing) retries the execution.
        try {
          await fetch(`/api/recurring/${schedule.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ requeue: true, ...fired.previous }),
          });
        } catch {
          /* best-effort */
        }
      } else if (result.error) {
        await reportStatus(schedule.id, "failed");
      } else {
        await reportStatus(schedule.id, "dispatched");
      }
    };

    const tickInner = async () => {
      const L = latestRef.current;
      // Pre-fire guards: nothing fires headless (no wallet / no provider /
      // busy chat) — schedules stay eligible and retry on the next tick.
      if (dispatchingRef.current || activeSessionBusy() || !L.configured || !L.isConnected) return;

      let schedules: RecurringSchedule[] = [];
      try {
        const res = await fetch("/api/recurring?active=true", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { schedules?: RecurringSchedule[] };
        schedules = json.schedules ?? [];
      } catch {
        return;
      }

      const nowSec = Math.floor(Date.now() / 1000);
      const due = schedules.filter(
        (s) => s.executions < s.maxExecutions && s.nextFireAt <= nowSec,
      );
      if (due.length === 0) return;

      // Fire at most one per tick — sequential, in due order (oldest first).
      const target = [...due].sort((a, b) => a.nextFireAt - b.nextFireAt)[0];
      dispatchingRef.current = true;
      try {
        await fireSchedule(target);
      } finally {
        dispatchingRef.current = false;
      }
    };

    const tick = async () => {
      if (document.visibilityState !== "visible") return; // app-open semantics
      if (tickingRef.current) return;
      tickingRef.current = true;
      try {
        await tickInner();
      } finally {
        tickingRef.current = false;
      }
    };

    void tick();
    const interval = setInterval(() => void tick(), TICK_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return null;
}
