"use client";

/**
 * Locale-aware formatting helpers.
 *
 * The legacy `timeAgo`/`timeUntil` in format.ts emit English-only strings
 * ("2h ago"), which leaked English into ko/zh/ja UI (notifications,
 * payments, contacts, recurring, chat). `useFormatters()` returns a stable
 * formatter bundle built with Intl.RelativeTimeFormat for the active
 * language.
 *
 * Bundles are cached per language at module level, mirroring the makeT
 * identity strategy in lib/i18n: the returned object (and its function
 * identities) change exactly when the language changes, so React Compiler
 * memoization of call sites — `fmt.timeAgo(ts)` — invalidates precisely
 * when the output language changes and never on unrelated re-renders.
 */

import { useI18n } from "@/lib/i18n";
import type { Language } from "@/lib/i18n/types";

const LOCALE: Record<Language, string> = {
  en: "en",
  ja: "ja-JP",
  ko: "ko-KR",
  zh: "zh-CN",
};

export interface Formatters {
  /** "5m ago" / "5분 전" / "5分钟前" — relative time in the past */
  timeAgo: (ts: number) => string;
  /** "in 5m" / "5분 후" / "5分钟后" — relative time in the future */
  timeUntil: (ts: number) => string;
  /** Locale date+time, e.g. tooltips and detail rows */
  formatFullDate: (ts: number) => string;
  /** Locale clock time for chat message timestamps */
  formatTime: (ts: number) => string;
  /** Locale day label ("Mon, Jan 12") — notification day-group headers */
  formatDay: (ts: number) => string;
}

const MIN = 60_000;
const HR = 3_600_000;
const DAY = 86_400_000;

function makeFormatters(lang: Language): Formatters {
  const locale = LOCALE[lang];
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

  function relative(diff: number): string {
    const past = diff <= 0;
    const abs = Math.abs(diff);
    if (abs < MIN) return rtf.format(past ? 0 : 0, "second");
    if (abs < HR) return rtf.format(Math.round(diff / MIN), "minute");
    if (abs < DAY) return rtf.format(Math.round(diff / HR), "hour");
    return rtf.format(Math.round(diff / DAY), "day");
  }

  return {
    timeAgo: (ts) => relative(ts - Date.now()),
    timeUntil: (ts) => relative(ts - Date.now()),
    formatFullDate: (ts) =>
      new Date(ts).toLocaleString(locale, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    formatTime: (ts) =>
      new Date(ts).toLocaleTimeString(locale, {
        hour: "2-digit",
        minute: "2-digit",
      }),
    formatDay: (ts) =>
      new Date(ts).toLocaleDateString(locale, {
        weekday: "short",
        month: "short",
        day: "numeric",
      }),
  };
}

const CACHE = new Map<Language, Formatters>([
  ["en", makeFormatters("en")],
  ["ja", makeFormatters("ja")],
  ["ko", makeFormatters("ko")],
  ["zh", makeFormatters("zh")],
]);

export function useFormatters(): Formatters {
  const { language } = useI18n();
  return CACHE.get(language) ?? CACHE.get("en")!;
}
