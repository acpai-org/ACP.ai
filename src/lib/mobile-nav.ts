"use client";

import { create } from "zustand";

// ─────────────────────────────────────────────────────────────────────────────
// Mobile navigation drawer state.
//
// The drawer itself renders inside <Navbar/> (it needs the nav item list and
// overlays below the navbar pill), but it can be opened from two surfaces:
// the navbar hamburger and the "More" tab of the mobile bottom tab bar
// (siblings under Web3Frame). A tiny zustand store avoids prop drilling
// through the frame.
// ─────────────────────────────────────────────────────────────────────────────

interface MobileNavState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useMobileNav = create<MobileNavState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
