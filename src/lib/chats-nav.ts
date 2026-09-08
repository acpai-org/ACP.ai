"use client";

import { create } from "zustand";

// ─────────────────────────────────────────────────────────────────────────────
// useChatsNav (N7): the CHATS drawer state — which page shows the chat
// sessions sidebar. The Android top bar carries ONLY the brand + this
// control (the owner's three-line "CHATS" thingie), so the state it flips
// must be reachable from the global navbar, not from inside ChatView.
// Mirrors the shape of mobile-nav.ts. Not persisted.
// ─────────────────────────────────────────────────────────────────────────────

interface ChatsNavState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useChatsNav = create<ChatsNavState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
