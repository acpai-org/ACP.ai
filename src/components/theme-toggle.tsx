"use client";

import { motion, AnimatePresence } from "motion/react";
import { Sun, Moon } from "lucide-react";
import { useTheme } from "@/lib/use-theme";
import { useI18n } from "@/lib/i18n";

/**
 * Quick Sun/Moon toggle for the navbar. Cycles light ↔ dark directly (a
 * "system" preference resolves on click to the opposite of the effective
 * theme). The full System/Light/Dark selector lives in Settings → Appearance.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle, preference } = useTheme();
  const { t } = useI18n();
  const switchLabel =
    theme === "dark" ? t("settings.themeSwitchLight") : t("settings.themeSwitchDark");

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={switchLabel}
      title={switchLabel}
      className={
        className ??
        "relative flex h-11 w-11 items-center justify-center rounded-xl text-muted transition-colors duration-200 hover:bg-foreground/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      }
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={theme + (preference ?? "")}
          initial={{ rotate: -60, opacity: 0, scale: 0.7 }}
          animate={{ rotate: 0, opacity: 1, scale: 1 }}
          exit={{ rotate: 60, opacity: 0, scale: 0.7 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
          className="flex items-center justify-center"
        >
          {theme === "dark" ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
