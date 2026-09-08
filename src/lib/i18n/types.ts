export type Language = "en" | "ja" | "ko" | "zh";

export const LANGUAGES: { code: Language; label: string; flag: string }[] = [
  { code: "en", label: "English", flag: "🇬🇧" },
  { code: "ja", label: "日本語", flag: "🇯🇵" },
  { code: "ko", label: "한국어", flag: "🇰🇷" },
  { code: "zh", label: "中文", flag: "🇨🇳" },
];

// Single source of truth: the key union is DERIVED from the en dictionary
// instead of being hand-maintained. Previously a 300-line literal union that
// silently drifted from the dictionaries whenever keys were added (new keys
// failed to type-check in components until the union was manually updated).
// ja/ko/zh keep their `Record<TranslationKey, string>` annotations, which
// now double as the compile-time parity check against en.
//
// NOTE: this is a type-only dependency — en.ts imports nothing but types
// from this file, so there is no runtime import cycle.
import { en } from "./en";

export type TranslationKey = keyof typeof en;

export type TranslationDict = Record<TranslationKey, string>;
