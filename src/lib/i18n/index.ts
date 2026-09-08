"use client";

import { create } from "zustand";
import { en } from "./en";
import { ja } from "./ja";
import { ko } from "./ko";
import { zh } from "./zh";
import type { Language, TranslationKey, TranslationDict } from "./types";

export type { TranslationKey } from "./types";

const STORAGE_KEY = "acp-ai:language";
const LEGACY_STORAGE_KEY = "hsk-ai:language";

const DICTIONARIES: Record<Language, TranslationDict> = { en, ja, ko, zh };

const LANG_PREFIXES: Array<[Language, string]> = [
  ["ja", "ja"],
  ["ko", "ko"],
  ["zh", "zh"],
];

function isLanguage(raw: string | null): raw is Language {
  return raw === "en" || raw === "ja" || raw === "ko" || raw === "zh";
}

function detectLanguage(): Language {
  if (typeof window === "undefined") return "en";
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    if (isLanguage(raw)) return raw;
  } catch {}
  const browserLang = typeof navigator !== "undefined" ? navigator.language.toLowerCase() : "";
  for (const [code, prefix] of LANG_PREFIXES) {
    if (browserLang.startsWith(prefix)) return code;
  }
  return "en";
}

interface I18nStore {
  language: Language;
  hydrated: boolean;
  setLanguage: (lang: Language) => void;
  hydrate: () => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

// t is created per-language ON PURPOSE. Its identity changes whenever the
// language changes: React Compiler (enabled in next.config.ts) memoizes
// t(key, …) call results keyed on [t-identity, args]. A single stable t
// closure whose output depends on mutable store state froze every direct
// t(...) call site in English — the compiler never saw its inputs change
// after a language switch (observed: navbar re-rendered via a non-cached
// path while ChatView's whole subtree stayed English). Rebuilding t per
// language makes the memo keys invalidate exactly when translations
// actually change, so compiler caching stays correct.
function makeT(lang: Language): I18nStore["t"] {
  return (key, params) => {
    let str = DICTIONARIES[lang]?.[key] ?? DICTIONARIES.en[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        str = str.replace(`{${k}}`, String(v));
      }
    }
    return str;
  };
}

export const useI18n = create<I18nStore>((set, get) => ({
  language: "en",
  hydrated: false,
  setLanguage: (lang) => {
    if (typeof window !== "undefined") {
      try { localStorage.setItem(STORAGE_KEY, lang); } catch {}
    }
    if (typeof document !== "undefined") {
      document.documentElement.lang = lang;
    }
    set({ language: lang, t: makeT(lang) });
  },
  hydrate: () => {
    if (get().hydrated) return;
    const lang = detectLanguage();
    if (typeof document !== "undefined") {
      document.documentElement.lang = lang;
    }
    set({ language: lang, hydrated: true, t: makeT(lang) });
  },
  t: makeT("en"),
}));
