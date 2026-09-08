"use client";

import { useCallback, useEffect, useMemo, useRef, useState, memo, startTransition } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useAccount, useBalance, useChainId } from "wagmi";
import { formatUnits } from "viem";
import type { ChatMessageData } from "@/lib/types";
import { ChatMessage } from "@/components/chat-message";
import { useAgentRun, type AgentRunCallOptions } from "@/lib/agent/use-agent-run";
import { ChatInput } from "@/components/chat-input";
import { AiProviderButton } from "@/components/ai-provider-button";
import { Sparkles, Plus, MessageSquare, Trash2, X, Pencil, Radar, Send, BookOpen, ArrowDown, PanelLeftClose, PanelLeftOpen, Search, FileText, Check, Link2, Download, Pin, PinOff, Wallet, UserPlus } from "lucide-react";
import { Wordmark } from "@/components/wordmark";
import { useContacts } from "@/lib/api";
import { useSettlePayment } from "@/lib/use-settle-payment";
import { useTokenBalances } from "@/lib/use-token-balances";
import { useAiProvider } from "@/lib/ai/provider-store";
import { useChatStore, newChatMsgId } from "@/lib/chat/chat-store";
import { useChatsNav } from "@/lib/chats-nav";
import { resolveAttachments, type AttachmentWalletContext } from "@/lib/chat/resolve-attachments";
import type { SlashCommandId } from "@/lib/chat/slash-commands";
import { useAppKitSafe } from "@/lib/wagmi/appkit-init";
import { PALETTE_ASK_EVENT, PENDING_ASK_KEY, PALETTE_JUMP_EVENT, buildMessagePermalink, takePendingJump, peekPendingJump, dropPendingJump, writePendingJump, jumpToMessage, openShortcutsHelp, type ChatJumpTarget } from "@/lib/palette-events";
import { messageSearchTexts } from "@/lib/message-search";
import { firePaymentConfetti } from "@/lib/confetti";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n/types";
import { dropDraft } from "@/lib/chat/draft-store";
import { ShootingStars } from "@/components/ui/shooting-stars";
import { StarsBackground } from "@/components/ui/stars-background";
import { ModelPicker } from "@/components/model-picker";
import { cn } from "@/lib/utils";

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

