"use client";

import { create } from "zustand";
import type { ChatMessageData } from "@/lib/types";

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessageData[];
  createdAt: number;
  updatedAt: number;
  modelOverride?: string | null;
  /** R6: pinned sessions stay at the top of the sidebar (own group),
   *  surviving the date grouping. Optional so persisted pre-R6 state
   *  hydrates unchanged. */
  pinned?: boolean;
}

interface ChatStoreState {
  sessions: Record<string, ChatSession>;
  order: string[];
  activeId: string | null;
  /** C24: sidebar minimized to an icon rail (desktop only; persisted). */
  sidebarCollapsed: boolean;
  toggleSidebarCollapsed: () => void;
  newChat: () => string;
  selectChat: (id: string) => void;
  deleteChat: (id: string) => void;
  renameChat: (id: string, title: string) => void;
  setChatModelOverride: (id: string, model: string | null) => void;
  togglePin: (id: string) => void;
  clearAll: () => void;
  addMessage: (sessionId: string, msg: ChatMessageData) => void;
  updateMessage: (sessionId: string, id: string, updater: (m: ChatMessageData) => ChatMessageData) => void;
  deleteMessage: (sessionId: string, id: string) => void;
  replaceFromMessage: (sessionId: string, replaceId: string, newMessages: ChatMessageData[]) => void;
  truncateAfter: (sessionId: string, id: string) => void;
}

const STORAGE_KEY = "acp-ai:chat-sessions";
const LEGACY_STORAGE_KEY = "hsk-ai:chat-sessions";
const SIDEBAR_KEY = "acp-ai:chat-sidebar-collapsed";
const MAX_TITLE = 42;
const PERSIST_DEBOUNCE_MS = 1000;

let seq = 0;
function genId(prefix: string) {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`;
}

function newSessionObj(): ChatSession {
  const now = Date.now();
  // Title intentionally empty: the UI renders the localized "new chat"
  // placeholder via t("chat.newChat") until the first user message lands
  // (deriveTitle then stores the message excerpt). Persisting a display
  // string here would freeze it in one language.
  return { id: genId("chat"), title: "", messages: [], createdAt: now, updatedAt: now };
}

function loadPersisted(): { sessions: Record<string, ChatSession>; order: string[]; activeId: string | null } {
  if (typeof window === "undefined") {
    const s = newSessionObj();
    return { sessions: { [s.id]: s }, order: [s.id], activeId: s.id };
  }
  try {
    // Migrate the pre-rebrand storage key once, then read the new one.
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy && !localStorage.getItem(STORAGE_KEY)) {
      localStorage.setItem(STORAGE_KEY, legacy);
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as {
        sessions?: Record<string, ChatSession>;
        order?: string[];
        activeId?: string | null;
      };
      if (parsed.sessions && parsed.order && parsed.order.length > 0) {
        const sessMap = parsed.sessions;
        const valid = parsed.order.filter((id) => sessMap[id]);
        const activeId = parsed.activeId && sessMap[parsed.activeId] ? parsed.activeId : valid[0];
        return { sessions: sessMap, order: valid, activeId: activeId ?? null };
      }
    }
  } catch {}
  const s = newSessionObj();
  return { sessions: { [s.id]: s }, order: [s.id], activeId: s.id };
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingState: { sessions: Record<string, ChatSession>; order: string[]; activeId: string | null } | null = null;

function flushPersist() {
  if (!pendingState) return;
  const state = pendingState;
  pendingState = null;
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ sessions: state.sessions, order: state.order, activeId: state.activeId }),
    );
  } catch {}
}

function persist(state: { sessions: Record<string, ChatSession>; order: string[]; activeId: string | null }) {
  pendingState = state;
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushPersist();
  }, PERSIST_DEBOUNCE_MS);
}

function deriveTitle(messages: ChatMessageData[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  // Empty title = untitled; the UI falls back to the localized placeholder.
  if (!firstUser) return "";
  const t = firstUser.content.replace(/\s+/g, " ").trim();
  return t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE)}…` : t;
}

