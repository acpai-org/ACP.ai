"use client";

import { useRef, useState, useEffect, type KeyboardEvent, type FormEvent, useMemo } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ArrowUp, Square, Command, X, CornerDownLeft, Star, UserRound, Keyboard } from "lucide-react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { openPalette, openShortcutsHelp } from "@/lib/palette-events";
import { filterSlashCommands, type SlashCommandId } from "@/lib/chat/slash-commands";
import {
  activeMentionQuery,
  applyMention,
  fetchMentionCandidates,
  filterMentionCandidates,
  type MentionCandidate,
} from "@/lib/chat/mentions";
import { useDraftStore, getDraft } from "@/lib/chat/draft-store";
import type { TranslationKey } from "@/lib/i18n/types";
import { cn } from "@/lib/utils";

interface ChatInputProps {
  onSend: (text: string, attachments?: SlashCommandId[]) => void;
  disabled?: boolean;
  prefill?: string;
  onStop?: () => void;
  isGenerating?: boolean;
  /** Active chat session id — drives per-session draft save/restore (R6).
   *  Undefined keeps the legacy single-buffer behavior. */
  sessionKey?: string | null;
}

// The menu is open while the whole composer value looks like a command being
// typed: "/" optionally followed by letters, nothing else on the line.
const SLASH_TYPING_RE = /^\/[a-zA-Z]*$/;

// Deterministic avatar gradient per contact (R7): five warm/cool pairs, none
// of them indigo/blue. Selected by a stable hash of the address.
const AVATAR_GRADIENTS = [
  "linear-gradient(135deg, rgba(20,184,166,0.85), rgba(13,148,136,0.65))",
  "linear-gradient(135deg, rgba(16,185,129,0.8), rgba(5,150,105,0.6))",
  "linear-gradient(135deg, rgba(245,158,11,0.75), rgba(217,119,6,0.55))",
  "linear-gradient(135deg, rgba(244,63,94,0.7), rgba(190,18,60,0.5))",
  "linear-gradient(135deg, rgba(139,92,246,0.7), rgba(108,71,233,0.5))",
];

function avatarGradient(address: string): string {
  let h = 0;
  for (let i = 0; i < address.length; i++) h = (h * 31 + address.charCodeAt(i)) | 0;
  return AVATAR_GRADIENTS[Math.abs(h) % AVATAR_GRADIENTS.length];
}

