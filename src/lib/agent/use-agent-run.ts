"use client";

import { useCallback, useMemo, useRef } from "react";
import { useAccount, useWalletClient, useSwitchChain } from "wagmi";
import { useChatStore, newChatMsgId } from "@/lib/chat/chat-store";
import { useI18n } from "@/lib/i18n";
import type { ChatMessageData } from "@/lib/types";
import type { AgentStreamEvent, ToolClientResult, TraceStepDetail } from "@/lib/agent/events";
import { recordTxEvent, type TxLifecycleStatus } from "@/lib/agent/tx-lifecycle";
import {
  execTransfer,
  execBatchTransfer,
  execDeployContract,
  execConditionalRelease,
  execCrossChainSwap,
  type ExecutorWallet,
} from "@/lib/agent/client-executors";

// ─────────────────────────────────────────────────────────────────────────────
// useAgentRun — the browser half of the agent loop (brief §2 client/server
// split). Owns the NDJSON stream consumption and the tool dispatch:
//
//   stream events ──► chat message patches (text, trace steps, confirmations)
//   tool_call_request ──► wallet executor (this file) ──► POST /api/agent/respond
//   confirmation_request ──► pendingConfirmation card ──► user decision ──► POST respond
//
// The sessionId is stable per chat session; the server parks the loop on
// awaitResponse until our POST arrives.
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentRunCallOptions {
  /** Chat history (without the new user message) — P10: entries may carry
   *  serialized prior tool calls/results so a RETRY preserves completed steps
   *  and re-runs only the failed one (see AgentHistoryMessage in loop.ts). */
  history: Array<{
    role: "user" | "assistant";
    content: string;
    toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
    toolCallId?: string;
    toolName?: string;
  }>;
  userText: string;
  assistantMessageId: string;
  providerConfig: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    temperature?: number;
    topP?: number;
    maxTokens?: number | null;
  };
  wallet: {
    address: string | null;
    chainId: number | null;
    holdings: Record<string, { address: string | null; balance: string }> | null;
  } | null;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  error: string | null;
  errorCode: string | null;
  aborted: boolean;
}