export const useChatStore = create<ChatStoreState>((set, get) => ({
  ...loadPersisted(),

  sidebarCollapsed: (() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "1";
    } catch {
      return false;
    }
  })(),

  toggleSidebarCollapsed: () => {
    const next = !get().sidebarCollapsed;
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
    } catch {}
    set({ sidebarCollapsed: next });
  },

  newChat: () => {
    const s = newSessionObj();
    set((state) => {
      const next = {
        sessions: { ...state.sessions, [s.id]: s },
        order: [s.id, ...state.order],
        activeId: s.id,
      };
      persist(next);
      return next;
    });
    return s.id;
  },

  selectChat: (id) => {
    if (!get().sessions[id]) return;
    const next = { sessions: get().sessions, order: get().order, activeId: id };
    persist(next);
    set({ activeId: id });
  },

  deleteChat: (id) => {
    set((state) => {
      const sessions = { ...state.sessions };
      delete sessions[id];
      const order = state.order.filter((x) => x !== id);
      let activeId = state.activeId;
      if (activeId === id) activeId = order[0] ?? null;
      if (activeId === null && order.length === 0) {
        const s = newSessionObj();
        sessions[s.id] = s;
        order.unshift(s.id);
        activeId = s.id;
      }
      const next = { sessions, order, activeId };
      persist(next);
      return next;
    });
  },

  renameChat: (id, title) => {
    set((state) => {
      const sess = state.sessions[id];
      if (!sess) return state;
      const sessions = { ...state.sessions, [id]: { ...sess, title, updatedAt: Date.now() } };
      const next = { sessions, order: state.order, activeId: state.activeId };
      persist(next);
      return next;
    });
  },

  setChatModelOverride: (id, model) => {
    set((state) => {
      const sess = state.sessions[id];
      if (!sess) return state;
      const sessions = { ...state.sessions, [id]: { ...sess, modelOverride: model, updatedAt: Date.now() } };
      const next = { sessions, order: state.order, activeId: state.activeId };
      persist(next);
      return next;
    });
  },

  // R6: pin/unpin — persisted as part of the session object. Pure metadata:
  // no updatedAt bump, so pinning never reshuffles the recency ordering.
  togglePin: (id) => {
    set((state) => {
      const sess = state.sessions[id];
      if (!sess) return state;
      const sessions = { ...state.sessions, [id]: { ...sess, pinned: !sess.pinned } };
      const next = { sessions, order: state.order, activeId: state.activeId };
      persist(next);
      return next;
    });
  },

  clearAll: () => {
    const s = newSessionObj();
    const next = { sessions: { [s.id]: s }, order: [s.id], activeId: s.id };
    persist(next);
    set(next);
  },

  addMessage: (sessionId, msg) => {
    set((state) => {
      const sess = state.sessions[sessionId];
      if (!sess) return state;
      const messages = [...sess.messages, msg];
      const title = sess.messages.length === 0 ? deriveTitle(messages) : sess.title;
      const sessions = { ...state.sessions, [sessionId]: { ...sess, messages, title, updatedAt: Date.now() } };
      const next = { sessions, order: state.order, activeId: state.activeId };
      persist(next);
      return next;
    });
  },

  updateMessage: (sessionId, id, updater) => {
    set((state) => {
      const sess = state.sessions[sessionId];
      if (!sess) return state;
      const messages = sess.messages.map((m) => (m.id === id ? updater(m) : m));
      const sessions = { ...state.sessions, [sessionId]: { ...sess, messages, updatedAt: Date.now() } };
      const next = { sessions, order: state.order, activeId: state.activeId };
      persist(next);
      return next;
    });
  },

  deleteMessage: (sessionId, id) => {
    set((state) => {
      const sess = state.sessions[sessionId];
      if (!sess) return state;
      const messages = sess.messages.filter((m) => m.id !== id);
      const sessions = { ...state.sessions, [sessionId]: { ...sess, messages, updatedAt: Date.now() } };
      const next = { sessions, order: state.order, activeId: state.activeId };
      persist(next);
      return next;
    });
  },

  replaceFromMessage: (sessionId, replaceId, newMessages) => {
    set((state) => {
      const sess = state.sessions[sessionId];
      if (!sess) return state;
      const idx = sess.messages.findIndex((m) => m.id === replaceId);
      const base = idx === -1 ? sess.messages : sess.messages.slice(0, idx);
      const messages = [...base, ...newMessages];
      const title = deriveTitle(messages);
      const sessions = { ...state.sessions, [sessionId]: { ...sess, messages, title, updatedAt: Date.now() } };
      const next = { sessions, order: state.order, activeId: state.activeId };
      persist(next);
      return next;
    });
  },

  truncateAfter: (sessionId, id) => {
    set((state) => {
      const sess = state.sessions[sessionId];
      if (!sess) return state;
      const idx = sess.messages.findIndex((m) => m.id === id);
      if (idx === -1) return state;
      const messages = sess.messages.slice(0, idx + 1);
      const sessions = { ...state.sessions, [sessionId]: { ...sess, messages, updatedAt: Date.now() } };
      const next = { sessions, order: state.order, activeId: state.activeId };
      persist(next);
      return next;
    });
  },
}));

export function newChatMsgId() {
  return genId("m");
}

export function newChatSessionId() {
  return genId("chat");
}
