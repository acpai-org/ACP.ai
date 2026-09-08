"use client";

import { create } from "zustand";

// ─────────────────────────────────────────────────────────────────────────────
// Install-banner visibility (D7/N6 fix): the mobile banner floats above the
// tab bar exactly where the chat composer row sits. Layout consumers (the
// frame's <main>) read this store to add clearance padding while the banner
// is up, so nothing underneath is ever covered or unclickable.
// ─────────────────────────────────────────────────────────────────────────────

interface InstallBannerState {
  visible: boolean;
  setVisible: (v: boolean) => void;
}

export const useInstallBanner = create<InstallBannerState>((set) => ({
  visible: false,
  setVisible: (v) => set({ visible: v }),
}));
