"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useBalance, useChainId, useReadContracts } from "wagmi";
import { createPublicClient, erc20Abi, formatUnits, http, type Address, type PublicClient } from "viem";
import { getChainByChainId, VIEM_CHAINS } from "@/lib/chains/registry";
import { useAgentRun } from "@/lib/agent/use-agent-run";
import { useAiProvider } from "@/lib/ai/provider-store";
import { useTokenBalances } from "@/lib/use-token-balances";
import {
  dispatchAgentUserMessage,
  activeSessionBusy,
  chainDisplayName,
} from "@/lib/agent/agent-dispatch";
import type {
  AttestationTriggerConfig,
  AutomationActionConfig,
  AutomationRule,
  BalanceTriggerConfig,
  ScheduleTriggerConfig,
} from "@/lib/automation/types";

// ─────────────────────────────────────────────────────────────────────────────
// AutomationPoller (brief §8) — the app-open engine for user automation rules.
// Mounted inside Web3Frame (needs wagmi context). Every 20s while the tab is
// VISIBLE:
//   1. loads the active rules (GET /api/automation),
//   2. evaluates triggers:
//        schedule            → now - lastFiredAt >= everyMinutes (lastFiredAt
//                              null = eligible immediately on app open — the
//                              queue-and-run behavior)
//        balance_above/_below → wallet balance vs threshold, with hysteresis
//                              (fires only after the condition holds for 2
//                              consecutive evaluations; re-arms after one false)
//        attestation_ready   → the payment's Attestcoin proof landed
//                              (≥1h cooldown per rule)
//   3. when a rule fires: POST /api/automation/[id]/fire (latch + action-log
//      record; notify actions are delivered server-side), then:
//        notify   → done (the notification is in the DB)
//        transfer → routes through the AGENT LOOP so the wallet
//                   action-log semantics apply for free: a synthetic user
//                   message + streaming assistant placeholder land in the
//                   ACTIVE chat session and useAgentRun.run drives the loop.
//                   If a run is already busy the rule is left eligible
//                   (resetLastFired) and retries next tick.
// Nothing executes while document.visibilityState !== "visible".
// ─────────────────────────────────────────────────────────────────────────────

const TICK_MS = 20_000;
/** Hysteresis: consecutive true evaluations required before a balance rule fires. */
const BALANCE_HOLD_ROUNDS = 2;
/** attestation_ready cooldown (per rule). */
const ATTESTATION_COOLDOWN_MS = 60 * 60_000;
const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

interface BalanceCallMeta {
  chainId: number;
  tokenAddress: string;
}