function initialsOf(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Middle-truncate an address for the picker row (keeps the visual rhythm). */
function shortAddress(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}…${address.slice(-5)}`;
}

export function ChatInput({ onSend, disabled, prefill, onStop, isGenerating, sessionKey }: ChatInputProps) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<SlashCommandId[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionCandidates, setMentionCandidates] = useState<MentionCandidate[] | null>(null);
  /** The query an Escape dismissed — the menu stays closed until it CHANGES. */
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastPrefill = useRef<string | undefined>(undefined);

  const slashQuery = SLASH_TYPING_RE.test(value) ? value.slice(1).toLowerCase() : null;
  const commands = useMemo(
    () => (slashQuery === null ? [] : filterSlashCommands(slashQuery)),
    [slashQuery],
  );
  const slashOpen = commands.length > 0;
  // The highlight is CLAMPED at read time (never via an effect) so a
  // shrinking filtered list can't leave a stale out-of-range index.
  const activeIndex = Math.min(slashIndex, commands.length - 1);
  const activeCommand = slashOpen ? commands[activeIndex] : null;

  // ── @-mention state (R7) ───────────────────────────────────────────────
  const rawMentionQuery = activeMentionQuery(value);
  const mentionQuery = rawMentionQuery !== null && dismissedQuery === rawMentionQuery ? null : rawMentionQuery;
  const mentionOpen = mentionQuery !== null && !slashOpen;
  const mentionMatches = useMemo(
    () => (mentionCandidates === null ? [] : filterMentionCandidates(mentionCandidates, mentionQuery ?? "")),
    [mentionCandidates, mentionQuery],
  );
  const activeMentionIndex = Math.min(mentionIndex, Math.max(mentionMatches.length - 1, 0));
  const activeMention = mentionMatches[activeMentionIndex] ?? null;

  // Load the contact list once when the picker first opens (cached 30s in the
  // mentions module — repeated opens within a typing burst don't re-fetch).
  useEffect(() => {
    if (!mentionOpen) return;
    let alive = true;
    fetchMentionCandidates().then((list) => {
      if (alive) setMentionCandidates(list);
    });
    return () => {
      alive = false;
    };
  }, [mentionOpen]);

  // Prefill: the edit-resend flow fills the composer with the message being
  // edited (consumed once per distinct value; attachments always start fresh
  // — editing re-pins them deliberately).
  useEffect(() => {
    if (prefill !== undefined && prefill !== lastPrefill.current) {
      setValue(prefill);
      lastPrefill.current = prefill;
      if (sessionKey) useDraftStore.getState().setDraftText(sessionKey, prefill);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    }
  }, [prefill, sessionKey]);

  // ── Per-session drafts (R6; R7 restores attachments too) ───────────────
  // Switching sessions restores whatever was typed AND the pinned context
  // chips; the outgoing session's state was saved on every change. Guard on
  // the EDGE (like the sidebar drawer-close filter) so re-renders with an
  // unchanged key never clobber in-progress typing. The sentinel start
  // (undefined, never a real session id) makes the FIRST mount count as an
  // edge too — a fresh page load restores the active session's draft from
  // localStorage.
  const prevSessionKey = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (prevSessionKey.current === sessionKey) return;
    prevSessionKey.current = sessionKey;
    const restored = getDraft(sessionKey);
    setValue(restored.text);
    setAttachments(restored.attachments);
    setDismissedQuery(null);
    lastPrefill.current = undefined;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
      }
    });
  }, [sessionKey]);

  function persistAttachments(next: SlashCommandId[]) {
    if (sessionKey) useDraftStore.getState().setDraftAttachments(sessionKey, next);
  }

  function attach(id: SlashCommandId) {
    setAttachments((prev) => {
      const next = prev.includes(id) ? prev : [...prev, id];
      persistAttachments(next);
      return next;
    });
    setValue("");
    if (sessionKey) useDraftStore.getState().setDraftText(sessionKey, "");
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.style.height = "auto";
        el.focus();
      }
    });
  }

  function removeAttachment(id: SlashCommandId) {
    setAttachments((prev) => {
      const next = prev.filter((a) => a !== id);
      persistAttachments(next);
      return next;
    });
  }

  function autoresize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  function commitMention(candidate: MentionCandidate) {
    const next = applyMention(value, candidate.label, candidate.address);
    setValue(next);
    setMentionIndex(0);
    if (sessionKey) useDraftStore.getState().setDraftText(sessionKey, next);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  }

  function send() {
    const trimmed = value.trim();
    if (slashOpen || mentionOpen) return; // Enter selects the highlighted item, never sends
    if (!trimmed && attachments.length === 0) return;
    if (disabled) return;
    onSend(trimmed, attachments.length > 0 ? attachments : undefined);
    setValue("");
    setAttachments([]);
    setDismissedQuery(null);
    lastPrefill.current = undefined;
    if (sessionKey) useDraftStore.getState().clearDraft(sessionKey);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.style.height = "auto";
      }
    });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // IME composition: Enter confirms the composition, never the menus.
    const composing = e.nativeEvent.isComposing;
    if (slashOpen && !composing) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % commands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + commands.length) % commands.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (activeCommand) attach(activeCommand.id);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setValue("");
        return;
      }
      // Any other key falls through and keeps editing the query.
    }
    if (mentionOpen && !composing) {
      if (mentionMatches.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMentionIndex((i) => (i + 1) % mentionMatches.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          if (activeMention) commitMention(activeMention);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Dismiss for THIS query — typing more (or backspacing the token)
        // reopens the picker. Unlike the slash menu, the message stays.
        setDismissedQuery(rawMentionQuery);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !composing) {
      e.preventDefault();
      send();
    } else if (e.key === "Backspace" && value === "" && attachments.length > 0) {
      e.preventDefault();
      setAttachments((prev) => {
        const next = prev.slice(0, -1);
        persistAttachments(next);
        return next;
      });
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    send();
  }

  const canSend = (value.trim().length > 0 || attachments.length > 0) && !disabled && !slashOpen && !mentionOpen;
  const showStop = isGenerating && onStop;

  return (
    <form onSubmit={handleSubmit} className="relative">
      {/* ── "/" command menu (C23): context attachments, no images ── */}
      <AnimatePresence>
        {slashOpen ? (
          <motion.div
            key="slash-menu"
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="absolute bottom-full left-0 right-0 z-40 mb-2"
            role="listbox"
            aria-label={t("chat.slash.menuTitle")}
          >
            <div className="glass-tight overflow-hidden rounded-2xl shadow-xl">
              <div className="border-b border-border/40 px-3.5 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-2">
                {t("chat.slash.menuTitle")}
              </div>
              <div className="acp-scroll max-h-64 overflow-y-auto p-1.5">
                {commands.map((c, i) => {
                  const Icon = c.icon;
                  const isActive = i === activeIndex;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onMouseDown={(e) => {
                        // mousedown beats blur: the textarea keeps focus
                        e.preventDefault();
                        attach(c.id);
                      }}
                      onMouseEnter={() => setSlashIndex(i)}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors",
                        isActive ? "bg-primary/12 text-foreground" : "text-muted hover:bg-foreground/5",
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1 transition-colors",
                          isActive
                            ? "bg-primary/15 ring-primary/30 text-primary"
                            : "bg-surface-2/60 ring-border/60 text-muted-2",
                        )}
                      >
                        <Icon className="h-3.5 w-3.5" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-medium leading-tight">
                          <span className="font-mono text-primary/90">/{c.id}</span>
                          <span className="ml-2 text-foreground/90">{t(c.titleKey)}</span>
                        </span>
                        <span className="block truncate text-[11.5px] leading-tight text-muted-2">
                          {t(c.descKey)}
                        </span>
                      </span>
                      {isActive ? (
                        <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted-2" aria-hidden />
                      ) : null}
                    </button>
                  );
                })}
              </div>
              <div className="border-t border-border/40 px-3.5 py-1.5 text-[11px] text-muted-2">
                {t("chat.slash.hint")}
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* ── "@" mention menu (R7): saved contacts → inline recipient text ── */}
      <AnimatePresence>
        {mentionOpen ? (
          <motion.div
            key="mention-menu"
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="absolute bottom-full left-0 right-0 z-40 mb-2"
            role="listbox"
            aria-label={t("chat.mention.menuTitle")}
          >
            <div className="glass-tight overflow-hidden rounded-2xl shadow-xl">
              <div className="flex items-center justify-between border-b border-border/40 px-3.5 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-2">
                {t("chat.mention.menuTitle")}
                {mentionCandidates !== null && mentionCandidates.length > 0 ? (
                  <span className="tabular-nums normal-case tracking-normal">{mentionMatches.length}/{mentionCandidates.length}</span>
                ) : null}
              </div>
              <div className="acp-scroll max-h-64 overflow-y-auto p-1.5">
                {mentionCandidates === null ? (
                  <div className="flex items-center gap-2.5 px-2.5 py-2.5 text-[12.5px] text-muted-2">
                    <span className="h-4 w-4 animate-spin rounded-full border border-border/70 border-t-primary/70" aria-hidden />
                    {t("chat.mention.loading")}
                  </div>
                ) : mentionMatches.length === 0 ? (
                  <div className="px-2.5 py-2">
                    <div className="flex items-center gap-2.5 text-[12.5px] text-muted-2">
                      <UserRound className="h-4 w-4 shrink-0 text-muted-3" aria-hidden />
                      {t("chat.mention.empty")}
                    </div>
                    <Link
                      href="/contacts"
                      className="mt-1.5 inline-flex items-center gap-1 text-[12px] font-medium text-primary transition-colors hover:text-primary-hover"
                    >
                      {t("chat.mention.manage")}
                      <span aria-hidden>→</span>
                    </Link>
                  </div>
                ) : (
                  mentionMatches.map((c, i) => {
                    const isActive = i === activeMentionIndex;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        onMouseDown={(e) => {
                          // mousedown beats blur: the textarea keeps focus
                          e.preventDefault();
                          commitMention(c);
                        }}
                        onMouseEnter={() => setMentionIndex(i)}
                        className={cn(
                          "flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors",
                          isActive ? "bg-primary/12 text-foreground" : "text-muted hover:bg-foreground/5",
                        )}
                      >
                        <span
                          aria-hidden
                          className={cn(
                            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white ring-1 transition-shadow",
                            isActive ? "ring-primary/40 shadow-[0_0_12px_-2px_rgba(34,211,238,0.45)]" : "ring-border/60",
                          )}
                          style={{ background: avatarGradient(c.address) }}
                        >
                          {initialsOf(c.label)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5 text-[13px] font-medium leading-tight text-foreground/90">
                            <span className="truncate">{c.label}</span>
                            {c.favorite ? (
                              <Star className="h-3 w-3 shrink-0 fill-warning/80 text-warning" aria-hidden />
                            ) : null}
                          </span>
                          <span className="block truncate font-mono text-[11.5px] leading-tight text-muted-2">
                            {shortAddress(c.address)}
                          </span>
                        </span>
                        {isActive ? (
                          <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted-2" aria-hidden />
                        ) : null}
                      </button>
                    );
                  })
                )}
              </div>
              <div className="border-t border-border/40 px-3.5 py-1.5 text-[11px] text-muted-2">
                {t("chat.mention.hint")}
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div
        className={cn(
          // S10-a (round-5 styling, VLM-guided): the composer read as decoration
          // — glass-tight alone was nearly indistinguishable from the page
          // background. A resting inset ring + depth shadow gives it a visible
          // field edge BEFORE focus; the focus-within glow then replaces the
          // resting shadow (both states defined, no stacking).
          "glass-tight rounded-2xl shadow-[0_10px_28px_-14px_rgba(0,0,0,0.45)] ring-1 ring-inset ring-foreground/[0.08] transition-all duration-200",
          "focus-within:border-primary/40 focus-within:ring-primary/25 focus-within:shadow-[0_0_0_3px_rgba(34,211,238,0.2)]",
          attachments.length > 0 ? "p-2" : "p-2",
        )}
      >
        {/* Attachment chips — pinned context that rides the next message */}
        <AnimatePresence initial={false}>
          {attachments.length > 0 ? (
            <motion.div
              key="chips"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              className="overflow-hidden"
            >
              <div className="flex flex-wrap items-center gap-1.5 px-1 pb-1.5">
                {attachments.map((id) => {
                  const def = filterSlashCommands("").find((c) => c.id === id);
                  const Icon = def?.icon;
                  const label = t(def?.titleKey ?? (id as TranslationKey));
                  return (
                    <span
                      key={id}
                      className="group/chip inline-flex max-w-full items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 py-1 pl-2.5 pr-1.5 text-[11.5px] font-medium text-primary"
                    >
                      {Icon ? <Icon className="h-3 w-3 shrink-0" aria-hidden /> : null}
                      <span className="truncate">{label}</span>
                      <button
                        type="button"
                        onClick={() => removeAttachment(id)}
                        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-primary/60 transition-colors hover:bg-primary/20 hover:text-primary"
                        aria-label={t("chat.slash.removeChip", { name: label })}
                      >
                        <X className="h-2.5 w-2.5" aria-hidden />
                      </button>
                    </span>
                  );
                })}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={openPalette}
            title={t("palette.shortcutHint")}
            aria-label={t("palette.composerChip")}
            className="hit-slop flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-xl text-muted transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 md:h-9 md:w-9"
          >
            <Command className="h-4 w-4" aria-hidden />
          </button>
          {/* Touch path to the `?` shortcuts overlay — phones have no `?` in
              reach; desktop users get the key. Hidden while narrow to keep the
              composer's tap targets uncluttered (the ⌘K chip + textarea +
              send/stop still fit one row at 390px). */}
          <button
            type="button"
            onClick={openShortcutsHelp}
            title={t("shortcuts.hint")}
            aria-label={t("shortcuts.hint")}
            className="hit-slop hidden h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-xl text-muted/80 transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 sm:flex md:h-9 md:w-9"
          >
            <Keyboard className="h-4 w-4" aria-hidden />
          </button>
          <textarea
            ref={textareaRef}
            data-chat-composer=""
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              // R6 per-session draft: save on every keystroke (the draft
              // store is isolated — no parent re-render, debounced persist).
              if (sessionKey) useDraftStore.getState().setDraftText(sessionKey, e.target.value);
              autoresize();
            }}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={t("chat.placeholder")}
            aria-label={t("chat.send")}
            className="max-h-40 flex-1 resize-none bg-transparent px-2 py-2 text-[15px] leading-relaxed text-foreground placeholder:text-muted focus:outline-none"
          />
          <AnimatePresence mode="wait" initial={false}>
            {showStop ? (
              <motion.button
                key="stop"
                type="button"
                whileTap={{ scale: 0.88 }}
                onClick={onStop}
                aria-label={t("chat.stop")}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-danger/15 text-danger ring-1 ring-danger/30 transition-all duration-200 cursor-pointer hover:bg-danger/25 hover:ring-danger/40"
              >
                <Square className="h-4 w-4 fill-current" />
              </motion.button>
            ) : (
              <motion.button
                key="send"
                type="submit"
                whileTap={{ scale: 0.88 }}
                disabled={!canSend}
                aria-label={t("chat.send")}
                className={cn(
                  "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-all duration-200 cursor-pointer",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  canSend
                    ? "bg-primary text-primary-foreground shadow-[0_4px_14px_-2px_rgba(8,145,178,0.5)]"
                    : "bg-surface-2 text-muted-2 cursor-not-allowed",
                )}
              >
                <ArrowUp className="h-5 w-5" />
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>
    </form>
  );
}
