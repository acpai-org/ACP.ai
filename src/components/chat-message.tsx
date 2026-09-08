"use client";

import { memo, useState, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useAccount } from "wagmi";
import { Bot, User, Copy, Pencil, Trash2, Check, ChevronRight, Brain, RefreshCw, AlertTriangle, Link2 } from "lucide-react";
import type { ChatMessageData } from "@/lib/types";
import { filterSlashCommands, type SlashCommandId } from "@/lib/chat/slash-commands";
import type { TranslationKey } from "@/lib/i18n/types";
import { IntentCard } from "@/components/intent-card";
import { StatusPill } from "@/components/status-pill";
import { AgentTrace } from "@/components/agent-trace";
import { AgentConfirmation } from "@/components/agent-confirmation";
import { RichText, UserText } from "@/components/rich-text";
import { useI18n } from "@/lib/i18n";
import { useFormatters } from "@/lib/use-formatters";
import { useAiProvider } from "@/lib/ai/provider-store";
import { cn } from "@/lib/utils";

interface ChatMessageProps {
  message: ChatMessageData;
  onConfirmIntent?: (message: ChatMessageData) => void;
  onCancelIntent?: (message: ChatMessageData) => void;
  onCancelPayment?: (message: ChatMessageData) => void;
  onCopy?: (message: ChatMessageData) => void;
  /** R3: copy a permalink to this message (chat + message deep link). */
  onCopyLink?: (message: ChatMessageData) => void;
  onEdit?: (message: ChatMessageData) => void;
  onDelete?: (message: ChatMessageData) => void;
  /** C22: re-run the turn that produced this assistant message (offered on
   * the LAST assistant message only — parent decides). */
  onRegenerate?: (message: ChatMessageData) => void;
  onAnswerConfirmation?: (message: ChatMessageData, callId: string, approved: boolean, rememberChoice: boolean) => void;
}

const spring = { type: "spring" as const, stiffness: 380, damping: 30 };

/** N22: no-change window after which a still-`streaming` message shows an
 * honest stalled indicator instead of an eternally blinking cursor. The
 * timer resets on EVERY content/reasoning/trace/confirmation change — real
 * progress keeps the hint hidden. */
const STALL_HINT_MS = 15_000;

/** Trace statuses that mean an operation is ACTIVELY in flight (P3): a wallet
 * signature wait, a broadcast awaiting its receipt, an attestation wait, a
 * pending confirmation card, or plain execution. While ANY step is in one of
 * these states the stream is not stalled — it is working, possibly for
 * minutes (transactions legitimately take that long). */
const IN_FLIGHT_STATUSES = new Set([
  "running",
  "awaiting_signature",
  "broadcast",
  "confirming",
  "awaiting_confirmation",
  "waiting_attestation",
  "requested",
  "signed",
]);

function StalledHint({
  live,
  signature,
  inFlight,
}: {
  live: boolean;
  signature: string;
  inFlight: boolean;
}) {
  const { t } = useI18n();
  const [stalled, setStalled] = useState(false);

  // P3: the timer restarts on every progress beat (signature change) and is
  // SUSPENDED while any tool step is actively in flight — long-running
  // operations (a transaction taking minutes to confirm, an attestation
  // wait, a wallet prompt waiting for the user) are honest work, not a
  // stalled stream. When the operation resolves the detector re-arms
  // automatically (the effect re-runs on inFlight/signature changes).
  useEffect(() => {
    if (!live || inFlight) return;
    const startedAt = Date.now();
    const iv = setInterval(() => {
      setStalled(Date.now() - startedAt >= STALL_HINT_MS);
    }, 1500);
    return () => {
      clearInterval(iv);
      setStalled(false);
    };
  }, [live, inFlight, signature]);

  if (!live || inFlight || !stalled) return null;

  return (
    <div
      role="status"
      className="flex items-center gap-1.5 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-[12px] text-warning"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{t("chat.streamStalled")}</span>
    </div>
  );
}