export function AutomationPoller() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const agentRun = useAgentRun();
  const { config, configured } = useAiProvider();
  const { data: nativeBalance } = useBalance({ address });
  const tokenBalances = useTokenBalances();

  /** Balance rules (state so the useReadContracts call list can rebuild). */
  const [balanceRules, setBalanceRules] = useState<AutomationRule[]>([]);

  // ── ERC-20 balances via wagmi useReadContracts (registry + 0x tokens) ─────
  const { calls: erc20Calls, meta: erc20Meta } = useMemo(() => {
    const calls: {
      address: Address;
      abi: typeof erc20Abi;
      functionName: "balanceOf";
      args: [Address];
      chainId: number;
    }[] = [];
    const meta: BalanceCallMeta[] = [];
    if (!address) return { calls, meta };
    for (const rule of balanceRules) {
      const cfg = rule.triggerConfig as BalanceTriggerConfig;
      const chain = getChainByChainId(cfg.chainId);
      if (!chain) continue;
      const sym = cfg.token.trim().toUpperCase();
      if (sym === chain.nativeCurrency.symbol.toUpperCase()) continue; // native → tick-time getBalance
      const known = chain.tokens.find((tk) => tk.symbol.toUpperCase() === sym);
      const tokenAddress = known
        ? known.address
        : ADDR_RE.test(cfg.token.trim())
          ? (cfg.token.trim() as Address)
          : null;
      if (!tokenAddress) continue;
      calls.push({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
        chainId: cfg.chainId,
      });
      meta.push({ chainId: cfg.chainId, tokenAddress });
    }
    return { calls, meta };
  }, [balanceRules, address]);

  const { data: erc20Data } = useReadContracts({
    contracts: erc20Calls,
    query: {
      enabled: erc20Calls.length > 0 && isConnected && Boolean(address),
      refetchInterval: TICK_MS,
    },
  });

  /** Latest raw balanceOf results, keyed `${chainId}:${tokenAddressLower}`. */
  const erc20ResultsRef = useRef<Map<string, bigint>>(new Map());
  useEffect(() => {
    const map = new Map<string, bigint>();
    if (erc20Data && erc20Meta.length > 0) {
      for (let i = 0; i < erc20Data.length && i < erc20Meta.length; i++) {
        const r = erc20Data[i] as { status?: string; result?: unknown } | undefined;
        const m = erc20Meta[i];
        if (!r || !m || r.status !== "success" || typeof r.result !== "bigint") continue;
        map.set(`${m.chainId}:${m.tokenAddress.toLowerCase()}`, r.result);
      }
    }
    erc20ResultsRef.current = map;
  }, [erc20Data, erc20Meta]);

  /** Lazily-created viem public clients (native getBalance / decimals probes). */
  const clientsRef = useRef<Map<number, PublicClient>>(new Map());
  const decimalsRef = useRef<Map<string, number>>(new Map());
  /** Hysteresis state per balance rule. */
  const hysteresisRef = useRef<Map<string, { holds: number; armed: boolean }>>(new Map());
  /** True while an automation agent run is starting/streaming (own dispatch). */
  const dispatchingRef = useRef(false);
  /** In-flight tick guard (StrictMode double-mount, visibility + interval overlap). */
  const tickingRef = useRef(false);

  /** Everything the tick needs, always current (the interval closure is stable). */
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

  // ── The tick: rule loading + trigger evaluation + firing ──────────────────
  // Everything mutable flows through refs, so the interval mounts once and
  // always sees current state.
  useEffect(() => {
    const publicClientFor = (id: number): PublicClient => {
      let c = clientsRef.current.get(id);
      if (!c) {
        const chain = getChainByChainId(id);
        c = createPublicClient({
          chain: VIEM_CHAINS[id],
          transport: http(chain?.rpcUrls[0] ?? "", { timeout: 15_000 }),
        });
        clientsRef.current.set(id, c);
      }
      return c;
    };

    const applyHysteresis = (ruleId: string, holds: boolean): boolean => {
      const st = hysteresisRef.current.get(ruleId) ?? { holds: 0, armed: true };
      if (!holds) {
        // One false evaluation re-arms (prevents flapping).
        hysteresisRef.current.set(ruleId, { holds: 0, armed: true });
        return false;
      }
      const next = { holds: st.holds + 1, armed: st.armed };
      const fire = next.armed && next.holds >= BALANCE_HOLD_ROUNDS;
      if (fire) next.armed = false; // consumed — re-arms when the condition breaks
      hysteresisRef.current.set(ruleId, next);
      return fire;
    };

    const nativeBalanceHuman = async (id: number, wallet: Address): Promise<number | null> => {
      try {
        const bal = await publicClientFor(id).getBalance({ address: wallet });
        return Number(formatUnits(bal, 18));
      } catch {
        return null;
      }
    };

    const probeDecimals = async (id: number, tokenAddress: string): Promise<number | null> => {
      const key = `${id}:${tokenAddress.toLowerCase()}`;
      const cached = decimalsRef.current.get(key);
      if (cached != null) return cached;
      try {
        const d = (await publicClientFor(id).readContract({
          address: tokenAddress as Address,
          abi: erc20Abi,
          functionName: "decimals",
        })) as number;
        if (typeof d === "number") {
          decimalsRef.current.set(key, d);
          return d;
        }
        return null;
      } catch {
        return null;
      }
    };

    const balanceRuleFires = async (rule: AutomationRule): Promise<boolean> => {
      const cfg = rule.triggerConfig as BalanceTriggerConfig;
      const L = latestRef.current;
      const chain = getChainByChainId(cfg.chainId);
      if (!chain || !L.isConnected || !L.address) return applyHysteresis(rule.id, false);

      const sym = cfg.token.trim().toUpperCase();
      let human: number | null = null;
      if (sym === chain.nativeCurrency.symbol.toUpperCase()) {
        // Native balance — fresh publicClient getBalance in this tick.
        human = await nativeBalanceHuman(cfg.chainId, L.address);
      } else {
        const known = chain.tokens.find((tk) => tk.symbol.toUpperCase() === sym);
        const tokenAddress = known
          ? known.address
          : ADDR_RE.test(cfg.token.trim())
            ? cfg.token.trim()
            : null;
        if (!tokenAddress) return applyHysteresis(rule.id, false);
        const raw = erc20ResultsRef.current.get(`${cfg.chainId}:${tokenAddress.toLowerCase()}`);
        if (raw == null) return applyHysteresis(rule.id, false); // read not landed yet
        const decimals = known ? known.decimals : await probeDecimals(cfg.chainId, tokenAddress);
        if (decimals == null) return applyHysteresis(rule.id, false);
        human = Number(formatUnits(raw, decimals));
      }
      if (human == null || !Number.isFinite(human)) return applyHysteresis(rule.id, false);
      const holds =
        rule.triggerType === "balance_above" ? human > cfg.threshold : human < cfg.threshold;
      return applyHysteresis(rule.id, holds);
    };

    const attestationReady = async (paymentId: string): Promise<boolean> => {
      try {
        const res = await fetch(`/api/payments/${paymentId}`, { cache: "no-store" });
        if (!res.ok) return false;
        const { payment } = (await res.json()) as {
          payment: { attestedAt?: number | null; onchainVerifiedAt?: number | null };
        };
        return payment.attestedAt != null || payment.onchainVerifiedAt != null;
      } catch {
        return false;
      }
    };

    /** PATCH helper (status updates / re-queue after a busy run). */
    const patchRule = async (ruleId: string, body: Record<string, unknown>): Promise<void> => {
      try {
        await fetch(`/api/automation/${ruleId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        /* best-effort — next tick's GET re-syncs state */
      }
    };

    /** Fire the latch, then execute: notify → done (server-side); transfer → agent loop. */
    const fireRule = async (rule: AutomationRule): Promise<void> => {
      const L = latestRef.current;
      let action: AutomationActionConfig | null = null;
      let skipped = false;
      try {
        const res = await fetch(`/api/automation/${rule.id}/fire`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "fired" }),
        });
        if (!res.ok) return;
        const json = (await res.json()) as { action?: AutomationActionConfig; skipped?: boolean };
        action = json.action ?? null;
        skipped = json.skipped === true;
      } catch {
        return; // latch failed — rule stays eligible, retry next tick
      }
      if (!action || skipped) return; // duplicate concurrent fire — another tick handled it

      if (action.kind !== "transfer") return; // notify: delivered server-side

      // transfer → the AGENT LOOP via the shared dispatch seam
      // (signature gate + action log for free).
      const chainName = chainDisplayName(action.chainId);
      const userText = `Automation rule "${rule.name}" fired: transfer ${action.amount} ${action.token} to ${action.recipient} on ${chainName}.`;

      const result = await dispatchAgentUserMessage({
        run: L.run,
        providerConfig: L.config,
        sessionModelOverride: null,
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
        // A run is already active — leave the rule eligible, retry next tick.
        await patchRule(rule.id, { resetLastFired: true, lastStatus: "deferred" });
      } else if (result.error) {
        await patchRule(rule.id, { lastStatus: "failed" });
      } else {
        await patchRule(rule.id, { lastStatus: "dispatched" });
      }
    };

    const tickInner = async () => {
      let rules: AutomationRule[] = [];
      try {
        const res = await fetch("/api/automation", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { rules?: AutomationRule[] };
        rules = json.rules ?? [];
      } catch {
        return;
      }
      const active = rules.filter((r) => r.active);
      setBalanceRules(
        active.filter(
          (r) => r.triggerType === "balance_above" || r.triggerType === "balance_below",
        ),
      );
      const now = Date.now();

      for (const rule of active) {
        let fires = false;
        if (rule.triggerType === "schedule") {
          const cfg = rule.triggerConfig as ScheduleTriggerConfig;
          // lastFiredAt null = eligible immediately (queue-and-run on app open).
          fires = rule.lastFiredAt == null || now - rule.lastFiredAt >= cfg.everyMinutes * 60_000;
        } else if (rule.triggerType === "attestation_ready") {
          const cfg = rule.triggerConfig as AttestationTriggerConfig;
          const cooldownOk =
            rule.lastFiredAt == null || now - rule.lastFiredAt >= ATTESTATION_COOLDOWN_MS;
          fires = cooldownOk ? await attestationReady(cfg.paymentId) : false;
        } else {
          fires = await balanceRuleFires(rule);
        }
        if (!fires) continue;

        if (rule.action.kind === "transfer") {
          // Busy guard: skip (without firing) while another agent run is active,
          // no AI provider is configured, or the wallet is disconnected — the
          // rule retries next tick.
          const L = latestRef.current;
          if (dispatchingRef.current || activeSessionBusy() || !L.configured || !L.isConnected) continue;

          dispatchingRef.current = true;
          void fireRule(rule).finally(() => {
            dispatchingRef.current = false;
          });
        } else {
          await fireRule(rule);
        }
      }
    };

    const tick = async () => {
      if (document.visibilityState !== "visible") return; // app-open semantics
      if (tickingRef.current) return; // an earlier tick is still in flight
      tickingRef.current = true;
      try {
        await tickInner();
      } finally {
        tickingRef.current = false;
      }
    };

    void tick();
    const interval = setInterval(() => void tick(), TICK_MS);
    // Resume promptly when the tab becomes visible again.
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
