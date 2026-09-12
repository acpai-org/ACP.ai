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
// R20 (round-3): deletion tombstones for the cross-tab merge. A session id
// maps to the timestamp of its most recent deletion; a remote write that
// still carries an OLDER version of that session stays deleted instead of
// resurrecting it (last-writer-wins at session granularity, delete-wins when
// the deletion is newer than the surviving edit). Pruned after 30 days.
const TOMBSTONE_TTL_MS = 30 * 86_400_000;
let tombstones: Record<string, number> = {};

let seq = 0;
function genId(prefix: string) {
  seq += 1;
  // R14 fix: the per-tab `seq` counter resets on reload — two tabs at the
  // same millisecond generated IDENTICAL ids, so one tab's messages silently
  // merged into the other's session (same id keys). A random suffix makes
  // collisions practically impossible.
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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
        deletedAt?: Record<string, number>;
      };
      if (parsed.sessions && parsed.order && parsed.order.length > 0) {
        const sessMap = parsed.sessions;
        const valid = parsed.order.filter((id) => sessMap[id]);
        const activeId = parsed.activeId && sessMap[parsed.activeId] ? parsed.activeId : valid[0];
        if (parsed.deletedAt && typeof parsed.deletedAt === "object") {
          tombstones = parsed.deletedAt;
        }
        return { sessions: sessMap, order: valid, activeId: activeId ?? null };
      }
    }
  } catch {}
  const s = newSessionObj();
  const fresh = { sessions: { [s.id]: s }, order: [s.id], activeId: s.id };
  // R20 (round-3): write the boot session back IMMEDIATELY. Previously the
  // fallback session lived only in memory — with empty storage a SECOND tab
  // opened before any user action ALSO created its own divergent session
  // (first-ever multi-tab visit → two "New chat" entries that never merge
  // away). The boot write-back makes tab 2 load tab 1's session instead.
  persist(fresh);
  return fresh;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingState: { sessions: Record<string, ChatSession>; order: string[]; activeId: string | null } | null = null;

function flushPersist() {
  if (!pendingState) return;
  const state = pendingState;
  pendingState = null;
  if (typeof window === "undefined") return;
  try {
    const json = JSON.stringify({
      sessions: state.sessions,
      order: state.order,
      activeId: state.activeId,
      deletedAt: tombstones,
    });
    localStorage.setItem(STORAGE_KEY, json);
    // R26: mirror the write on the sync channel — background tabs receive it
    // immediately even when the browser throttles/skips `storage` event
    // delivery (live-observed in headless QA: a background tab's UI only
    // refreshed on focus). The receiving side runs the same idempotent merge
    // as the storage listener, so double delivery is a no-op.
    syncChannel()?.postMessage(json);
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

// R15 fix: closing the tab (or navigating away) within the 1s debounce window
// silently dropped the last messages — flush on pagehide, the reliable
// lifecycle event for persisted state (fires for tab close, reload, and
// navigation; bfcache-friendly).
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPersist);
  // Belt & braces: 'beforeunload' still fires in some embed/iframe contexts
  // where pagehide is deferred.
  window.addEventListener("beforeunload", flushPersist);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPersist();
  });
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
      // R20: record the deletion so a stale remote tab's copy of this session
      // cannot resurrect it during the cross-tab merge.
      tombstones[id] = Date.now();
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
    // R20: tombstone every removed session — a second tab that still holds
    // the old full state must not resurrect them on its next persist.
    const now = Date.now();
    for (const id of Object.keys(get().sessions)) tombstones[id] = now;
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