function MessageActions({
  message,
  isUser,
  onCopy,
  onCopyLink,
  onEdit,
  onDelete,
  onRegenerate,
}: {
  message: ChatMessageData;
  isUser: boolean;
  onCopy?: (m: ChatMessageData) => void;
  onCopyLink?: (m: ChatMessageData) => void;
  onEdit?: (m: ChatMessageData) => void;
  onDelete?: (m: ChatMessageData) => void;
  onRegenerate?: (m: ChatMessageData) => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (!message.content) return;
    // .catch: writeText rejects asynchronously when the clipboard is denied;
    // swallowing it keeps dev.log clean (the check icon swaps regardless).
    navigator.clipboard?.writeText(message.content).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    onCopy?.(message);
  }, [message, onCopy]);

  const handleCopyLink = useCallback(() => {
    onCopyLink?.(message);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 1500);
  }, [message, onCopyLink]);

  if (!onCopy && !onCopyLink && !onEdit && !onDelete && !onRegenerate) return null;

  return (
    <div
      className={cn(
        "msg-actions flex items-center gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100",
        isUser ? "justify-end" : "justify-start pl-[42px]",
      )}
    >
      {onCopyLink ? (
        <button
          type="button"
          onClick={handleCopyLink}
          className="msg-action-btn flex h-6 w-6 items-center justify-center rounded-md text-muted-2 transition-colors hover:bg-surface-2/60 hover:text-foreground"
          title={t("chat.copyLink")}
          aria-label={t("chat.copyLink")}
        >
          {linkCopied ? <Check className="h-3 w-3 text-success" /> : <Link2 className="h-3 w-3" />}
        </button>
      ) : null}
      {onCopy ? (
        <button
          type="button"
          onClick={handleCopy}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-2 transition-colors hover:bg-surface-2/60 hover:text-foreground"
          title={t("chat.copyMessage")}
          aria-label={t("chat.copyMessage")}
        >
          {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
        </button>
      ) : null}
      {isUser && onEdit ? (
        <button
          type="button"
          onClick={() => onEdit(message)}
          className="msg-action-btn flex h-6 w-6 items-center justify-center rounded-md text-muted-2 transition-colors hover:bg-surface-2/60 hover:text-foreground"
          title={t("chat.editMessage")}
          aria-label={t("chat.editMessage")}
        >
          <Pencil className="h-3 w-3" />
        </button>
      ) : null}
      {!isUser && onRegenerate ? (
        <button
          type="button"
          onClick={() => onRegenerate(message)}
          className="msg-action-btn flex h-6 w-6 items-center justify-center rounded-md text-muted-2 transition-colors hover:bg-surface-2/60 hover:text-primary"
          title={t("chat.regenerate")}
          aria-label={t("chat.regenerate")}
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      ) : null}
      {onDelete ? (
        <button
          type="button"
          onClick={() => onDelete(message)}
          className="msg-action-btn flex h-6 w-6 items-center justify-center rounded-md text-muted-2 transition-colors hover:bg-danger/10 hover:text-danger"
          title={t("chat.deleteMessage")}
          aria-label={t("chat.deleteMessage")}
        >
          <Trash2 className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}

function ReasoningBlock({ reasoning, streaming }: { reasoning: string; streaming?: boolean }) {
  const { t } = useI18n();
  // Open while streaming (P9: visible reasoning), collapsed once complete —
  // INCLUDING historical messages loaded later (they mount non-streaming).
  const [open, setOpen] = useState(Boolean(streaming));
  const [prevStreaming, setPrevStreaming] = useState(Boolean(streaming));

  // P9: auto-collapse the moment thinking finishes — the block streams
  // visibly while the model is reasoning (open by default) and collapses to
  // its compact summary row on completion so it never fills the screen. The
  // user can re-expand to read the full content afterwards. (React's
  // documented adjust-state-during-render pattern for prop transitions —
  // no effect, no cascading re-render.)
  if (prevStreaming !== Boolean(streaming)) {
    setPrevStreaming(Boolean(streaming));
    if (!streaming) setOpen(false);
  }

  if (!reasoning.trim()) return null;

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[12px] font-medium text-muted hover:text-foreground transition-colors"
      >
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.15 }}>
          <ChevronRight className="h-3.5 w-3.5" />
        </motion.span>
        <Brain className="h-3.5 w-3.5 text-primary/80" />
        <span>{streaming ? t("chat.thinking") : t("chat.thoughtProcess")}</span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-1.5 rounded-2xl rounded-bl-md border-l-2 border-primary/40 bg-surface-2/20 px-3.5 py-2.5 text-[13px] leading-relaxed text-muted whitespace-pre-wrap wrap-anywhere">
              {reasoning}
              {streaming ? (
                <motion.span
                  className="ml-0.5 inline-block h-3.5 w-1.5 align-middle bg-primary/60"
                  animate={{ opacity: [1, 0.25, 1] }}
                  transition={{ duration: 1.05, repeat: Infinity, ease: "easeInOut" }}
                />
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export const ChatMessage = memo(function ChatMessage({
  message,
  onConfirmIntent,
  onCancelIntent,
  onCancelPayment,
  onCopy,
  onCopyLink,
  onEdit,
  onDelete,
  onRegenerate,
  onAnswerConfirmation,
}: ChatMessageProps) {
  const { address } = useAccount();
  const { t } = useI18n();
  const { timeAgo, formatTime } = useFormatters();
  // N26: the thinking toggle gates reasoning-block rendering (the model may
  // still stream reasoning; when hidden it simply never displays).
  const showThinking = useAiProvider((s) => s.config.showThinking);
  const isUser = message.role === "user";

  if (isUser) {
    const chips = (message.contextAttachments ?? []) as SlashCommandId[];
    return (
      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={spring}
        className="group flex flex-col items-end gap-0.5"
      >
        <div className="flex max-w-[85%] flex-col items-end gap-1">
          <div className="flex items-end gap-2">
            <div className="flex max-w-full min-w-0 flex-col items-end gap-1.5">
              {chips.length > 0 ? (
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  {chips.map((id) => {
                    const def = filterSlashCommands("").find((c) => c.id === id);
                    const Icon = def?.icon;
                    return (
                      <span
                        key={id}
                        title={t("chat.ctx.pinned")}
                        className="inline-flex items-center gap-1.5 rounded-full border border-primary-foreground/30 bg-primary-foreground/15 py-0.5 pl-2 pr-2.5 text-[11px] font-medium text-primary-foreground/90"
                      >
                        {Icon ? <Icon className="h-3 w-3 shrink-0" aria-hidden /> : null}
                        {t(def?.titleKey ?? (id as TranslationKey))}
                      </span>
                    );
                  })}
                </div>
              ) : null}
              <div className="max-w-full whitespace-pre-wrap wrap-anywhere rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-[15px] leading-relaxed text-primary-foreground shadow-[0_4px_14px_-2px_rgba(8,145,178,0.45)]">
                {/* R8: user words stay plain (no markdown semantics) but bare
                    EVM addresses lift into inverted copy chips. */}
                <UserText text={message.content} />
              </div>
            </div>
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/30">
              <User className="h-3.5 w-3.5 text-primary-foreground" />
            </div>
          </div>
          <time className="px-1 text-[11px] text-muted" title={formatTime(message.createdAt)}>{timeAgo(message.createdAt)}</time>
        </div>
        <MessageActions message={message} isUser onCopy={onCopy} onCopyLink={onCopyLink} onEdit={onEdit} onDelete={onDelete} />
      </motion.div>
    );
  }

  const hasContent = message.content && message.content.length > 0;
  const hasReasoning = !!message.reasoning && message.reasoning.length > 0;
  // C1 (§4.5): trace-beat messages render ONLY the execution trace component
  // (+ the deploy confirmation card); text-beat messages render narration —
  // never a concatenated blob. Legacy messages (no beat) keep the combined
  // layout so old transcripts render unchanged.
  const isTraceBeat = message.beat === "trace";
  const isTextBeat = message.beat === "text";
  const hasTrace = !isTextBeat && (message.trace?.length ?? 0) > 0;
  const streaming = message.streaming;
  const showWaiting = streaming && !hasContent && !hasReasoning && !message.intent && !hasTrace;
  // P3: an operation in flight (tool step running / awaiting a signature /
  // broadcast pending its receipt / confirmation card shown / attestation
  // wait) suspends the stream-stall hint — see IN_FLIGHT_STATUSES.
  const anyStepInFlight = (message.trace ?? []).some(
    (st) => st.status != null && IN_FLIGHT_STATUSES.has(st.status),
  );
  const inFlight = anyStepInFlight || Boolean(message.pendingConfirmation);
  // N22: change signature — any growth in narration, reasoning, trace depth,
  // or a confirmation landing counts as stream progress (resets the timer).
  const progressSignature = `${message.content?.length ?? 0}:${message.reasoning?.length ?? 0}:${message.trace?.length ?? 0}:${message.trace?.reduce((a, s) => a + (s.status?.length ?? 0), 0) ?? 0}:${message.trace?.reduce((a, s) => a + (s.detail?.text?.length ?? 0), 0) ?? 0}:${message.trace?.reduce((a, s) => a + (s.detail?.txHash?.length ?? 0), 0) ?? 0}:${message.pendingConfirmation ? 1 : 0}`;

  return (
    <motion.div
      initial={{ opacity: 0, y: 14, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={spring}
      className="group flex flex-col gap-0.5"
    >
      <div className="flex max-w-[85%] flex-col gap-1.5">
        <div className="flex items-start gap-2.5">
          {isTraceBeat && !hasContent && !hasReasoning ? null : (
            <div className="relative mt-0.5 h-8 w-8 shrink-0">
              {/* C21: a soft breathing ring while the model is live */}
              {streaming ? (
                <motion.span
                  aria-hidden
                  className="absolute -inset-1 rounded-full border border-primary/40"
                  animate={{ opacity: [0.15, 0.6, 0.15], scale: [0.94, 1.06, 0.94] }}
                  transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                />
              ) : null}
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-primary/25 via-primary/15 to-primary/5 ring-1 ring-primary/30 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]">
                <Bot className="h-4 w-4 text-primary" />
              </div>
            </div>
          )}
          {/* P8: min-w-0 — this column is a flex item in the avatar ROW; without
              it min-width:auto lets an unbreakable code line / long word blow
              the column past the bubble (observed 2118px at a 390 viewport).
              With it the pre's overflow-x-auto takes over and the paragraph's
              wrap-anywhere actually engages. */}
          <div className="flex min-w-0 flex-col gap-1.5">
            {showWaiting ? (
              <div className="glass-tight flex items-center gap-1.5 rounded-2xl rounded-bl-md px-4 py-3 text-[13px] text-muted">
                <Brain className="h-3.5 w-3.5 text-primary/80" />
                <span>{t("chat.thinking")}</span>
                {[0, 1, 2].map((i) => (
                  <motion.span
                    key={i}
                    className="h-1.5 w-1.5 rounded-full bg-muted"
                    animate={{ opacity: [0.3, 1, 0.3] }}
                    transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.16, ease: "easeInOut" }}
                  />
                ))}
              </div>
            ) : null}

            {hasReasoning && showThinking ? (
              <ReasoningBlock reasoning={message.reasoning!} streaming={streaming} />
            ) : null}

            {hasContent ? (
              <div className="glass-tight rounded-2xl rounded-bl-md px-4 py-2.5 text-[15px] leading-relaxed text-foreground">
                <RichText
                  text={message.content}
                  streaming={streaming}
                  cursor={
                    streaming ? (
                      <motion.span
                        className="ml-0.5 inline-block h-3.5 w-1.5 align-middle bg-primary/60"
                        animate={{ opacity: [1, 0.25, 1] }}
                        transition={{ duration: 1.05, repeat: Infinity, ease: "easeInOut" }}
                      />
                    ) : undefined
                  }
                />
              </div>
            ) : null}

            {message.trace && message.trace.length > 0 ? (
              <AgentTrace
                steps={message.trace}
                footer={{
                  finishReason: message.streaming
                    ? null
                    : (message.runFinish ?? null),
                }}
              />
            ) : null}

            {message.pendingConfirmation ? (
              <AgentConfirmation
                request={message.pendingConfirmation}
                onAnswer={(approved, rememberChoice) =>
                  onAnswerConfirmation?.(message, message.pendingConfirmation!.callId, approved, rememberChoice)
                }
              />
            ) : null}

            {message.intent ? (
              <IntentCard
                intent={message.intent}
                status={message.status}
                txHash={message.txHash}
                chainId={message.chainId}
                senderAddress={address ?? undefined}
                paymentStep={message.paymentStep}
                onConfirm={onConfirmIntent ? () => onConfirmIntent(message) : undefined}
                onCancel={onCancelIntent ? () => onCancelIntent(message) : undefined}
                onCancelPayment={onCancelPayment ? () => onCancelPayment(message) : undefined}
                paymentId={message.paymentId}
              />
            ) : null}

            {message.status ? <StatusPill status={message.status} /> : null}

            {streaming ? <StalledHint live={streaming} signature={progressSignature} inFlight={inFlight} /> : null}
          </div>
        </div>
        <time className="pl-[42px] text-[11px] text-muted" title={formatTime(message.createdAt)}>
          {timeAgo(message.createdAt)}
        </time>
      </div>
      <MessageActions message={message} isUser={false} onCopy={onCopy} onCopyLink={onCopyLink} onDelete={onDelete} onRegenerate={onRegenerate} />
    </motion.div>
  );
});