function sessionIdFor(chatSessionId: string): string {
  // Stable per chat session; the server accepts [A-Za-z0-9_-]{4,64}.
  const key = `acp-ai:agent-session:${chatSessionId}`;
  try {
    let v = sessionStorage.getItem(key);
    if (!v) {
      v = `ag_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
      sessionStorage.setItem(key, v);
    }
    return v;
  } catch {
    return `ag_${Date.now().toString(36)}`;
  }
}

export function useAgentRun() {
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  // P7/P14 fix: `switchChain` is wagmi's fire-and-forget mutation (returns
  // void, the switch happens in the background) — wrapping it in
  // Promise.resolve made ensureChain's `await` resolve BEFORE the wallet had
  // actually switched, so transactions were signed on whatever chain the
  // wallet happened to be on (the root cause of the 0.5-ETH-on-Sepolia swap
  // incident and the silent Sepolia no-ops). switchChainAsync resolves only
  // after the wallet has switched.
  const { switchChainAsync } = useSwitchChain();
  const { t } = useI18n();
  const busyRef = useRef(false);

  const executorWallet: ExecutorWallet = useMemo(
    () => ({
      address: (address ?? undefined) as `0x${string}` | undefined,
      walletClient,
      switchChain: (args: { chainId: number }) => switchChainAsync(args),
      isConnected,
    }),
    [address, walletClient, switchChainAsync, isConnected],
  );

  const run = useCallback(
    async (opts: AgentRunCallOptions): Promise<AgentRunResult> => {
      if (busyRef.current) {
        return { error: "An agent run is already active in this tab.", errorCode: "busy", aborted: false };
      }
      busyRef.current = true;
      const sid = useChatStore.getState().activeId;
      try {
        if (!sid) return { error: "No chat session.", errorCode: "no-session", aborted: false };
        const sessionId = sessionIdFor(sid);

        // ── Message-beat routing (Phase 3 C1, §4.5) ──────────────────────────
        // One run produces SEPARATE messages per logical beat: the model's
        // narration text streams into its own message; the execution trace
        // lives on ONE dedicated trace message (its own component, updating
        // in place); the narration that follows tool results opens a NEW
        // message. Never a concatenated blob.
        const store = useChatStore.getState();
        const patch = (updater: (m: ChatMessageData) => ChatMessageData) => {
          useChatStore.getState().updateMessage(sid, opts.assistantMessageId, updater);
        };
        const patchMsg = (id: string, updater: (m: ChatMessageData) => ChatMessageData) => {
          useChatStore.getState().updateMessage(sid, id, updater);
        };
        let textMsgId: string | null = opts.assistantMessageId; // active narration message
        let traceMsgId: string | null = null; // the one trace-beat message
        const mkTextMsg = (): string => {
          const id = newChatMsgId();
          useChatStore.getState().addMessage(sid, {
            id,
            role: "assistant",
            content: "",
            createdAt: Date.now(),
            streaming: true,
            aiGenerated: true,
            beat: "text",
          });
          return id;
        };
        const ensureTraceMsg = (): string => {
          if (traceMsgId) return traceMsgId;
          const id = newChatMsgId();
          useChatStore.getState().addMessage(sid, {
            id,
            role: "assistant",
            content: "",
            createdAt: Date.now(),
            streaming: true,
            aiGenerated: true,
            beat: "trace",
            trace: [],
          });
          traceMsgId = id;
          return id;
        };
        /** Narration text arriving while the active message is the trace
         * message opens a fresh text message (result beat). */
        const routeText = (): string => {
          if (!textMsgId) {
            textMsgId = mkTextMsg();
            return textMsgId;
          }
          const cur = useChatStore.getState().sessions[sid]?.messages.find((m) => m.id === textMsgId);
          if (!cur || cur.beat === "trace") {
            textMsgId = mkTextMsg();
          }
          return textMsgId;
        };
        /** A tool step starting finalizes the current narration message
         * (announcement beat complete) and ensures the trace message exists. */
        const routeStep = (): string => {
          if (textMsgId) {
            const cur = useChatStore.getState().sessions[sid]?.messages.find((m) => m.id === textMsgId);
            if (cur && cur.streaming) {
              const id = textMsgId;
              patchMsg(id, (m) => ({ ...m, streaming: false }));
            }
            // The narration beat is COMPLETE once a tool step starts — the
            // next narration text (post-tool-result) must open a NEW message,
            // never append here (C1's exact collision bug).
            textMsgId = null;
          }
          return ensureTraceMsg();
        };
        const finalizeAll = () => {
          for (const id of [textMsgId, traceMsgId]) {
            if (!id) continue;
            patchMsg(id, (m) => ({ ...m, streaming: false }));
          }
        };
        void store; // (store captured once for clarity; reads use fresh getState)

        const res = await fetch("/api/agent/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId,
            messages: [...opts.history, { role: "user", content: opts.userText }],
            providerConfig: opts.providerConfig,
            wallet: opts.wallet,
          }),
          signal: opts.signal,
        });

        if (!res.ok || !res.body) {
          let err = "The agent could not start.";
          let code = "unknown";
          try {
            const b = await res.json();
            err = b.error ?? err;
            code = b.code ?? code;
          } catch {}
          return { error: err, errorCode: code, aborted: false };
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const dispatchTool = async (
          callId: string,
          stepId: string,
          tool: string,
          args: Record<string, unknown>,
        ): Promise<void> => {
          const progress = (detail: TraceStepDetail, status?: "awaiting_signature" | "broadcast" | "confirming") => {
            // Trace steps live on the dedicated trace-beat message (C1) — the
            // dispatch is async, so read the CURRENT trace message id (the
            // trace message is created by step_started before dispatch).
            const traceId = traceMsgId ?? ensureTraceMsg();
            patchMsg(traceId, (m) => ({
              ...m,
              trace: (m.trace ?? []).map((st) =>
                st.stepId === stepId ? { ...st, status: status ?? st.status, detail: { ...st.detail, ...detail } } : st,
              ),
            }));
            // Transaction lifecycle (§4.6): every executor progress beat also
            // lands in the live store (all surfaces re-render instantly) and
            // is POSTed so the server patches the persistent action row.
            let lifecycle: TxLifecycleStatus | null = null;
            if (status === "awaiting_signature") lifecycle = "requested";
            else if (status === "broadcast") lifecycle = "signed";
            else if (status === "confirming") lifecycle = "confirmed";
            if (lifecycle) {
              recordTxEvent(callId, sessionId, {
                status: lifecycle,
                ...(detail.txHash ? { txHash: detail.txHash } : {}),
                ...(detail.chainId != null ? { chainId: detail.chainId } : {}),
                ...(detail.blockNumber != null ? { blockNumber: detail.blockNumber } : {}),
              });
            }
          };
          let result: ToolClientResult;
          if (!isConnected || !walletClient || !address) {
            result = { ok: false, summary: "Wallet not connected — connect a wallet first.", error: "no_wallet" };
          } else {
            try {
              switch (tool) {
                case "transfer":
                  result = await execTransfer(executorWallet, args as never, progress);
                  break;
                case "batch_transfer":
                  result = await execBatchTransfer(executorWallet, args as never, progress);
                  break;
                case "deploy_contract":
                  result = await execDeployContract(executorWallet, args as never, progress);
                  break;
                case "create_conditional_release": {
                  // The prepare layer attached __compiled — the deployment is
                  // the escrow (payable constructor). P11 fix: the ASC deploys
                  // on Creditcoin (chainId 102031) — inject that as the target
                  // chain so the executor never reads an undefined args.chain
                  // (the old "Unsupported chain undefined" bug).
                  const crChain =
                    ((args as Record<string, unknown>).__compiled as { chainId?: number } | undefined)?.chainId ??
                    102031;
                  result = await execDeployContract(
                    executorWallet,
                    { ...(args as Record<string, unknown>), mode: "template", chain: crChain } as never,
                    progress,
                  );
                  break;
                }
                case "execute_conditional_release":
                  result = await execConditionalRelease(executorWallet, args as never, progress);
                  break;
                case "cross_chain_swap":
                  result = await execCrossChainSwap(executorWallet, args as never, progress);
                  break;
                default:
                  result = { ok: false, summary: `No client executor for tool "${tool}".`, error: "no_executor" };
              }
            } catch (e) {
              result = {
                ok: false,
                summary: `Executor crashed: ${e instanceof Error ? e.message : String(e)}`,
                error: "executor_crash",
              };
            }
          }
          // Terminal lifecycle state (§4.6): user rejection and
          // unknown-status (receipt timeout) are first-class outcomes.
          const terminal: TxLifecycleStatus | null = result.ok
            ? "confirmed"
            : result.error === "user_rejected"
              ? "rejected"
              : result.error === "receipt_timeout" || result.error === "unknown_status"
                ? "unknown"
                : "failed";
          recordTxEvent(callId, sessionId, {
            status: terminal,
            ...(result.txHash ? { txHash: result.txHash } : {}),
            ...(result.chainId != null ? { chainId: result.chainId } : {}),
            ...(result.ok ? {} : result.error ? { error: result.error } : {}),
          });
          void fetch("/api/agent/respond", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId, callId, kind: "tool_result", result }),
          }).catch(() => {
            /* the stream's abort handling covers lost runs */
          });
        };

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let evt: AgentStreamEvent;
            try {
              evt = JSON.parse(line) as AgentStreamEvent;
            } catch {
              continue;
            }
            switch (evt.type) {
              case "run_started":
                patch((m) => ({ ...m, runId: evt.runId, streaming: true, beat: "text" }));
                break;
              case "reasoning": {
                const tid = routeText();
                patchMsg(tid, (m) => ({ ...m, reasoning: (m.reasoning ?? "") + evt.text }));
                break;
              }
              case "text": {
                const tid = routeText();
                patchMsg(tid, (m) => ({ ...m, content: (m.content ?? "") + evt.text }));
                break;
              }
              case "step_started": {
                const traceId = routeStep();
                patchMsg(traceId, (m) => ({
                  ...m,
                  trace: [...(m.trace ?? []), { ...evt.step }],
                }));
                break;
              }
              case "step_status": {
                const traceId = traceMsgId ?? ensureTraceMsg();
                patchMsg(traceId, (m) => ({
                  ...m,
                  trace: (m.trace ?? []).map((st) =>
                    st.stepId === evt.stepId
                      ? { ...st, status: evt.status, detail: { ...st.detail, ...(evt.detail ?? {}) } }
                      : st,
                  ),
                }));
                break;
              }
              case "step_finished": {
                const traceId = traceMsgId ?? ensureTraceMsg();
                patchMsg(traceId, (m) => ({
                  ...m,
                  trace: (m.trace ?? []).map((st) =>
                    st.stepId === evt.stepId
                      ? {
                          ...st,
                          status: evt.status,
                          result: evt.result ?? st.result,
                          detail: { ...st.detail, ...(evt.detail ?? {}) },
                          finishedAt: Date.now(),
                        }
                      : st,
                  ),
                }));
                break;
              }
              case "tool_call_request":
                void dispatchTool(evt.callId, evt.stepId, evt.tool, evt.args);
                break;
              case "confirmation_request": {
                const traceId = traceMsgId ?? ensureTraceMsg();
                patchMsg(traceId, (m) => ({ ...m, pendingConfirmation: evt.request }));
                break;
              }
              case "intent":
                patch((m) => ({ ...m, intent: evt.intent as never, status: "reviewing" }));
                break;
              case "debug":
                console.log("[agent] debug:", evt);
                break;
              case "error": {
                // Known codes get a friendly, actionable message; unknown
                // errors pass through verbatim.
                const friendly =
                  evt.code === "provider_not_configured"
                    ? t("chat.providerNotConfigured")
                    : evt.error;
                const tid = routeText();
                patchMsg(tid, (m) => ({
                  ...m,
                  content: (m.content || "") + `\n\n⚠️ ${friendly}`,
                  streaming: false,
                }));
                break;
              }
              case "run_finished":
                patch((m) => ({
                  ...m,
                  streaming: false,
                  runFinish: evt.finishReason,
                }));
                if (traceMsgId) {
                  patchMsg(traceMsgId, (m) => ({ ...m, streaming: false, runFinish: evt.finishReason, pendingConfirmation: undefined }));
                }
                // Clean up an EMPTY leading narration message (model went
                // straight to tool calls with no announcement).
                const lead = useChatStore.getState().sessions[sid]?.messages.find((m) => m.id === opts.assistantMessageId);
                if (lead && lead.beat === "text" && !lead.content.trim() && !lead.reasoning?.trim()) {
                  useChatStore.getState().deleteMessage(sid, opts.assistantMessageId);
                }
                break;
              default:
                break;
            }
          }
        }
        finalizeAll();
        return { error: null, errorCode: null, aborted: false };
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          const sidNow = useChatStore.getState().activeId;
          if (sidNow) {
            useChatStore.getState().updateMessage(sidNow, opts.assistantMessageId, (m) => ({
              ...m,
              streaming: false,
              runFinish: "interrupted",
            }));
          }
          return { error: null, errorCode: null, aborted: true };
        }
        const msg = err instanceof Error ? err.message : "Network error";
        return { error: msg, errorCode: "network-error", aborted: false };
      } finally {
        busyRef.current = false;
      }
    },
    [executorWallet, address, isConnected, walletClient, t],
  );

  /** Answer a confirmation_request from the UI card. */
  const answerConfirmation = useCallback(
    async (assistantMessageId: string, callId: string, approved: boolean): Promise<void> => {
      const sid = useChatStore.getState().activeId;
      if (!sid) return;
      const sessionId = sessionIdFor(sid);
      // The confirmation card rides the trace-beat message (C1). The caller
      // passes the message that RENDERED the card — find the trace steps
      // wherever they live (trace message or legacy combined message).
      useChatStore.getState().updateMessage(sid, assistantMessageId, (m) => ({
        ...m,
        pendingConfirmation: undefined,
        trace: (m.trace ?? []).map((st) =>
          st.callId === callId && st.status === "awaiting_confirmation"
            ? { ...st, status: approved ? "running" : "declined" }
            : st,
        ),
      }));
      await fetch("/api/agent/respond", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, callId, kind: "confirmation", approved }),
      }).catch(() => {});
    },
    [],
  );

  return { run, answerConfirmation };
}
