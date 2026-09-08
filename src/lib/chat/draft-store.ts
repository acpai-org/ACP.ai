"use client";

import { create } from "zustand";
import type { SlashCommandId } from "@/lib/chat/slash-commands";
import { isComposerDraft, type ComposerDraft } from "@/lib/chat/mentions";

/**
 * Per-session composer drafts (R6; R7 extended to attachments).
 *
 * A separate store ON PURPOSE: the main chat store is subscribed wholesale
 * by ChatView (`useChatStore()` with no selector), so a draft keystroke
 * written there would re-render the whole chat surface on every key. This
 * store is only touched imperatively from ChatInput (getState + actions) —
 * nothing subscribes to it reactively, so typing stays local-render.
 *
 * Drafts persist to their own localStorage key (same debounced pattern as
 * the chat store). A draft lives until the message is sent, the session is
 * deleted, or the user clears the composer — switching sessions never
 * discards what was typed. The R7 shape carries the pinned slash-command
 * attachments too, so a restored draft resurrects its context chips.
 */

const DRAFTS_KEY = "acp-ai:chat-drafts";
const PERSIST_DEBOUNCE_MS = 400;

const EMPTY: ComposerDraft = { text: "", attachments: [] };

function loadDrafts(): Record<string, ComposerDraft> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(DRAFTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, ComposerDraft> = {};
    for (const [id, v] of Object.entries(parsed)) {
      // Migration: pre-R7 entries were plain strings (text-only drafts).
      if (typeof v === "string" && v.length > 0) {
        out[id] = { text: v, attachments: [] };
        continue;
      }
      // Be strict: only well-formed drafts survive — a corrupt entry must
      // never end up in a textarea or as a bogus attachment chip.
      if (isComposerDraft(v) && (v.text.length > 0 || v.attachments.length > 0)) {
        out[id] = { text: v.text, attachments: v.attachments.slice() };
      }
    }
    return out;
  } catch {
    return {};
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingDrafts: Record<string, ComposerDraft> | null = null;

function flushPersist() {
  if (!pendingDrafts) return;
  const drafts = pendingDrafts;
  pendingDrafts = null;
  if (typeof window === "undefined") return;
  try {
    if (Object.keys(drafts).length === 0) {
      localStorage.removeItem(DRAFTS_KEY);
    } else {
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
    }
  } catch {
    /* private mode / quota — drafts just won't survive a reload */
  }
}

function persistDrafts(drafts: Record<string, ComposerDraft>) {
  pendingDrafts = drafts;
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushPersist();
  }, PERSIST_DEBOUNCE_MS);
}

interface DraftStoreState {
  drafts: Record<string, ComposerDraft>;
  /** Keystroke path — updates the text, PRESERVES the pinned attachments. */
  setDraftText: (sessionId: string, text: string) => void;
  /** Attach/detach path — updates the attachments, PRESERVES the text. */
  setDraftAttachments: (sessionId: string, attachments: SlashCommandId[]) => void;
  /** Send / clear path: the draft is gone for good. */
  clearDraft: (sessionId: string) => void;
}

function isEmptyDraft(d: ComposerDraft): boolean {
  return d.text.length === 0 && d.attachments.length === 0;
}

export const useDraftStore = create<DraftStoreState>((set, get) => ({
  drafts: loadDrafts(),

  setDraftText: (sessionId, text) => {
    if (!sessionId) return;
    const trimmed = text ?? "";
    const cur = get().drafts[sessionId] ?? EMPTY;
    if (cur.text === trimmed) return; // no-op keystrokes (selections, IME confirms)
    const next: ComposerDraft = { text: trimmed, attachments: cur.attachments };
    const drafts = { ...get().drafts };
    if (isEmptyDraft(next)) delete drafts[sessionId];
    else drafts[sessionId] = next;
    persistDrafts(drafts);
    set({ drafts });
  },

  setDraftAttachments: (sessionId, attachments) => {
    if (!sessionId) return;
    const cur = get().drafts[sessionId] ?? EMPTY;
    if (cur.attachments.length === attachments.length && cur.attachments.every((a, i) => a === attachments[i])) {
      return; // no-op
    }
    const next: ComposerDraft = { text: cur.text, attachments: attachments.slice() };
    const drafts = { ...get().drafts };
    if (isEmptyDraft(next)) delete drafts[sessionId];
    else drafts[sessionId] = next;
    persistDrafts(drafts);
    set({ drafts });
  },

  clearDraft: (sessionId) => {
    if (!sessionId || !(sessionId in get().drafts)) return;
    const drafts = { ...get().drafts };
    delete drafts[sessionId];
    persistDrafts(drafts);
    set({ drafts });
  },
}));

/** Read a draft without subscribing (imperative, render-free). */
export function getDraft(sessionId: string | null | undefined): ComposerDraft {
  if (!sessionId) return EMPTY;
  return useDraftStore.getState().drafts[sessionId] ?? EMPTY;
}

/** Drop a draft without subscribing (used when a session is deleted). */
export function dropDraft(sessionId: string): void {
  useDraftStore.getState().clearDraft(sessionId);
}
