"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type ThemePreference } from "@/lib/use-theme";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const OPTIONS: Array<{
  value: ThemePreference;
  icon: typeof Sun;
  labelKey: "settings.themeSystem" | "settings.themeLight" | "settings.themeDark";
}> = [
  { value: "system", icon: Monitor, labelKey: "settings.themeSystem" },
  { value: "light", icon: Sun, labelKey: "settings.themeLight" },
  { value: "dark", icon: Moon, labelKey: "settings.themeDark" },
];

/**
 * System / Light / Dark segmented control (Settings → Appearance). The
 * preference persists to localStorage and applies instantly — the navbar
 * Sun/Moon button is the quick toggle, this is the explicit selector.
 */
export function ThemeSelector() {
  const { t } = useI18n();
  const { preference, setPreference } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label={t("settings.theme")}
      // S12-a (round-7 styling): the Toggle's verified-visible track recipe
      // (bg-foreground/10 + inset ring-foreground/25) — the previous
      // border-border/bg-surface-2 treatment is #1c1c1c on #121212, invisible
      // at this scale in dark mode (same fix the FontSelector got in S11-b).
      className="grid grid-cols-[1.3fr_1fr_1fr] gap-1 rounded-xl bg-foreground/10 p-1 ring-1 ring-inset ring-foreground/25"
    >
      {OPTIONS.map((opt) => {
        const Icon = opt.icon;
        const selected = preference === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setPreference(opt.value)}
            title={opt.value === "system" ? t("settings.themeSystemDesc") : undefined}
            className={cn(
              "flex min-h-9 items-center justify-center gap-1.5 rounded-lg px-1.5 py-2 text-xs font-medium transition-all duration-200 min-w-0",
              selected
                ? "bg-primary/15 text-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                : "text-muted hover:bg-foreground/5 hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            <span className="truncate">{t(opt.labelKey)}</span>
          </button>
        );
      })}
    </div>
  );
}
