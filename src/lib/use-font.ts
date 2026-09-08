"use client";

import { create } from "zustand";

// ─────────────────────────────────────────────────────────────────────────────
// Font preferences (C15): family (Geist Sans / System fonts) + size scale
// (90% / 100% / 110%). Persisted at acp-ai:font; applied to <html> by
// useFont() (client) and by the inline bootstrap in layout.tsx (no FOUC —
// the root font-size and data-font attribute are set before first paint).
// ─────────────────────────────────────────────────────────────────────────────

export type FontFamily = "geist" | "system";
export type FontScale = 0.9 | 1 | 1.1;

export interface FontPrefs {
  family: FontFamily;
  scale: FontScale;
}

const STORAGE_KEY = "acp-ai:font";

const SCALES: FontScale[] = [0.9, 1, 1.1];

function parsePrefs(raw: string | null): FontPrefs {
  if (!raw) return { family: "geist", scale: 1 };
  try {
    const p = JSON.parse(raw) as Partial<FontPrefs>;
    const family: FontFamily = p.family === "system" ? "system" : "geist";
    const scale = (SCALES as number[]).includes(Number(p.scale)) ? (Number(p.scale) as FontScale) : 1;
    return { family, scale };
  } catch {
    return { family: "geist", scale: 1 };
  }
}

export function loadFontPrefs(): FontPrefs {
  if (typeof window === "undefined") return { family: "geist", scale: 1 };
  try {
    return parsePrefs(localStorage.getItem(STORAGE_KEY));
  } catch {
    return { family: "geist", scale: 1 };
  }
}

/** Applies the prefs to the document root (idempotent, cheap). */
export function applyFontPrefs(prefs: FontPrefs): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.fontSize = `${Math.round(16 * prefs.scale)}px`;
  if (prefs.family === "system") document.documentElement.dataset.font = "system";
  else delete document.documentElement.dataset.font;
}

interface FontStore {
  prefs: FontPrefs;
  setPrefs: (next: FontPrefs) => void;
}

export const useFontStore = create<FontStore>((set) => ({
  prefs: { family: "geist", scale: 1 },
  setPrefs: (next) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable — in-memory still applies */
    }
    applyFontPrefs(next);
    set({ prefs: next });
  },
}));
