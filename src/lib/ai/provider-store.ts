"use client";

import { create } from "zustand";
import { normalizeSampling } from "@/lib/ai/provider-presets";

// ─────────────────────────────────────────────────────────────────────────────
// Provider store (Phase 3): only the user-configured OpenAI-compatible
// provider exists (C27 removed the Built-in mode). The key lives in the
// browser's localStorage, is sent per-request to the user's own endpoint,
// and is never persisted server-side or logged.
// ─────────────────────────────────────────────────────────────────────────────

export interface AiProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  topP: number;
  maxTokens: number | null;
  /** N26: render the model's streamed reasoning blocks in chat. */
  showThinking: boolean;
  /** N26: cap on past messages sent as request history (null = full). */
  contextMessages: number | null;
}

const STORAGE_KEY = "acp-ai:ai-provider";
const LEGACY_STORAGE_KEY = "hsk-ai:ai-provider";

export const DEFAULT_PROVIDER: AiProviderConfig = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "",
  temperature: 0.7,
  topP: 1,
  maxTokens: null,
  showThinking: false,
  contextMessages: null,
};

function loadConfig(): AiProviderConfig {
  if (typeof window === "undefined") return { ...DEFAULT_PROVIDER };
  try {
    // Migrate the pre-rebrand storage key once, then read the new one.
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy && !localStorage.getItem(STORAGE_KEY)) {
      localStorage.setItem(STORAGE_KEY, legacy);
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<AiProviderConfig>;
      // normalizeSampling: JSON round-trips can carry float dust
      // (0.699999988079071) — every read snaps values back to the grid.
      return normalizeSampling({
        baseUrl: p.baseUrl ?? DEFAULT_PROVIDER.baseUrl,
        apiKey: p.apiKey ?? "",
        model: p.model ?? DEFAULT_PROVIDER.model,
        temperature: typeof p.temperature === "number" ? p.temperature : DEFAULT_PROVIDER.temperature,
        topP: typeof p.topP === "number" ? p.topP : DEFAULT_PROVIDER.topP,
        maxTokens: typeof p.maxTokens === "number" ? p.maxTokens : null,
        showThinking: p.showThinking === true,
        contextMessages:
          typeof p.contextMessages === "number" && Number.isFinite(p.contextMessages) && p.contextMessages > 0
            ? Math.round(p.contextMessages)
            : null,
      });
    }
  } catch {}
  return { ...DEFAULT_PROVIDER };
}

function saveConfig(config: AiProviderConfig) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

/** The chat can send requests when a custom key is set. */
export function isProviderUsable(config: AiProviderConfig): boolean {
  return config.apiKey.length > 0;
}

interface AiProviderStore {
  config: AiProviderConfig;
  configured: boolean;
  setConfig: (config: AiProviderConfig) => void;
  resetConfig: () => void;
}

export const useAiProvider = create<AiProviderStore>((set) => ({
  config: loadConfig(),
  configured: isProviderUsable(loadConfig()),
  setConfig: (config) => {
    // Snap sampling values to the grid before persisting (float-dust fix).
    const clean = normalizeSampling(config);
    saveConfig(clean);
    set({ config: clean, configured: isProviderUsable(clean) });
  },
  resetConfig: () => {
    saveConfig({ ...DEFAULT_PROVIDER });
    set({ config: { ...DEFAULT_PROVIDER }, configured: isProviderUsable(DEFAULT_PROVIDER) });
  },
}));
