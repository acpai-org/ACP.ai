"use client";

import { useChatStore, newChatMsgId } from "@/lib/chat/chat-store";
import type { ChatMessageData } from "@/lib/types";
import type { AgentRunCallOptions, AgentRunResult } from "@/lib/agent/use-agent-run";
import { type AiProviderConfig } from "@/lib/ai/provider-store";
import { getChainByChainId } from "@/lib/chains/registry";

// ─────────────────────────────────────────────────────────────────────────────
// Shared agent dispatch (brief §5 + §8): the ONE seam through which
// non-chat surfaces put work in front of the agent loop.
//
// Automation rules (§8) and recurring payment schedules (§5) both dispatch
// their transfers by appending a synthetic user message to the ACTIVE chat
// session and running the loop — so the wallet signature gate and the
// the action log apply identically to scheduled and conversational spends.
// Keep this module the single implementation; callers only pre-fire-guard
// and post-run-report.
// ─────────────────────────────────────────────────────────────────────────────

export interface DispatchWallet {
  address: string | null;
  chainId: number | null;
  holdings: Record<string, { address: string | null; balance: string }> | null;
}

function newMessage(
  role: ChatMessageData["role"],
  content: string,
  extra?: Partial<ChatMessageData>,
): ChatMessageData {
  return {
    id: newChatMsgId(),
    role,
    content,
    createdAt: Date.now(),
    ...extra,
  };
}

/** True while any message in the active session is streaming (busy check). */
export function activeSessionBusy(): boolean {
  const store = useChatStore.getState();
  const sid = store.activeId;
  if (!sid) return false;
  return (store.sessions[sid]?.messages ?? []).some((m) => m.streaming);
}

export interface DispatchAgentUserMessageOptions {
  /** useAgentRun().run — the loop entry point. */
  run: (opts: AgentRunCallOptions) => Promise<AgentRunResult>;
  /** Raw provider store config (custom BYOK provider only — C27). */
  providerConfig: AiProviderConfig;
  /** Optional per-chat model override (chat sessions store one). */
  sessionModelOverride?: string | null;
  wallet: DispatchWallet | null;
  userText: string;
}

/**
 * Append the synthetic user turn + streaming assistant placeholder to the
 * active chat session (creating one if needed) and run the agent loop.
 */
export async function dispatchAgentUserMessage(
  opts: DispatchAgentUserMessageOptions,
): Promise<AgentRunResult> {
  const store = useChatStore.getState();
  let sid = store.activeId;
  if (!sid || !store.sessions[sid]) sid = store.newChat();
  const session = useChatStore.getState().sessions[sid];
  const history = (session?.messages ?? [])
    .filter((m) => m.role === "user" || m.content.trim().length > 0)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  useChatStore.getState().addMessage(sid, newMessage("user", opts.userText));
  const assistantId = newChatMsgId();
  useChatStore.getState().addMessage(
    sid,
    newMessage("assistant", "", { id: assistantId, streaming: true, aiGenerated: true, beat: "text" }),
  );

  const effectiveModel =
    opts.sessionModelOverride ?? session?.modelOverride ?? opts.providerConfig.model;

  return opts.run({
    history,
    userText: opts.userText,
    assistantMessageId: assistantId,
    providerConfig: {
      baseUrl: opts.providerConfig.baseUrl,
      apiKey: opts.providerConfig.apiKey,
      model: effectiveModel,
      temperature: opts.providerConfig.temperature,
      topP: opts.providerConfig.topP,
      maxTokens: opts.providerConfig.maxTokens,
    },
    wallet: opts.wallet,
  });
}

/** Chain display helper for dispatch texts (mirrors automation copy). */
export function chainDisplayName(chainId: number | null | undefined): string {
  if (chainId == null) return "the active chain";
  return getChainByChainId(chainId)?.name ?? `chain ${chainId}`;
}
