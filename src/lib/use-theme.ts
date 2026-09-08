"use client";

import { useCallback, useSyncExternalStore } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// useTheme — the dual-theme store (brief §9: light and dark at equal polish).
//
//   "dark"   brand default
//   "light"  light palette at equal polish
//   "system" follows prefers-color-scheme
//
// The class on <html> is applied by the no-FOUC inline script in layout.tsx
// before first paint; this store keeps React in sync with the external DOM
// state via useSyncExternalStore (subscription to `acp-theme-change` +
// OS-scheme changes) and dispatches the event so canvas effects re-tint.
// ─────────────────────────────────────────────────────────────────────────────

export type ThemePreference = "dark" | "light" | "system";

const STORAGE_KEY = "acp-ai:theme";
export const THEME_CHANGE_EVENT = "acp-theme-change";

function storedPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "dark";
  } catch {
    return "dark";
  }
}

/** Resolve a preference to the concrete class to put on <html>. */
function resolveClass(pref: ThemePreference): "light" | "dark" {
  if (pref === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return pref;
}

/** Read the CURRENT effective theme ("light" | "dark") from <html> classes. */
export function effectiveTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

/** RGB triplet (e.g. "139, 61, 242") for the active theme's particle color. */
export function themeParticleRgb(): string {
  if (typeof document === "undefined") return "255, 255, 255";
  return getComputedStyle(document.documentElement).getPropertyValue("--canvas-particle").trim() || "255, 255, 255";
}

/** Snapshot for useSyncExternalStore: css color of the active particle tint. */
function particleColorSnapshot(): string {
  return `rgb(${themeParticleRgb()})`;
}

/** External-store subscription: theme swaps + OS scheme flips (while "system"). */
function subscribeTheme(onChange: () => void): () => void {
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  const onScheme = () => {
    // Only re-resolve when the user's preference delegates to the OS.
    if (storedPreference() === "system") {
      const cls = resolveClass("system");
      const root = document.documentElement;
      root.classList.remove("light", "dark");
      root.classList.add(cls);
      window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { theme: cls, preference: "system", source: "system" } }));
    }
    onChange();
  };
  mq.addEventListener("change", onScheme);
  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, onChange);
    mq.removeEventListener("change", onScheme);
  };
}

export function applyTheme(pref: ThemePreference, source: "user" | "system" = "user"): "light" | "dark" {
  const cls = resolveClass(pref);
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(cls);
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* private mode — session-only theme */
  }
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { theme: cls, preference: pref, source } }));
  return cls;
}

export function useTheme() {
  const preference = useSyncExternalStore(subscribeTheme, storedPreference, () => "dark" as ThemePreference);
  const theme = useSyncExternalStore(subscribeTheme, effectiveTheme, () => "dark" as "light" | "dark");

  const setPreference = useCallback((next: ThemePreference) => {
    applyTheme(next);
  }, []);

  /** Quick toggle used by the navbar Sun/Moon button. */
  const toggle = useCallback(() => {
    applyTheme(effectiveTheme() === "dark" ? "light" : "dark");
  }, []);

  return { preference, theme, setPreference, toggle };
}

/** Themed canvas particle color for sparkle/star effects (fixed override supported). */
export function useThemedParticleColor(fixed?: string): string {
  const themed = useSyncExternalStore(subscribeTheme, particleColorSnapshot, () => "#FFFFFF");
  return fixed ?? themed;
}