export function ChatView() {
  const { sessions, order, activeId, newChat, selectChat, deleteChat, renameChat, setChatModelOverride, togglePin, sidebarCollapsed, toggleSidebarCollapsed } = useChatStore();

  const [isThinking, setIsThinking] = useState(false);
  // N7: the CHATS drawer state lives in the global chats-nav store so the
  // Android top-bar control (Navbar) can toggle it from any page.
  const sidebarOpen = useChatsNav((s) => s.open);
  const setSidebarOpen = useChatsNav((s) => s.setOpen);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [editingPrefill, setEditingPrefill] = useState<string | undefined>(undefined);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const pollingRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const pollingTimeouts = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const confettiFiredRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const pollers = pollingRef.current;
    const timeouts = pollingTimeouts.current;
    const confettiSet = confettiFiredRef.current;
    return () => {
      pollers.forEach((interval) => clearInterval(interval));
      pollers.clear();
      timeouts.forEach((t) => clearTimeout(t));
      timeouts.clear();
      confettiSet.clear();
    };
  }, []);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Scroll-follow state: the reader's position decides whether streaming
  // chunks auto-scroll (near bottom → follow; scrolled up → never yank) and
  // whether the floating scroll-to-bottom affordance shows.
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const [showScrollDown, setShowScrollDown] = useState(false);
  // R7: transcript top fade — visible only while content continues above
  // the viewport (scrollTop > 16), so the transcript's top edge reads as a
  // scrollable continuation instead of a hard cut.
  const [showScrollUp, setShowScrollUp] = useState(false);

  useEffect(() => { startTransition(() => setMounted(true)); }, []);

  const { open } = useAppKitSafe();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  // R10 (state-aware welcome): the empty-state suggestion chips react to the
  // real wallet + address-book state — a disconnected wallet is invited to
  // connect, a contact-less wallet to save a payee, a contact-rich wallet to
  // pay a real person by name.
  const { data: contactsData } = useContacts();
  const firstContactLabel = useMemo(() => {
    const list = contactsData ?? [];
    // Prefer a favorite, then the most recently used, then the first row —
    // the chip should name the person the user is most likely to pay.
    return (list.find((c) => c.favorite) ?? list[0])?.label;
  }, [contactsData]);
  const { settle, isSettling, cancelSettlement } = useSettlePayment();
  const { config, configured } = useAiProvider();
  const { t } = useI18n();
  const tokenBalances = useTokenBalances();
  const { data: nativeBalance } = useBalance({ address });

  const activeSession = activeId ? sessions[activeId] ?? null : null;
  const messages = useMemo(() => activeSession?.messages ?? [], [activeSession]);

  const ensureSession = useCallback((): string => {
    if (activeId && sessions[activeId]) return activeId;
    return newChat();
  }, [activeId, sessions, newChat]);

  const startPolling = useCallback((paymentId: string, messageId: string) => {
    if (pollingRef.current.has(messageId)) return;
    pollingRef.current.forEach((interval) => clearInterval(interval));
    pollingRef.current.clear();
    pollingTimeouts.current.forEach((t) => clearTimeout(t));
    pollingTimeouts.current.clear();

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/payments/${paymentId}`, { cache: "no-store" });
        if (!res.ok) return;
        const { payment } = (await res.json()) as {
          payment: {
            status: string;
            txHash?: string | null;
          };
        };
        const sid = useChatStore.getState().activeId;
        if (!sid) return;
        useChatStore.getState().updateMessage(sid, messageId, (m) => {
          if (payment.status === "settled") {
            clearInterval(interval);
            pollingRef.current.delete(messageId);
            if (!confettiFiredRef.current.has(messageId)) {
              confettiFiredRef.current.add(messageId);
              firePaymentConfetti();
            }
            return {
              ...m,
              status: "settled",
              txHash: payment.txHash ?? m.txHash,
            };
          }
          if (payment.status === "failed") {
            clearInterval(interval);
            pollingRef.current.delete(messageId);
            return { ...m, status: "failed" };
          }
          return m;
        });
      } catch {
        // Ignore polling errors
      }
    }, 3000);

    pollingRef.current.set(messageId, interval);

    const timeout = setTimeout(() => {
      const existing = pollingRef.current.get(messageId);
      if (existing) {
        clearInterval(existing);
        pollingRef.current.delete(messageId);
      }
      pollingTimeouts.current.delete(messageId);

      const sid = useChatStore.getState().activeId;
      if (sid) {
        useChatStore.getState().updateMessage(sid, messageId, (m) => {
          if (m.status === "settled" || m.status === "failed") return m;
          return {
            ...m,
            status: "sent",
            paymentStep: "sent",
          };
        });

        const msg = useChatStore.getState().sessions[sid]?.messages.find((m) => m.id === messageId);
        if (msg?.paymentId) {
          fetch(`/api/payments/${msg.paymentId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "sent" }),
          }).catch(() => {});
        }
      }
    }, 120_000);

    pollingTimeouts.current.set(messageId, timeout);
  }, []);

  // P23: the FIRST scroll placement of a session view lands INSTANTLY
  // (behavior: "auto") — no animated top-to-bottom scroll-through on page
  // navigation or mount. Subsequent follows (streaming growth) stay smooth.
  const initialPlacementRef = useRef(true);

  const scrollToBottom = useCallback((behavior?: ScrollBehavior) => {
    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: behavior ?? "smooth", block: "end" });
    });
  }, []);

  useEffect(() => {
    // Keep the scroll affordance fresh when content grows WITHOUT a scroll
    // event (streaming while the reader is up the transcript), and only
    // auto-follow new content when the reader is already at (or near) the
    // bottom — scrolling up to reread history must not be yanked back down
    // on every streaming chunk.
    const el = scrollRef.current;
    if (el) {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScrollDown(distance > 260);
      setShowScrollUp(el.scrollTop > 16);
    }
    if (isNearBottomRef.current) {
      // P23: the very first placement (mount / navigation to the Chat page)
      // snaps directly to the latest message instead of visibly scrolling
      // through the whole history.
      const first = initialPlacementRef.current;
      initialPlacementRef.current = false;
      scrollToBottom(first ? "auto" : undefined);
    }
    // `mounted` matters: the persisted store hydrates synchronously, so the
    // messages reference is IDENTICAL across the skeleton→real-tree flip and
    // this effect would otherwise never re-run once the scroller exists.
  }, [messages, isThinking, scrollToBottom, mounted]);

  // P23 (session switches): landing on a DIFFERENT session view is also a
  // first placement — snap instantly instead of scrolling through history.
  const lastActiveIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeId && lastActiveIdRef.current !== activeId) {
      lastActiveIdRef.current = activeId;
      initialPlacementRef.current = true;
    }
  }, [activeId]);

  // "/" focuses the composer (chat-app convention) when no other field is
  // capturing keystrokes. The composer textarea carries the
  // data-chat-composer attribute so edit-mode textareas never win.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      if (
        el instanceof HTMLElement &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      ) {
        return;
      }
      const composer = document.querySelector<HTMLTextAreaElement>(
        "[data-chat-composer]",
      );
      if (composer) {
        e.preventDefault();
        composer.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Phase 2: the agent loop channel ─────────────────────────────────────
  // Replaces the Phase-1 single-shot /api/chat stream: NDJSON events carry the
  // text, the live execution trace, tool dispatches and confirmation prompts;
  // the wallet-side executors live in lib/agent/use-agent-run.ts.
  const agentRun = useAgentRun();

  const callAiStream = useCallback(
    async (
      userText: string,
      assistantId: string,
      session: string,
      signal?: AbortSignal,
      /** P10: retry-mode history override — serialized prior tool calls +
       *  results so the loop re-runs ONLY the failed step (completed steps'
       *  results are preserved in the model context). */
      historyOverride?: AgentRunCallOptions["history"],
    ): Promise<{ error: string | null; errorCode: string | null; aborted: boolean }> => {
      const sid = useChatStore.getState().activeId;
      const currentSession = sid ? useChatStore.getState().sessions[sid] : null;
      const effectiveModel = currentSession?.modelOverride ?? config.model;
      const currentMessages = sid ? (useChatStore.getState().sessions[sid]?.messages ?? []) : [];
      // N26: context length — cap the history tail at the user's setting
      // (null = full history). The newest messages always survive the cut.
      const contextCap = config.contextMessages;
      const cappedMessages =
        contextCap != null && currentMessages.length > contextCap
          ? currentMessages.slice(-contextCap)
          : currentMessages;
      const history: AgentRunCallOptions["history"] = historyOverride ??
        cappedMessages
          .filter((m) => m.id !== assistantId)
          .filter((m) => m.role === "user" || m.content.trim().length > 0)
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

      return agentRun.run({
        history,
        userText,
        assistantMessageId: assistantId,
        providerConfig: {
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          model: effectiveModel,
          temperature: config.temperature,
          topP: config.topP,
          maxTokens: config.maxTokens,
        },
        wallet: isConnected
          ? {
              address: address ?? null,
              chainId: chainId ?? null,
              holdings: (() => {
                const h: Record<string, { address: string | null; balance: string }> = {};
                if (nativeBalance?.value) {
                  const nativeSym = nativeBalance.symbol ?? "ETH";
                  h[nativeSym] = { address: null, balance: nativeBalance.value.toString() };
                }
                if (tokenBalances.data) {
                  for (const tk of tokenBalances.data) {
                    h[tk.symbol] = { address: tk.address, balance: tk.balance };
                  }
                }
                return Object.keys(h).length > 0 ? h : null;
              })(),
            }
          : null,
        signal,
      });
    },
    [config, isConnected, chainId, address, nativeBalance, tokenBalances, agentRun],
  );

  const handleAnswerConfirmation = useCallback(
    (message: ChatMessageData, callId: string, approved: boolean, rememberChoice: boolean) => {
      if (rememberChoice) {
        // Persist the custom-warning dismissal (per-user, server-side).
        void fetch("/api/agent/policy", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "dismiss-custom-warning" }),
        }).catch(() => {});
      }
      void agentRun.answerConfirmation(message.id, callId, approved);
    },
    [agentRun],
  );

  // C23: a live snapshot of wallet state for attachment resolution — data is
  // read at SEND time so every attachment carries fresh numbers.
  const buildAttachmentCtx = useCallback(
    (): AttachmentWalletContext => ({
      connected: isConnected,
      address: address ?? null,
      chainId: chainId ?? null,
      nativeBalance: nativeBalance
        ? formatUnits(nativeBalance.value, nativeBalance.decimals)
        : null,
      nativeSymbol: nativeBalance?.symbol ?? null,
      tokens: (tokenBalances.data ?? []).map((tk) => ({
        symbol: tk.symbol,
        balance: tk.balanceHuman ?? tk.balance,
        address: tk.address,
      })),
    }),
    [isConnected, address, chainId, nativeBalance, tokenBalances.data],
  );

  /** The assistant-turn core shared by send / edit-resend / regenerate (C22):
   * parks an empty streaming assistant message, runs the loop, and lands the
   * result. The user message must ALREADY be in the transcript. */
  const runAssistantTurn = useCallback(
    async (
      sid: string,
      promptText: string,
      historyOverride?: AgentRunCallOptions["history"],
    ): Promise<void> => {
      setIsThinking(true);

      if (!configured) {
        setIsThinking(false);
        useChatStore.getState().addMessage(
          sid,
          newMessage("assistant", t("chat.notConfigured")),
        );
        return;
      }

      const assistantId = newChatMsgId();
      useChatStore.getState().addMessage(
        sid,
        newMessage("assistant", "", {
          id: assistantId,
          streaming: true,
          aiGenerated: true,
          beat: "text",
        }),
      );

      const controller = new AbortController();
      abortRef.current = controller;

      const result = await callAiStream(promptText, assistantId, sid, controller.signal, historyOverride);
      abortRef.current = null;
      setIsThinking(false);

      if (result.aborted) return;

      if (result.error) {
        let errorContent = t("chat.errorEncountered", { error: result.error });
        if (result.errorCode === "invalid-key") {
          errorContent = t("chat.errorInvalidKey");
        } else if (result.errorCode === "no-api-key") {
          errorContent = t("chat.errorNoApiKey");
        } else if (result.errorCode === "rate-limited") {
          errorContent = t("chat.errorRateLimit");
        }
        useChatStore.getState().updateMessage(sid, assistantId, (m) => ({
          ...m,
          streaming: false,
          content: m.content || errorContent,
          reasoning: m.reasoning,
        }));
      }
    },
    [configured, callAiStream, t],
  );

  const handleSend = useCallback(
    async (text: string, attachments?: SlashCommandId[]) => {
      const editMsgId = editingMessageId;
      setEditingPrefill(undefined);
      setEditingMessageId(null);
      const sid = ensureSession();

      // C23: resolve pinned context attachments to fresh text (failures are
      // honest inline, never silent) and append them to the outgoing prompt.
      let promptText = text;
      if (attachments && attachments.length > 0) {
        let block = "";
        try {
          block = await resolveAttachments(attachments, buildAttachmentCtx());
        } catch {
          block = "";
        }
        if (block) promptText = `${text}\n\n${block}`;
      }

      if (editMsgId) {
        useChatStore.getState().updateMessage(sid, editMsgId, (m) => ({
          ...m,
          content: text,
          ...(attachments ? { contextAttachments: attachments } : {}),
        }));
        // C22 edit-resend: the messages AFTER the edited one (the old
        // assistant reply to the OLD text, plus everything downstream) are
        // stale — truncate them so the re-run regenerates from the edited
        // turn. Without this, old and new replies both stayed in the
        // transcript and both rode the next request's context.
        useChatStore.getState().truncateAfter(sid, editMsgId);
      } else {
        useChatStore.getState().addMessage(
          sid,
          newMessage("user", text, {
            ...(attachments ? { contextAttachments: attachments } : {}),
          }),
        );
      }

      await runAssistantTurn(sid, promptText);
    },
    [ensureSession, setEditingPrefill, editingMessageId, setEditingMessageId, runAssistantTurn, buildAttachmentCtx],
  );

  // C22 + P10: regenerate/retry — the LAST assistant message gets one of two
  // behaviors:
  //   • RETRY FROM FAILURE (P10): when the turn ended with FAILED steps, the
  //     completed steps' tool calls + results are serialized into the model
  //     context and ONLY the failed step is re-run — completed steps are NEVER
  //     re-executed (a blind full re-run would re-send transactions).
  //   • CLASSIC REGENERATE (C22): a clean turn re-runs from the originating
  //     user message (everything after it is truncated first).
  const handleRegenerate = useCallback(
    async (message: ChatMessageData) => {
      if (message.role !== "assistant" || isThinking) return;
      const sid = useChatStore.getState().activeId;
      if (!sid) return;
      const msgs = useChatStore.getState().sessions[sid]?.messages ?? [];
      const idx = msgs.findIndex((m) => m.id === message.id);
      if (idx === -1) return;

      // nearest preceding user message = the turn's origin
      let originIdx = -1;
      for (let i = idx - 1; i >= 0; i--) {
        if (msgs[i].role === "user") {
          originIdx = i;
          break;
        }
      }
      if (originIdx === -1) return;

      const origin = msgs[originIdx];
      // The turn's full step list (trace beats may be separate messages).
      const turnMsgs = msgs.slice(originIdx + 1, idx + 1);
      const allSteps = turnMsgs.flatMap((m) => m.trace ?? []);
      const failedSteps = allSteps.filter((st) => st.status === "failed" || st.status === "interrupted");
      const narrationContent = turnMsgs.find((m) => m.beat === "text")?.content ?? "";

      // ── P10 retry-from-failure mode ─────────────────────────────────────────
      if (failedSteps.length > 0 && !message.streaming) {
        // Resolve the origin's pinned context FRESH (same as classic mode).
        let originText = origin.content;
        const attachments = (origin.contextAttachments ?? []) as SlashCommandId[];
        if (attachments.length > 0) {
          try {
            const block = await resolveAttachments(attachments, buildAttachmentCtx());
            if (block) originText = `${origin.content}\n\n${block}`;
          } catch {
            /* keep the bare text */
          }
        }
        // Serialize the COMPLETED steps as real tool results the model must
        // not repeat; the failed steps as explicit retry directives.
        const history: AgentRunCallOptions["history"] = [
          ...msgs
            .slice(0, originIdx)
            .filter((m) => m.role === "user" || (m.role === "assistant" && m.content.trim().length > 0))
            .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
          { role: "user" as const, content: originText },
          // The assistant's prior narration + ALL its tool calls.
          {
            role: "assistant" as const,
            content: narrationContent,
            toolCalls: allSteps.map((st) => ({
              id: st.callId,
              name: st.tool,
              args: (st.args ?? {}) as Record<string, unknown>,
            })),
          },
        ];
        for (const st of allSteps) {
          if (st.status === "succeeded" && st.result != null) {
            history.push({
              role: "assistant",
              content: JSON.stringify(st.result),
              toolCallId: st.callId,
              toolName: st.tool,
            });
          } else if (st.status === "failed" || st.status === "interrupted") {
            const reason =
              st.result && typeof (st.result as { summary?: unknown }).summary === "string"
                ? (st.result as { summary: string }).summary
                : st.status;
            history.push({
              role: "assistant",
              content: `STEP FAILED — do not treat its result as done. Failure: ${reason}. (The user pressed retry: re-run ONLY this tool call now. The completed steps' results above are final and MUST NOT be repeated.)`,
              toolCallId: st.callId,
              toolName: st.tool,
            });
          } else {
            // Declined / other terminal states — surfaced verbatim.
            history.push({
              role: "assistant",
              content: JSON.stringify(st.result ?? { status: st.status }),
              toolCallId: st.callId,
              toolName: st.tool,
            });
          }
        }
        await runAssistantTurn(
          sid,
          "(The user pressed retry after the previous turn failed. The tool results above are the turn's REAL state: completed steps are done — do NOT re-execute them. Re-run only the failed step, then finish the task.)",
          history,
        );
        return;
      }

      // ── Classic regenerate (C22) ────────────────────────────────────────────
      useChatStore.getState().truncateAfter(sid, origin.id);

      let promptText = origin.content;
      const attachments = (origin.contextAttachments ?? []) as SlashCommandId[];
      if (attachments.length > 0) {
        try {
          const block = await resolveAttachments(attachments, buildAttachmentCtx());
          if (block) promptText = `${origin.content}\n\n${block}`;
        } catch {
          /* keep the bare text — honest failure lands in the run itself */
        }
      }
      await runAssistantTurn(sid, promptText);
    },
    [isThinking, buildAttachmentCtx, runAssistantTurn],
  );

  // ── Command-palette "Ask the assistant" handoff (see lib/palette-events) ──
  // Live event while the chat page is mounted + one-shot sessionStorage
  // consumption for asks launched from OTHER pages (palette navigated here).
  // The ref is updated inside an effect (not during render) per the compiler
  // refs rule; the listener itself only reads the ref in event handlers.
  const handleSendRef = useRef(handleSend);
  useEffect(() => {
    handleSendRef.current = handleSend;
  }, [handleSend]);
  useEffect(() => {
    const onAsk = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (typeof detail === "string" && detail.trim()) {
        // The chat is mounted — this event is the authoritative handoff.
        // Clear the sessionStorage copy so a later remount can't double-send.
        try { sessionStorage.removeItem(PENDING_ASK_KEY); } catch { /* private mode */ }
        void handleSendRef.current(detail);
      }
    };
    window.addEventListener(PALETTE_ASK_EVENT, onAsk);
    try {
      const pending = sessionStorage.getItem(PENDING_ASK_KEY);
      if (pending) {
        sessionStorage.removeItem(PENDING_ASK_KEY);
        // Run after paint so the freshly-mounted chat paints the composer
        // before the assistant reply starts streaming in.
        requestAnimationFrame(() => void handleSendRef.current(pending));
      }
    } catch {
      /* private mode */
    }
    return () => window.removeEventListener(PALETTE_ASK_EVENT, onAsk);
  }, []);

  // ── Message-search jump (palette → chat) ──────────────────────────────────
  // Reveal a message from cross-session search: scroll it into view (center)
  // and flash a highlight ring so the eye lands on it. Two triggers funnel
  // into one imperative helper:
  //   • the live PALETTE_JUMP_EVENT when the target session is already the
  //     active one (no activeId change → no effect below), and
  //   • a [activeId] effect consuming the sessionStorage handoff (covers
  //     cross-session jumps and cross-page navigation, where the event fired
  //     before this component was mounted).
  // read-once semantics on the sessionStorage key make double-fire harmless.
  //
  // R3 follow-ups: the jump target may carry a search `term` — after the
  // scroll, every occurrence of that term inside the target message gets a
  // temporary <mark> (the flash alone never told the reader WHY they landed
  // here). Marks live outside React's knowledge: they are unwrapped on the
  // next jump, after a fade timeout, or whenever React re-renders the node.
  const termFadeTimeout = useRef<number | null>(null);
  /** Bounded retry timer for the pending reveal — cleared on unmount so a
   *  detached ref never keeps polling (see revealMessage). */
  const revealRetryTimer = useRef<number | null>(null);

  const clearTermMarks = useCallback(() => {
    const root = scrollRef.current;
    if (!root) return;
    root.querySelectorAll<HTMLElement>("mark.msg-term-hit").forEach((m) => {
      const parent = m.parentNode;
      if (!parent) return;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      m.remove();
      parent.normalize();
    });
  }, []);

  const highlightTermInMessage = useCallback((el: HTMLElement, rawTerm: string) => {
    const needle = rawTerm.trim().toLowerCase();
    if (needle.length < 2) return 0;
    let wrapped = 0;
    const CAP = 80;
    // Text-node walk: skips existing marks (re-jump safety) and never enters
    // script/style. splitText/splitText/replaceWith wraps each match in place.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = (node as Text).parentElement;
        if (!p || p.closest("mark.msg-term-hit, script, style")) return NodeFilter.FILTER_REJECT;
        const v = node.nodeValue ?? "";
        return v.toLowerCase().includes(needle) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    const nodes: Text[] = [];
    for (let n = walker.nextNode(); n != null && nodes.length < CAP; n = walker.nextNode()) nodes.push(n as Text);
    for (const t of nodes) {
      let node: Text = t;
      while (node.nodeValue && wrapped < CAP) {
        const idx = node.nodeValue.toLowerCase().indexOf(needle);
        if (idx < 0) break;
        const matchNode = node.splitText(idx);
        const restNode = matchNode.splitText(needle.length);
        const mark = document.createElement("mark");
        mark.className = "msg-term-hit";
        mark.textContent = matchNode.nodeValue;
        matchNode.replaceWith(mark);
        wrapped += 1;
        node = restNode;
      }
    }
    return wrapped;
  }, []);

  const revealMessage = useCallback(
    (messageId: string, term?: string) => {
      // The target element may not be committed yet (lazy chunk resolving,
      // session switch re-render, store hydration). Retry briefly instead of
      // silently giving up — bounded so a stale id can never loop forever.
      let tries = 0;
      const reveal = () => {
        const el = scrollRef.current?.querySelector<HTMLElement>(`[data-msg-id="${messageId}"]`);
        if (!el) {
          if (tries++ < 30) {
            revealRetryTimer.current = window.setTimeout(reveal, 33);
            return;
          }
          return; // honestly lost — target never appeared
        }
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.remove("msg-jump-highlight");
        // restart the animation on re-jumps
        void el.offsetWidth;
        el.classList.add("msg-jump-highlight");
        window.setTimeout(() => el.classList.remove("msg-jump-highlight"), 2000);
        // Term marks: clear stale ones, wrap fresh ones, schedule the fade.
        clearTermMarks();
        if (term && term.trim().length >= 2) {
          highlightTermInMessage(el, term);
          if (termFadeTimeout.current) window.clearTimeout(termFadeTimeout.current);
          termFadeTimeout.current = window.setTimeout(() => {
            scrollRef.current
              ?.querySelectorAll<HTMLElement>("mark.msg-term-hit")
              .forEach((m) => m.classList.add("msg-term-hit-fading"));
            termFadeTimeout.current = window.setTimeout(clearTermMarks, 500);
          }, 6000);
        } else if (termFadeTimeout.current) {
          window.clearTimeout(termFadeTimeout.current);
          termFadeTimeout.current = null;
        }
      };
      // Kick off promptly (a tick out so a just-scheduled re-render can
      // commit first), then rely on the internal retry above.
      revealRetryTimer.current = window.setTimeout(reveal, 0);
    },
    [clearTermMarks, highlightTermInMessage],
  );

  useEffect(() => {
    const onJump = (e: Event) => {
      const detail = (e as CustomEvent<ChatJumpTarget>).detail;
      if (detail && detail.sessionId === useChatStore.getState().activeId) {
        takePendingJump(); // consumed by the live path — the [activeId] effect must not double-fire
        revealMessage(detail.messageId, detail.term);
      }
    };
    window.addEventListener(PALETTE_JUMP_EVENT, onJump);
    return () => window.removeEventListener(PALETTE_JUMP_EVENT, onJump);
  }, [revealMessage]);

  // ── Message permalinks (R3) ──────────────────────────────────────────
  // A copied message link looks like `/?chat=<sessionId>#msg=<messageId>`.
  // Consumed on mount (fresh load, new tab, or SPA navigation back to the
  // chat page) and on in-page hashchange (pasting a link while already on
  // the chat). The URL is then stripped via replaceState so refresh/back
  // never re-triggers the jump.
  //
  // DECLARED BEFORE the pending-jump effect below on purpose: on a mount,
  // this effect writes the pending-jump entry, and the pending-jump effect
  // (which runs after it in the same commit) peeks it. A direct reveal here
  // would race React StrictMode's dev double-mount — the first (doomed)
  // mount's reveal would die with its detached ref AND the URL would already
  // be stripped, so the remounted instance would have nothing to consume.
  useEffect(() => {
    const consume = (viaHashChange: boolean) => {
      try {
        const url = new URL(window.location.href);
        const chatParam = url.searchParams.get("chat");
        const msgId = url.hash.match(/^#msg=(.+)$/)?.[1] ?? null;
        if (!chatParam && !msgId) return;
        const store = useChatStore.getState();
        let sid = chatParam && store.sessions[chatParam] ? chatParam : null;
        // Hash-only links (hand-trimmed URLs): locate the session that owns
        // the message instead of giving up.
        if (!sid && msgId) {
          sid =
            Object.keys(store.sessions).find((id) =>
              store.sessions[id].messages.some((m) => m.id === decodeURIComponent(msgId)),
            ) ?? null;
        }
        if (sid) {
          if (msgId) {
            // Feed the jump bridge instead of revealing directly: the
            // pending-jump effect below lands the reveal once the session's
            // messages have committed (and re-lands it on a StrictMode
            // remount). Only the hashchange path is guaranteed to run on a
            // live, fully-mounted instance — it may reveal immediately.
            writePendingJump({ sessionId: sid, messageId: decodeURIComponent(msgId) });
            if (store.activeId === sid && viaHashChange) {
              takePendingJump(); // live instance — consume + reveal now
              revealMessage(decodeURIComponent(msgId));
            } else {
              store.selectChat(sid);
            }
          } else {
            store.selectChat(sid);
          }
        }
        window.history.replaceState(null, "", window.location.pathname);
      } catch {
        /* private mode — leave the URL alone */
      }
    };
    consume(false);
    const onHash = () => consume(true);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [revealMessage]);

  // ── Pending jump landing (palette / sidebar search / permalink) ───────
  // Peek WITHOUT consuming, then consume only once the reveal actually
  // landed. Under React StrictMode (dev), the first mount of this component
  // is immediately discarded: if it had consumed the entry, the jump would
  // be lost — the remounted instance would find nothing. With peek
  // semantics the doomed mount's attempt is simply canceled by cleanup and
  // the remount re-reads the same entry.
  useEffect(() => {
    const target = peekPendingJump();
    if (!target || target.sessionId !== activeId) return;
    let timer = 0;
    let tries = 0;
    const attempt = () => {
      const el = scrollRef.current?.querySelector<HTMLElement>(`[data-msg-id="${target.messageId}"]`);
      if (!el) {
        // Messages not committed yet (lazy chunk, hydration, session switch
        // re-render). Bounded retry — a stale id gives up honestly and the
        // entry is dropped so it can never re-fire later.
        if (tries++ < 30) {
          timer = window.setTimeout(attempt, 33);
          return;
        }
        dropPendingJump();
        return;
      }
      revealMessage(target.messageId, target.term);
      takePendingJump(); // landed — read-once semantics from here on
    };
    timer = window.setTimeout(attempt, 0);
    return () => window.clearTimeout(timer);
  }, [activeId, revealMessage]);

  // Fade-timeout hygiene: never leave a stray timer after unmount. The
  // reveal-retry timer is cleared too — a StrictMode-remounted instance must
  // not inherit its predecessor's doomed polling loop.
  useEffect(
    () => () => {
      if (termFadeTimeout.current) window.clearTimeout(termFadeTimeout.current);
      if (revealRetryTimer.current) window.clearTimeout(revealRetryTimer.current);
    },
    [],
  );

  const handleCancelPayment = useCallback(
    (message: ChatMessageData) => {
      cancelSettlement();
      const sid = activeId ?? ensureSession();
      useChatStore.getState().updateMessage(sid, message.id, (m) => ({
        ...m,
        status: "failed",
        paymentStep: "failed",
      }));
    },
    [activeId, ensureSession, cancelSettlement],
  );

  const handleConfirm = useCallback(
    async (message: ChatMessageData) => {
      if (!message.intent) return;
      if (!isConnected) {
        open();
        return;
      }
      const sid = ensureSession();

      useChatStore.getState().updateMessage(sid, message.id, (m) => ({ ...m, status: "signing", paymentStep: undefined }));

      const result = await settle(
        message.intent,
        (step, ctx) => {
          useChatStore.getState().updateMessage(sid, message.id, (m) => ({
            ...m,
            paymentStep: step,
            ...(ctx?.txHash != null ? { txHash: ctx.txHash } : {}),
            ...(step === "failed" ? { status: "failed" } : step === "settled" ? { status: "settled" } : {}),
          }));
        },
      );

      const isFailure = result.status === "failed" || result.status === "pending";

      useChatStore.getState().updateMessage(sid, message.id, (m) => ({
        ...m,
        status: isFailure
          ? "failed"
          : result.status === "settled"
            ? "settled"
            : "signing",
        txHash: "txHash" in result ? result.txHash : m.txHash,
        paymentId: result.id || m.paymentId,
        chainId: chainId ?? undefined,
        paymentStep: result.status === "settled" ? "settled" : isFailure ? "failed" : m.paymentStep,
      }));

      if (isFailure && result.status === "pending" && result.error) {
        useChatStore.getState().addMessage(
          sid,
          newMessage("assistant", result.error),
        );
      }

      if (result.status === "signing") {
        startPolling(result.id, message.id);
      } else if (result.status === "settled") {
        if (!confettiFiredRef.current.has(message.id)) {
          confettiFiredRef.current.add(message.id);
          firePaymentConfetti();
        }
      }
    },
    [isConnected, open, settle, chainId, ensureSession, startPolling],
  );

  const handleCancel = useCallback(
    (message: ChatMessageData) => {
      const sid = activeId ?? ensureSession();
      useChatStore.getState().updateMessage(sid, message.id, (m) => ({
        ...m,
        status: undefined,
        intent: undefined,
        paymentId: undefined,
        txHash: undefined,
        chainId: undefined,
      }));
    },
    [activeId, ensureSession],
  );

  const handleCopyMessage = useCallback((_message: ChatMessageData) => {}, []);

  // R3: copy a permalink for a message in the ACTIVE session (messages in
  // the render loop always belong to it). The clipboard write itself is
  // fire-and-forget; the button's check-icon swap is the visible feedback.
  const handleCopyMessageLink = useCallback(
    (message: ChatMessageData) => {
      const sid = activeId ?? ensureSession();
      try {
        // .catch (not try/catch): clipboard writeText rejects ASYNCHRONOUSLY
        // when denied — swallowing it keeps dev.log clean; the button's
        // check-icon swap is the visible feedback either way.
        navigator.clipboard?.writeText(buildMessagePermalink(sid, message.id)).catch(() => {});
      } catch {
        /* clipboard unavailable — the check icon still gives tap feedback */
      }
    },
    [activeId, ensureSession],
  );

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const handleEditMessage = useCallback((message: ChatMessageData) => {
    if (message.role !== "user") return;
    setEditingPrefill(message.content);
    setEditingMessageId(message.id);
    const sid = activeId ?? ensureSession();
    const msgs = useChatStore.getState().sessions[sid]?.messages ?? [];
    const idx = msgs.findIndex((m) => m.id === message.id);
    if (idx >= 0) {
      for (let i = msgs.length - 1; i > idx; i--) {
        useChatStore.getState().deleteMessage(sid, msgs[i].id);
      }
    }
  }, [activeId, ensureSession, setEditingPrefill, setEditingMessageId]);

  const handleDeleteMessage = useCallback((message: ChatMessageData) => {
    const sid = activeId ?? ensureSession();
    useChatStore.getState().deleteMessage(sid, message.id);
  }, [activeId, ensureSession]);

  const isEmpty = messages.length === 0 && !isThinking;

  // C22: regenerate is offered on the LAST assistant message only (and never
  // mid-run). Trace-beat messages are ephemeral components of a turn — the
  // last TEXT beat is the regenerable surface.
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant" && !messages[i].streaming) return messages[i].id;
    }
    return null;
  }, [messages]);

  const sortedSessions = useMemo(() => order.map((id) => sessions[id]).filter(Boolean), [order, sessions]);

  const commitRename = (id: string) => {
    const t = draftTitle.trim();
    if (t) renameChat(id, t);
    setEditingId(null);
  };

  if (!mounted) {
    return (
      <div className="relative flex h-full">
        <div className="relative flex h-full min-w-0 flex-1 flex-col">
          <div className="flex-1" />
          <div className="border-t border-border bg-transparent">
            <div className="mx-auto w-full max-w-2xl px-4 pt-[76px] pb-3 sm:px-6 sm:pt-[84px]">
              <div className="flex items-end gap-2">
                <div className="flex-1 h-[52px] rounded-2xl bg-surface-2/30 animate-pulse" />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full">
      <ChatSidebar
        sessions={sortedSessions}
        activeId={activeId}
        open={sidebarOpen}
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebarCollapsed}
        onClose={() => setSidebarOpen(false)}
        onSelect={(id) => {
          selectChat(id);
          setSidebarOpen(false);
        }}
        onNew={() => {
          newChat();
          setSidebarOpen(false);
        }}
        onDelete={(id) => {
          deleteChat(id);
          // R6: a deleted session's draft must not outlive it.
          dropDraft(id);
        }}
        onTogglePin={togglePin}
        editingId={editingId}
        draftTitle={draftTitle}
        onEditStart={(s) => {
          setEditingId(s.id);
          setDraftTitle(s.title);
        }}
        onDraftChange={setDraftTitle}
        onDraftCommit={commitRename}
        onDraftCancel={() => setEditingId(null)}
      />

      <div className="relative flex h-full min-w-0 flex-1 flex-col">
        <div className="absolute inset-0 pointer-events-none">
          {/* C10: just the stars on the theme's base surface — no colored wash. */}
          <ShootingStars className="absolute inset-0 w-full h-full" />
          <StarsBackground className="absolute inset-0 w-full h-full" />
        </div>

        {/* The in-page floating chats button is gone (N7): the Android
            top bar carries the CHATS control; desktop/tablet use the sidebar's
            own minimize/expand control. */}

        {/* Scroller wrapper: the floating scroll-to-bottom affordance is a
            sibling of the ABSOLUTE scroller so it stays pinned to the visible
            viewport (an absolute child of the scroller itself would ride the
            content and end up at the transcript's end). */}
        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
              isNearBottomRef.current = distance < 150;
              setShowScrollDown(distance > 260);
              setShowScrollUp(el.scrollTop > 16);
            }}
            className="absolute inset-0 overflow-y-auto overflow-x-hidden z-10"
          >
            <div className="mx-auto w-full max-w-2xl px-4 pt-[76px] pb-6 sm:px-6 sm:pt-[84px]">
            <AnimatePresence mode="wait">
              {isEmpty ? (
                <motion.div
                  key="welcome"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, scale: 0.98, filter: "blur(8px)" }}
                  transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                >
                  <WelcomeState
                    onSuggest={setEditingPrefill}
                    isConnected={isConnected}
                    contactLabel={firstContactLabel}
                    onConnectWallet={() => open()}
                  />
                </motion.div>
              ) : (
                <div className="flex flex-col gap-4">
                  <AnimatePresence initial={false}>
                    {messages.map((m) => (
                      // data-msg-id: the message-search jump target (palette
                      // revealMessage scrolls to this wrapper + flashes it).
                      <div key={m.id} data-msg-id={m.id} className="msg-row msg-jump-target rounded-2xl">
                        <ChatMessage
                          message={m}
                          onConfirmIntent={handleConfirm}
                          onCancelIntent={handleCancel}
                          onCancelPayment={handleCancelPayment}
                          onCopy={handleCopyMessage}
                          onCopyLink={handleCopyMessageLink}
                          onEdit={handleEditMessage}
                          onDelete={handleDeleteMessage}
                          onRegenerate={!isThinking && m.id === lastAssistantId ? handleRegenerate : undefined}
                          onAnswerConfirmation={handleAnswerConfirmation}
                        />
                      </div>
                    ))}
                  </AnimatePresence>
                </div>
              )}
            </AnimatePresence>
            <div ref={bottomRef} className="h-1" />
            </div>
          </div>

          {/* R7: transcript top fade — a soft gradient veil at the scroller's
              top edge; appears only when the reader is scrolled into history
              (content continues above the viewport). */}
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-x-0 top-0 z-20 h-10 bg-gradient-to-b from-background to-transparent transition-opacity duration-300",
              showScrollUp ? "opacity-100" : "opacity-0",
            )}
          />

          {/* Floating scroll-to-bottom — appears once the reader is more than
              a screen-third up the transcript; taps snap to the live end. */}
          <AnimatePresence>
            {showScrollDown && !isEmpty ? (
              <motion.button
                type="button"
                initial={{ opacity: 0, y: 10, x: "-50%" }}
                animate={{ opacity: 1, y: 0, x: "-50%" }}
                exit={{ opacity: 0, y: 10, x: "-50%" }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                onClick={() => scrollToBottom()}
                aria-label={t("chat.scrollToBottom")}
                className="absolute bottom-3 left-1/2 z-20 flex h-10 w-10 items-center justify-center rounded-full glass-tight text-muted shadow-lg transition-colors hover:text-foreground cursor-pointer"
              >
                <ArrowDown className="h-4.5 w-4.5" aria-hidden />
              </motion.button>
            ) : null}
          </AnimatePresence>
        </div>

        <div className="border-t border-border/30 backdrop-blur-sm">
          <div className="mx-auto w-full max-w-2xl px-4 py-3 sm:px-6">
            <div className="relative z-30 mb-1.5">
              <ModelPicker
                config={config}
                activeSessionId={activeId}
                modelOverride={activeSession?.modelOverride ?? null}
                onOverride={setChatModelOverride}
              />
            </div>
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <ChatInput onSend={handleSend} disabled={isThinking || isSettling} prefill={editingPrefill} onStop={handleStop} isGenerating={isThinking} sessionKey={activeId} />
              </div>
              <AiProviderButton />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface SidebarProps {
  sessions: Array<{ id: string; title: string; updatedAt: number; messages: ChatMessageData[]; pinned?: boolean }>;
  activeId: string | null;
  open: boolean;
  /** C24: minimized icon rail (desktop only, persisted). */
  collapsed: boolean;
  onToggleCollapse: () => void;
  onClose: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  /** R6: pin/unpin a session (persisted). */
  onTogglePin: (id: string) => void;
  editingId: string | null;
  draftTitle: string;
  onEditStart: (s: { id: string; title: string }) => void;
  onDraftChange: (v: string) => void;
  onDraftCommit: (id: string) => void;
  onDraftCancel: () => void;
}

/** R6: date buckets for the session list — Pinned first (its own group,
 *  ordered by last activity), then Today / Yesterday / Previous 7 days /
 *  Earlier. Within a bucket, sessions sort by last activity, newest first
 *  (standard chat-app recency; the raw `order` array is creation order). */
type SessionGroupKey = "pinned" | "today" | "yesterday" | "week" | "earlier";
/** Literal-key map so the dynamic group key stays type-checked against the
 *  i18n dictionary (a template-string `t()` call would escape the union). */
const GROUP_LABEL: Record<SessionGroupKey, TranslationKey> = {
  pinned: "chat.groupPinned",
  today: "chat.groupToday",
  yesterday: "chat.groupYesterday",
  week: "chat.groupWeek",
  earlier: "chat.groupEarlier",
};
function groupSessions(sessions: SidebarProps["sessions"]): Array<{
  key: SessionGroupKey;
  sessions: SidebarProps["sessions"];
}> {
  const byActivity = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const pinned = byActivity.filter((s) => s.pinned);
  const rest = byActivity.filter((s) => !s.pinned);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const DAY = 86_400_000;
  const startOfYesterday = startOfToday - DAY;
  const startOfWeek = startOfToday - 6 * DAY; // “Previous 7 days” includes today minus 7
  const today = rest.filter((s) => s.updatedAt >= startOfToday);
  const yesterday = rest.filter((s) => s.updatedAt >= startOfYesterday && s.updatedAt < startOfToday);
  const week = rest.filter((s) => s.updatedAt >= startOfWeek && s.updatedAt < startOfYesterday);
  const earlier = rest.filter((s) => s.updatedAt < startOfWeek);
  const groups = [
    { key: "pinned" as const, sessions: pinned },
    { key: "today" as const, sessions: today },
    { key: "yesterday" as const, sessions: yesterday },
    { key: "week" as const, sessions: week },
    { key: "earlier" as const, sessions: earlier },
  ];
  return groups.filter((g) => g.sessions.length > 0);
}

function ChatSidebar({
  sessions, activeId, open, collapsed, onToggleCollapse, onClose, onSelect, onNew, onDelete, onTogglePin, editingId, draftTitle,
  onEditStart, onDraftChange, onDraftCommit, onDraftCancel,
}: SidebarProps) {
  const { t } = useI18n();

  // ── Sidebar search-as-you-type (post-phase R2) ───────────────────────────
  // The palette searches the whole app, but the sidebar itself had no way to
  // narrow the session list — on mobile (drawer) there was no find-old-chat
  // affordance at all. Typing ≥2 chars filters sessions by TITLE or MESSAGE
  // content (same scan semantics as the palette's message search); message
  // hits carry a pre-split excerpt with a highlighted match span + a count
  // chip, and selecting one jumps to the newest matching message via the
  // existing jump bridge (scroll-into-view + flash).
  const [search, setSearch] = useState("");
  // R3 transcript export: which session row just copied its Markdown (drives
  // the transient check-icon swap; cleared after the standard 1.6s).
  const [copiedTranscriptId, setCopiedTranscriptId] = useState<string | null>(null);
  // R4 session permalink: which session row just copied its share link.
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);

  // R4 copy-link: a session-level permalink `/?chat=<id>#msg=<first msg>` —
  // reuses the message permalink bridge so the link lands on the session with
  // the first message revealed (scroll + flash). Falls back to the bare
  // session link when the conversation has no messages yet.
  const copySessionLink = useCallback(
    (s: { id: string; messages: ChatMessageData[] }) => {
      const first = s.messages.find((m) => m.content?.trim());
      const link = first
        ? buildMessagePermalink(s.id, first.id)
        : `${typeof window === "undefined" ? "/" : `${window.location.origin}/`}?chat=${encodeURIComponent(s.id)}`;
      try {
        navigator.clipboard?.writeText(link).catch(() => {});
      } catch {
        /* clipboard unavailable — feedback icon still swaps */
      }
      setCopiedLinkId(s.id);
      window.setTimeout(() => setCopiedLinkId((cur) => (cur === s.id ? null : cur)), 1600);
    },
    [],
  );

  // Copy a whole session as Markdown: title heading + You/Assistant turns.
  // Trace-only beats (no narration) are skipped — a wall of tool rows would
  // bury the conversation. Reasoning is deliberately excluded too: it is
  // scaffolding, not part of the transcript the user would share.
  const copyTranscript = useCallback(
    (s: { id: string; title: string; messages: ChatMessageData[] }) => {
      const lines: string[] = [`# ${s.title || t("chat.newChat")}`, ""];
      for (const m of s.messages) {
        if (!m.content?.trim()) continue;
        lines.push(m.role === "user" ? "**You:**" : "**Assistant:**", "", m.content.trim(), "");
      }
      try {
        // .catch (not try/catch): writeText REJECTS asynchronously when the
        // clipboard is denied (permissions, unfocused document) — an unhandled
        // rejection would surface in dev.log; the feedback icon swaps regardless.
        navigator.clipboard?.writeText(lines.join("\n").trim() + "\n").catch(() => {});
      } catch {
        /* clipboard unavailable — feedback icon still swaps */
      }
      setCopiedTranscriptId(s.id);
      window.setTimeout(() => setCopiedTranscriptId((cur) => (cur === s.id ? null : cur)), 1600);
    },
    [t],
  );

  // R5 download export: the SAME Markdown payload as copyTranscript, saved as
  // a .md file instead of the clipboard (R4 open item (c)). Filename slugs
  // from the title (lowercased, non-alphanumerics folded to dashes, capped
  // at 60 chars); "chat" is the fallback stem.
  const [downloadedId, setDownloadedId] = useState<string | null>(null);
  const downloadTranscript = useCallback(
    (s: { id: string; title: string; messages: ChatMessageData[] }) => {
      const lines: string[] = [`# ${s.title || t("chat.newChat")}`, ""];
      for (const m of s.messages) {
        if (!m.content?.trim()) continue;
        lines.push(m.role === "user" ? "**You:**" : "**Assistant:**", "", m.content.trim(), "");
      }
      const md = lines.join("\n").trim() + "\n";
      const stem = (s.title || "chat")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
      try {
        const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${stem || "chat"}.md`;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch {
        /* download unavailable — the feedback icon still swaps */
      }
      setDownloadedId(s.id);
      window.setTimeout(() => setDownloadedId((cur) => (cur === s.id ? null : cur)), 1600);
    },
    [t],
  );
  // Mobile drawer close → clear the filter. Guard on the true→false EDGE:
  // the desktop sidebar renders with open=false permanently (it is
  // translate-based, not conditional), so a plain [open] effect would wipe
  // the desktop filter on every render.
  const prevOpenRef = useRef(open);
  useEffect(() => {
    if (prevOpenRef.current && !open) setSearch("");
    prevOpenRef.current = open;
  }, [open]);

  const searchQuery = search.trim().toLowerCase();
  const searchActive = searchQuery.length >= 2;

  interface SidebarHit {
    session: SidebarProps["sessions"][number];
    titleMatch: boolean;
    matchCount: number;
    /** Newest matching message (pre-split excerpt for <mark> highlighting). */
    hit: {
      messageId: string;
      role: "user" | "assistant";
      /** R5 scope extension: where the matched text lives when not plain
       * content — rendered as a badge on the result row. */
      source?: "reasoning" | "trace";
      excerpt: { before: string; match: string; after: string };
    } | null;
  }
  const searchResults = useMemo<SidebarHit[] | null>(() => {
    if (!searchActive) return null;
    const out: SidebarHit[] = [];
    for (const s of sessions) {
      const titleMatch = (s.title || "").toLowerCase().includes(searchQuery);
      let matchCount = 0;
      let first: SidebarHit["hit"] = null;
      // Newest message first — people search for things they just said.
      for (let mi = s.messages.length - 1; mi >= 0; mi--) {
        const msg = s.messages[mi];
        // R5 scope extension: content + reasoning + trace segments.
        let matched: { flat: string; idx: number; source: "reasoning" | "trace" | undefined } | null = null;
        for (const seg of messageSearchTexts(msg)) {
          // Newlines flattened BEFORE matching so the excerpt renders one line
          // and the match index is valid in the rendered string (palette parity).
          const flat = seg.text.replace(/\s+/g, " ");
          const idx = flat.toLowerCase().indexOf(searchQuery);
          if (idx >= 0) {
            matched = { flat, idx, source: seg.source === "content" ? undefined : seg.source };
            break;
          }
        }
        if (!matched) continue;
        const { flat, idx, source } = matched;
        matchCount++;
        if (!first) {
          const start = Math.max(0, idx - 46);
          const end = Math.min(flat.length, idx + searchQuery.length + 46);
          first = {
            messageId: msg.id,
            role: msg.role === "user" ? "user" : "assistant",
            source,
            excerpt: {
              before: (start > 0 ? "…" : "") + flat.slice(start, idx),
              match: flat.slice(idx, idx + searchQuery.length),
              after: flat.slice(idx + searchQuery.length, end) + (end < flat.length ? "…" : ""),
            },
          };
        }
      }
      if (titleMatch || matchCount > 0) out.push({ session: s, titleMatch, matchCount, hit: first });
    }
    return out;
  }, [sessions, searchQuery, searchActive]);

  return (
    <>
      <AnimatePresence>
        {open ? (
          <motion.button
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-30 bg-foreground/25 backdrop-blur-sm sm:hidden"
            aria-label={t("chat.closeSidebar")}
          />
        ) : null}
      </AnimatePresence>

      {/* ── C24: the icon rail (desktop, collapsed). Mobile never collapses —
          the drawer is the mobile surface. ── */}
      <aside
        aria-hidden={!collapsed}
        className={cn(
          "absolute left-0 top-0 z-40 hidden h-full flex-col border-r border-border bg-surface/75 backdrop-blur-2xl sm:flex",
          "bg-gradient-to-b from-primary/[0.06] via-transparent to-transparent transition-all duration-300",
          collapsed ? "w-14 translate-x-0" : "w-0 -translate-x-full overflow-hidden",
        )}
      >
        <div className="flex flex-col items-center gap-1.5 px-2 pt-[84px]">
          <button
            type="button"
            onClick={onToggleCollapse}
            title={t("chat.expandSidebar")}
            aria-label={t("chat.expandSidebar")}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-muted-2 transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <PanelLeftOpen className="h-4.5 w-4.5" />
          </button>
          <button
            type="button"
            onClick={onNew}
            title={t("chat.newChat")}
            aria-label={t("chat.newChat")}
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-primary/30 bg-primary/10 text-primary transition-colors hover:bg-primary/20"
          >
            <Plus className="h-4.5 w-4.5" />
          </button>
        </div>
        <div className="acp-scroll mt-2 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-4">
          {/* R6: pinned sessions first in the collapsed rail too — a tiny
              primary dot under the initial marks them without any label. */}
          {(() => {
            const rail = [...sessions].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt);
            return rail.slice(0, 14).map((s) => {
            const isActive = s.id === activeId;
            const initial = (s.title || "?").trim().charAt(0).toUpperCase() || "?";
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => onSelect(s.id)}
                title={s.title || t("chat.newChat")}
                aria-label={s.title || t("chat.newChat")}
                aria-current={isActive ? "true" : undefined}
                className={cn(
                  "relative mx-auto my-1 flex h-9 w-9 items-center justify-center rounded-xl text-[13px] font-semibold transition-colors",
                  isActive
                    ? "bg-primary/15 text-primary ring-1 ring-primary/30"
                    : "text-muted-2 hover:bg-foreground/8 hover:text-foreground",
                  s.pinned && !isActive && "text-foreground/80",
                )}
              >
                {initial}
                {s.pinned ? (
                  <span
                    aria-hidden
                    className={cn(
                      "absolute bottom-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full",
                      isActive ? "bg-primary" : "bg-primary/60",
                    )}
                  />
                ) : null}
                {isActive ? (
                  <span
                    aria-hidden
                    className="absolute -left-1.5 top-1/2 h-4 w-1 -translate-y-1/2 rounded-full bg-primary"
                  />
                ) : null}
              </button>
            );
            });
          })()}
        </div>
      </aside>

      <aside
        className={cn(
          "absolute left-0 top-0 z-40 flex h-full w-72 flex-col border-r border-border bg-surface/75 backdrop-blur-2xl pt-2 transition-transform duration-300 sm:relative sm:translate-x-0 bg-gradient-to-b from-primary/[0.06] via-transparent to-transparent",
          collapsed ? "sm:hidden" : "",
          open ? "translate-x-0" : "-translate-x-full sm:translate-x-0",
        )}
      >
        <div className="flex items-center justify-between px-4 pt-[76px] pb-4 sm:pt-[84px]">
          <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <MessageSquare className="h-4 w-4 text-primary" /> {t("chat.chats")}
          </span>
          <div className="flex items-center gap-1">
            {/* C24: collapse to the icon rail (desktop only) */}
            <button
              type="button"
              onClick={onToggleCollapse}
              title={t("chat.collapseSidebar")}
              aria-label={t("chat.collapseSidebar")}
              className="hidden h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-foreground/10 hover:text-foreground sm:flex"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="hit-slop flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-foreground/10 hover:text-foreground sm:hidden"
              aria-label={t("chat.close")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="px-3">
          <button
            type="button"
            onClick={onNew}
            className="flex w-full items-center gap-2 rounded-xl border border-border bg-foreground/5 px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-foreground/10"
          >
            <Plus className="h-4 w-4" /> {t("chat.newChat")}
          </button>
        </div>

        {/* Search-as-you-type: filters by title AND message content; a
            message hit jumps to that message (scroll + flash) on select. */}
        <div className="mt-2 px-3">
          <div
            className={cn(
              "flex h-11 items-center gap-2 rounded-xl border border-border bg-foreground/5 px-3 transition-all duration-200",
              "focus-within:border-primary/40 focus-within:bg-foreground/[0.07] focus-within:shadow-[0_0_0_3px_rgba(34,211,238,0.2)]",
            )}
          >
            <Search className="h-4 w-4 shrink-0 text-muted-2" aria-hidden />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  // First Escape clears the filter; a second one closes the
                  // mobile drawer (desktop keeps its sidebar — no-op).
                  if (search) setSearch("");
                  else onClose();
                }
              }}
              placeholder={t("chat.searchChats")}
              aria-label={t("chat.searchChats")}
              aria-controls="chat-sidebar-list"
              autoComplete="off"
              spellCheck={false}
              className="w-full min-w-0 bg-transparent text-[13px] text-foreground placeholder:text-muted-2 focus:outline-none"
            />
            {search ? (
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                }}
                aria-label={t("chat.searchClear")}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-2 transition-colors hover:bg-foreground/10 hover:text-foreground active:scale-95"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>

        <div id="chat-sidebar-list" className="mt-2 flex-1 overflow-y-auto px-2 pb-4">
          {searchActive ? (
            searchResults && searchResults.length === 0 ? (
              <p className="px-3 py-8 text-center text-[12.5px] text-muted-2">{t("chat.searchNoResults")}</p>
            ) : (
              searchResults!.map((r) => {
                const s = r.session;
                const isActive = s.id === activeId;
                return (
                  <div
                    key={s.id}
                    className={cn(
                      "group flex min-h-11 items-center gap-2 rounded-xl px-2.5 py-2 text-sm transition-colors",
                      isActive ? "bg-foreground/10 text-foreground" : "text-muted hover:bg-foreground/5 hover:text-foreground",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(s.id);
                        // Message hit → jump bridge (scroll-into-view + flash,
                        // same reveal as the palette's message search).
                        if (r.hit) jumpToMessage({ sessionId: s.id, messageId: r.hit.messageId, term: search.trim() });
                      }}
                      className="flex min-h-11 min-w-0 flex-1 flex-col justify-center text-left"
                      aria-label={r.hit ? t("palette.jumpToMessage", { chat: s.title || t("chat.newChat") }) : s.title || t("chat.newChat")}
                    >
                      {editingId === s.id ? (
                        <input
                          autoFocus
                          value={draftTitle}
                          placeholder={t("chat.newChat")}
                          onChange={(e) => onDraftChange(e.target.value)}
                          onBlur={() => onDraftCommit(s.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") onDraftCommit(s.id);
                            if (e.key === "Escape") onDraftCancel();
                          }}
                          className="w-full rounded bg-surface-2/50 px-1.5 py-0.5 text-xs text-foreground focus:outline-none"
                        />
                      ) : (
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="min-w-0 flex-1 truncate text-[13px] leading-snug font-medium">
                            {s.title || t("chat.newChat")}
                          </span>
                          {r.matchCount > 0 ? (
                            <span
                              className="shrink-0 rounded bg-foreground/8 px-1.5 py-px text-[9.5px] font-semibold tabular-nums text-muted-2"
                              aria-label={t("chat.searchMatches", { count: r.matchCount })}
                            >
                              {r.matchCount}
                            </span>
                          ) : null}
                        </span>
                      )}
                      {r.hit && editingId !== s.id ? (
                        <span className="mt-0.5 flex items-baseline gap-1 truncate text-[11px]" aria-hidden>
                          <span
                            className={cn(
                              "shrink-0 rounded px-1 py-px text-[8.5px] font-bold uppercase tracking-wide",
                              r.hit.role === "user" ? "bg-primary/12 text-primary/90" : "bg-foreground/8 text-muted-2",
                            )}
                          >
                            {r.hit.role === "user" ? t("palette.msgRoleUser") : t("palette.msgRoleAgent")}
                          </span>
                          {r.hit.source ? (
                            <span
                              className={cn(
                                "shrink-0 rounded px-1 py-px text-[8.5px] font-bold uppercase tracking-wide ring-1",
                                r.hit.source === "reasoning"
                                  ? "bg-warning/10 text-warning ring-warning/25"
                                  : "bg-success/10 text-success ring-success/25",
                              )}
                            >
                              {r.hit.source === "reasoning" ? t("palette.msgSourceReasoning") : t("palette.msgSourceTrace")}
                            </span>
                          ) : null}
                          <span className="truncate font-mono text-[10.5px] text-muted/90">{r.hit.excerpt.before}</span>
                          <mark className="shrink-0 rounded-[3px] bg-primary/20 px-0.5 font-mono text-[10.5px] font-semibold text-primary">
                            {r.hit.excerpt.match}
                          </mark>
                          <span className="truncate font-mono text-[10.5px] text-muted/90">{r.hit.excerpt.after}</span>
                        </span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      onClick={() => copySessionLink(s)}
                      className="hit-slop flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 sm:hidden sm:group-hover:flex"
                      aria-label={t("chat.copySessionLink")}
                      title={t("chat.copySessionLink")}
                    >
                      {copiedLinkId === s.id ? (
                        <Check className="h-3.5 w-3.5 text-success" />
                      ) : (
                        <Link2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => copyTranscript(s)}
                      className="hit-slop flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 sm:hidden sm:group-hover:flex"
                      aria-label={t("chat.copyTranscript")}
                      title={t("chat.copyTranscript")}
                    >
                      {copiedTranscriptId === s.id ? (
                        <Check className="h-3.5 w-3.5 text-success" />
                      ) : (
                        <FileText className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => downloadTranscript(s)}
                      className="hit-slop flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 sm:hidden sm:group-hover:flex"
                      aria-label={t("chat.downloadTranscript")}
                      title={t("chat.downloadTranscript")}
                    >
                      {downloadedId === s.id ? (
                        <Check className="h-3.5 w-3.5 text-success" />
                      ) : (
                        <Download className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => onEditStart(s)}
                      className="hit-slop flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 sm:hidden sm:group-hover:flex"
                      aria-label={t("chat.renameChat")}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(s.id)}
                      className="hit-slop flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-danger/15 hover:text-danger focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-danger/60 sm:hidden sm:group-hover:flex"
                      aria-label={t("chat.deleteChat")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })
            )
          ) : (
            /* R6: date-grouped session list — Pinned / Today / Yesterday /
               Previous 7 days / Earlier. Within a group, most recent
               activity first. */
            groupSessions(sessions).map((group) => (
              <section key={group.key} aria-label={t(GROUP_LABEL[group.key])}>
                <div className="flex items-baseline gap-2 px-3 pt-3 pb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-3">
                    {t(GROUP_LABEL[group.key])}
                  </span>
                  {group.key === "pinned" ? (
                    <Pin aria-hidden className="h-2.5 w-2.5 text-primary/70" />
                  ) : null}
                  <span className="text-[10px] font-medium tabular-nums text-muted-3/80" aria-hidden>
                    {group.sessions.length}
                  </span>
                  <span aria-hidden className="h-px flex-1 bg-border/40" />
                </div>
                {group.sessions.map((s) => {
                  const isActive = s.id === activeId;
                  return (
                    <div
                      key={s.id}
                      className={cn(
                        /* R6: flex-wrap + an action-group container — the six
                           row actions (pin + link + copy + download + rename +
                           delete) can never share one 288px line with a
                           readable title. They wrap as a UNIT under the title
                           (mobile always; desktop on hover), and the title's
                           min-width floor is what forces the wrap. Un-hovered
                           desktop rows still render one full-width title line
                           (the group is empty then). */
                        "group relative flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-xl px-2.5 py-2 text-sm transition-colors",
                        isActive ? "bg-foreground/10 text-foreground" : "text-muted hover:bg-foreground/5 hover:text-foreground",
                        s.pinned && !isActive && "bg-primary/[0.05] hover:bg-primary/[0.09]",
                      )}
                    >
                      {/* Active-session indicator — a 3px primary bar hugging the
                          left edge; muted rows have none, the active row glows. */}
                      {isActive ? (
                        <span
                          aria-hidden
                          className="pointer-events-none absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-gradient-to-b from-primary to-primary/40"
                        />
                      ) : null}
                      <button
                        type="button"
                        onClick={() => onSelect(s.id)}
                        className="min-w-[110px] flex-1 text-left"
                        title={s.title || t("chat.newChat")}
                      >
                        {editingId === s.id ? (
                          <input
                            autoFocus
                            value={draftTitle}
                            placeholder={t("chat.newChat")}
                            onChange={(e) => onDraftChange(e.target.value)}
                            onBlur={() => onDraftCommit(s.id)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") onDraftCommit(s.id);
                              if (e.key === "Escape") onDraftCancel();
                            }}
                            className="w-full rounded bg-surface-2/50 px-1.5 py-0.5 text-xs text-foreground focus:outline-none"
                          />
                        ) : (
                          <span className="flex min-w-0 items-center gap-1.5">
                            {/* Pinned rows keep a visible pin glyph next to the
                                title — discoverable unpin without hover. */}
                            {s.pinned ? (
                              <Pin
                                aria-hidden
                                className="h-3 w-3 shrink-0 text-primary/80"
                              />
                            ) : null}
                            <span className="line-clamp-2 break-words text-[13px] leading-snug">
                              {s.title || t("chat.newChat")}
                            </span>
                          </span>
                        )}
                      </button>
                      {/* R6: the action group — wraps under the title as one
                          unit (see the row's flex-wrap note above). */}
                      <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => onTogglePin(s.id)}
                        className={cn(
                          "hit-slop flex h-8 w-8 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60",
                          s.pinned
                            ? "text-primary/80 hover:bg-primary/10 hover:text-primary sm:flex"
                            : "text-muted hover:bg-foreground/10 hover:text-foreground sm:hidden sm:group-hover:flex",
                        )}
                        aria-label={s.pinned ? t("chat.unpinChat") : t("chat.pinChat")}
                        title={s.pinned ? t("chat.unpinChat") : t("chat.pinChat")}
                      >
                        {s.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => copySessionLink(s)}
                        className="hit-slop flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 sm:hidden sm:group-hover:flex"
                        aria-label={t("chat.copySessionLink")}
                        title={t("chat.copySessionLink")}
                      >
                        {copiedLinkId === s.id ? (
                          <Check className="h-3.5 w-3.5 text-success" />
                        ) : (
                          <Link2 className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => copyTranscript(s)}
                        className="hit-slop flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 sm:hidden sm:group-hover:flex"
                        aria-label={t("chat.copyTranscript")}
                        title={t("chat.copyTranscript")}
                      >
                        {copiedTranscriptId === s.id ? (
                          <Check className="h-3.5 w-3.5 text-success" />
                        ) : (
                          <FileText className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => downloadTranscript(s)}
                        className="hit-slop flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 sm:hidden sm:group-hover:flex"
                        aria-label={t("chat.downloadTranscript")}
                        title={t("chat.downloadTranscript")}
                      >
                        {downloadedId === s.id ? (
                          <Check className="h-3.5 w-3.5 text-success" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => onEditStart(s)}
                        className="hit-slop flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 sm:hidden sm:group-hover:flex"
                        aria-label={t("chat.renameChat")}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete(s.id)}
                        className="hit-slop flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-danger/15 hover:text-danger focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-danger/60 sm:hidden sm:group-hover:flex"
                        aria-label={t("chat.deleteChat")}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                      </div>
                    </div>
                  );
                })}
              </section>
            ))
          )}
        </div>
      </aside>
    </>
  );
}

const WelcomeState = memo(function WelcomeState({
  onSuggest,
  isConnected,
  contactLabel,
  onConnectWallet,
}: {
  onSuggest: (text: string) => void;
  isConnected: boolean;
  /** Label of the favorite / most-recently-used contact, when one exists. */
  contactLabel?: string;
  /** Opens the AppKit wallet modal (the connect chip's action). */
  onConnectWallet: () => void;
}) {
  const { t } = useI18n();
  // R10: state-aware composition. The first chip follows the wallet: not
  // connected → connect (an ACTION, not a prefill); connected + a saved
  // contact → pay that person by name; connected + no contacts → invite to
  // save a payee. The other two chips stay constant (oracle freshness +
  // protocol explainer are state-independent on-ramps).
  const suggestions: Array<{ icon: React.ReactNode; text: string; action?: () => void }> = [
    !isConnected
      ? {
          icon: <Wallet className="h-3.5 w-3.5 text-primary" />,
          text: t("chat.suggestConnect"),
          action: onConnectWallet,
        }
      : contactLabel
        ? {
            icon: <Send className="h-3.5 w-3.5 text-primary" />,
            text: t("chat.suggestPayContact", { name: contactLabel }),
          }
        : {
            icon: <UserPlus className="h-3.5 w-3.5 text-primary" />,
            text: t("chat.suggestAddContact"),
          },
    {
      icon: <Radar className="h-3.5 w-3.5 text-primary" />,
      text: t("chat.suggestStatus"),
    },
    {
      icon: <BookOpen className="h-3.5 w-3.5 text-primary" />,
      text: t("chat.suggestExplain"),
    },
  ];
  return (
    <div className="flex flex-col items-center justify-center gap-5 py-16 text-center sm:py-24">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        className="space-y-2"
      >
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          <Wordmark className="text-2xl sm:text-3xl" />
        </h1>
        <p className="max-w-sm text-[15px] leading-relaxed text-muted">
          {t("chat.welcomeDesc")}
        </p>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        className="glass-tight flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs text-muted"
      >
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        {t("app.poweredBy")}
      </motion.div>

      {/* Quick-start suggestion chips — click fills the composer */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.45, duration: 0.5 }}
        className="flex max-w-md flex-col items-stretch gap-2"
        aria-label={t("chat.suggestLabel")}
      >
        {suggestions.map((s, i) => (
          <motion.button
            key={s.text}
            type="button"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 + i * 0.08, duration: 0.4, ease: "easeOut" }}
            whileHover={{ x: 3 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => (s.action ? s.action() : onSuggest(s.text))}
            className="glass-item group flex cursor-pointer items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-left text-[13px] leading-snug text-muted transition-colors hover:border-primary/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-primary/20 transition-colors group-hover:bg-primary/15">
              {s.icon}
            </span>
            <span className="min-w-0 flex-1 wrap-anywhere">{s.text}</span>
            {/* Action chips (connect) hint at their side effect; prefill
                chips hint at editing — the affordance tells the truth. */}
            {s.action ? (
              <span className="ml-auto shrink-0 text-[10px] font-medium uppercase tracking-wide text-primary/70 opacity-0 transition-opacity group-hover:opacity-100">
                <Wallet className="h-3 w-3" />
              </span>
            ) : (
              <Pencil className="ml-auto h-3 w-3 shrink-0 text-muted-3 opacity-0 transition-opacity group-hover:opacity-100" />
            )}
          </motion.button>
        ))}
      </motion.div>

      {/* C23: quiet affordance for the "/" context-attachment menu + the `?`
          shortcuts overlay — two discovery chips, one row. The `?` chip is
          clickable (touch users have no ? key in reach). */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.8, duration: 0.5 }}
        className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-[11.5px] text-muted-3"
      >
        <p className="flex items-center gap-1.5">
          <kbd className="rounded-md border border-border/70 bg-surface-2/50 px-1.5 py-px font-mono text-[10px] text-muted-2">/</kbd>
          {t("chat.slash.welcomeHint")}
        </p>
        <button
          type="button"
          onClick={openShortcutsHelp}
          className="flex cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:text-muted-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
          aria-label={t("shortcuts.hint")}
          title={t("shortcuts.hint")}
        >
          <kbd className="rounded-md border border-border/70 bg-surface-2/50 px-1.5 py-px font-mono text-[10px] text-muted-2">?</kbd>
          {t("shortcuts.hint")}
        </button>
      </motion.div>
    </div>
  );
});