// ─────────────────────────────────────────────────────────────────────────────
// R20 (round-3): cross-tab sync. The `storage` event fires in EVERY OTHER tab
// when this tab writes localStorage — previously nobody listened, so two tabs
// clobbered each other with last-writer-wins full-state writes (a session
// created in tab B vanished when tab A flushed 1s later). The merge below is
// session-granularity last-writer-wins with union semantics:
//   • sessions present in only one side are always kept (nothing is lost);
//   • sessions present in both keep the copy with the newer `updatedAt`
//     (every mutating action bumps it, so this is the recency authority);
//   • deletion tombstones (newer than the surviving copy) keep sessions dead;
//   • `order` is recomputed deterministically (createdAt desc, id tiebreak)
//     so both tabs converge to the identical array instead of ping-ponging
//     directional merges back and forth;
//   • `activeId` stays LOCAL — a remote tab must never switch which chat the
//     user is looking at in THIS tab.
// If the merge actually changed local state we re-persist (debounced), which
// propagates the union to further tabs; once all tabs agree the merge becomes
// a no-op and the write chatter stops.
// ─────────────────────────────────────────────────────────────────────────────
function applyRemoteState(remoteRaw: string) {
  try {
    const remote = JSON.parse(remoteRaw) as {
      sessions?: Record<string, ChatSession>;
      order?: string[];
      activeId?: string | null;
      deletedAt?: Record<string, number>;
    };
    if (!remote.sessions || typeof remote.sessions !== "object" || !Array.isArray(remote.order)) return;

    const local = useChatStore.getState();

    // Union tombstones: per id keep the LATEST deletion timestamp, then prune
    // entries past their TTL so the map stays bounded.
    const mergedTomb: Record<string, number> = { ...tombstones };
    for (const [id, ts] of Object.entries(remote.deletedAt ?? {})) {
      if (typeof ts === "number" && (mergedTomb[id] ?? 0) < ts) mergedTomb[id] = ts;
    }
    const tombCutoff = Date.now() - TOMBSTONE_TTL_MS;
    for (const [id, ts] of Object.entries(mergedTomb)) {
      if (ts < tombCutoff) delete mergedTomb[id];
    }
    tombstones = mergedTomb;

    // Union sessions: newer updatedAt wins; a tombstone newer than the
    // surviving copy keeps the session deleted.
    const sessions: Record<string, ChatSession> = {};
    const ids = new Set([...Object.keys(local.sessions), ...Object.keys(remote.sessions)]);
    for (const id of ids) {
      const l = local.sessions[id];
      const r = remote.sessions[id];
      const newest = !r ? l : !l ? r : l.updatedAt >= r.updatedAt ? l : r;
      if (newest && (mergedTomb[id] ?? 0) < newest.updatedAt) sessions[id] = newest;
    }

    // Deterministic order: createdAt desc (matches newChat's prepend), id
    // tiebreak for same-millisecond creations across tabs.
    const order = Object.values(sessions)
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .map((s) => s.id);

    // activeId stays local, but must survive the merge (fall back to first).
    let activeId = local.activeId;
    if (activeId && !sessions[activeId]) activeId = order[0] ?? null;

    // Did the merge actually change anything? (Refs are stable for sessions
    // we kept locally, so identity comparison is meaningful.)
    const changed =
      activeId !== local.activeId ||
      order.length !== local.order.length ||
      order.some((id, i) => local.order[i] !== id) ||
      Object.keys(sessions).length !== Object.keys(local.sessions).length ||
      Object.entries(sessions).some(([id, s]) => local.sessions[id] !== s);
    if (!changed) return;

    useChatStore.setState({ sessions, order, activeId });
    // Re-persist the union so third tabs converge; our own activeId rides
    // along, every other tab keeps its own during ITS merge.
    persist({ sessions, order, activeId });
  } catch {
    // Malformed remote payload — ignore it entirely; local state is untouched.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// R26 (round-4): BroadcastChannel companion to the storage listener. The
// `storage` event is the compatibility baseline, but live QA showed background
// tabs sometimes don't re-render until focus (the event is throttled or
// coalesced away by the browser in some embed/headless contexts). A
// BroadcastChannel delivers the identical payload to every same-origin tab
// unconditionally, and applyRemoteState() is idempotent — when both transports
// deliver the same state, the second merge is a no-op (the `changed` check
// short-circuits before any setState or re-persist). Channel failures degrade
// silently: no channel → no extra transport, storage events still work.
// ─────────────────────────────────────────────────────────────────────────────
const SYNC_CHANNEL_NAME = "acp-ai:chat-sync";
let channel: BroadcastChannel | null | undefined;

function syncChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  channel = null;
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return channel;
  try {
    channel = new BroadcastChannel(SYNC_CHANNEL_NAME);
    channel.onmessage = (e) => {
      if (typeof e.data === "string") applyRemoteState(e.data);
    };
  } catch {
    channel = null;
  }
  return channel;
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY && e.newValue) applyRemoteState(e.newValue);
  });
  // Instantiate eagerly so this tab is listening from first paint, not just
  // from the first local write (a read-only tab must still receive updates).
  syncChannel();
}
