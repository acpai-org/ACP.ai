"use client";

import { useEffect } from "react";
import { Type } from "lucide-react";
import { useFontStore, loadFontPrefs, applyFontPrefs, type FontFamily, type FontScale } from "@/lib/use-font";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// FontSelector (C15): family (Geist / System) + size (S / M / L) segmented
// controls. Reads the persisted prefs on mount (the inline bootstrap already
// applied them before paint; this syncs the store) and writes through the
// store — which applies to <html> instantly and persists.
// ─────────────────────────────────────────────────────────────────────────────

const FAMILIES: Array<{ value: FontFamily; key: "settings.fontGeist" | "settings.fontSystem" }> = [
  { value: "geist", key: "settings.fontGeist" },
  { value: "system", key: "settings.fontSystem" },
];

const SIZES: Array<{ value: FontScale; key: "settings.fontS" | "settings.fontM" | "settings.fontL" }> = [
  { value: 0.9, key: "settings.fontS" },
  { value: 1, key: "settings.fontM" },
  { value: 1.1, key: "settings.fontL" },
];

export function FontSelector() {
  const { t } = useI18n();
  const prefs = useFontStore((s) => s.prefs);
  const setPrefs = useFontStore((s) => s.setPrefs);

  // Hydrate the store from persisted prefs (applying is idempotent — the
  // inline bootstrap already did it; this covers store/storeless first paint).
  useEffect(() => {
    const stored = loadFontPrefs();
    applyFontPrefs(stored);
    useFontStore.setState({ prefs: stored });
  }, []);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div
        role="radiogroup"
        aria-label={t("settings.fontFamily")}
        className="flex items-center gap-0.5 rounded-xl bg-surface-2/60 p-0.5"
      >
        {FAMILIES.map((f) => (
          <button
            key={f.value}
            type="button"
            role="radio"
            aria-checked={prefs.family === f.value}
            onClick={() => setPrefs({ ...prefs, family: f.value })}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60",
              prefs.family === f.value
                ? "bg-primary/15 text-primary"
                : "text-muted hover:text-foreground",
            )}
          >
            <Type className="h-3 w-3" aria-hidden />
            {t(f.key)}
          </button>
        ))}
      </div>
      <div
        role="radiogroup"
        aria-label={t("settings.fontSize")}
        className="flex items-center gap-0.5 rounded-xl bg-surface-2/60 p-0.5"
      >
        {SIZES.map((s) => (
          <button
            key={s.value}
            type="button"
            role="radio"
            aria-checked={prefs.scale === s.value}
            onClick={() => setPrefs({ ...prefs, scale: s.value })}
            className={cn(
              "min-w-8 rounded-lg px-2 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60",
              prefs.scale === s.value
                ? "bg-primary/15 text-primary"
                : "text-muted hover:text-foreground",
            )}
          >
            {t(s.key)}
          </button>
        ))}
      </div>
    </div>
  );
}
