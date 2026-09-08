"use client";

import type { AiProviderConfig } from "@/lib/ai/provider-store";

// ─────────────────────────────────────────────────────────────────────────────
// Provider presets + connection test (C28). Presets are pure URL/model
// quick-fills — the API key is never touched. The test POSTs a 1-token ping
// through our pass-through route (/api/agent/test-connection), which relays it
// to the USER'S endpoint; the key is never logged or persisted server-side.
// ─────────────────────────────────────────────────────────────────────────────

export interface ProviderPreset {
  id: string;
  /** i18n key for the visible label */
  labelKey: string;
  baseUrl: string;
  /** Short host hint shown under the chip */
  host: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openai",
    labelKey: "aiprovider.presetOpenAI",
    baseUrl: "https://api.openai.com/v1",
    host: "api.openai.com",
  },
  {
    id: "openrouter",
    labelKey: "aiprovider.presetOpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    host: "openrouter.ai",
  },
  {
    id: "groq",
    labelKey: "aiprovider.presetGroq",
    baseUrl: "https://api.groq.com/openai/v1",
    host: "api.groq.com",
  },
  {
    id: "together",
    labelKey: "aiprovider.presetTogether",
    baseUrl: "https://api.together.xyz/v1",
    host: "api.together.xyz",
  },
  {
    id: "ollama",
    labelKey: "aiprovider.presetOllama",
    baseUrl: "http://localhost:11434/v1",
    host: "localhost:11434",
  },
];

/** Apply a preset to a config draft: fills the base URL only (N1: presets
 * never pick a model — the user chooses, in provider/modelname form). */
export function applyPreset(config: AiProviderConfig, preset: ProviderPreset): AiProviderConfig {
  return { ...config, baseUrl: preset.baseUrl };
}

export type TestConnectionCode =
  | "ok"
  | "invalid-key"
  | "bad-url-or-model"
  | "rate-limited"
  | "provider-error"
  | "timeout"
  | "unreachable"
  | "missing-fields"
  | "bad-request";

export interface TestConnectionResult {
  ok: boolean;
  code: TestConnectionCode;
  error: string | null;
}

/** Round-trip a 1-token ping through our pass-through route. */
export async function testProviderConnection(config: AiProviderConfig): Promise<TestConnectionResult> {
  try {
    const res = await fetch("/api/agent/test-connection", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
      }),
      cache: "no-store",
    });
    const data = (await res.json()) as Partial<TestConnectionResult>;
    return {
      ok: data.ok === true,
      code: (data.code ?? "bad-request") as TestConnectionCode,
      error: data.error ?? null,
    };
  } catch (err) {
    return {
      ok: false,
      code: "unreachable",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Float hygiene (the 0.699999988079071 bug) ──────────────────────────────
// Slider/number values round-tripped through JSON can carry float dust. Every
// read and write normalizes to 2 decimals so displays stay clean.

export function normalizeSampling(config: AiProviderConfig): AiProviderConfig {
  return {
    ...config,
    temperature: clampRound(config.temperature, 0, 2, 0.1),
    topP: clampRound(config.topP, 0, 1, 0.05),
    maxTokens:
      config.maxTokens != null && Number.isFinite(config.maxTokens) && config.maxTokens > 0
        ? Math.round(config.maxTokens)
        : null,
  };
}

function clampRound(v: number, min: number, max: number, step: number): number {
  if (!Number.isFinite(v)) return min;
  const clamped = Math.min(max, Math.max(min, v));
  const stepped = Math.round(clamped / step) * step;
  return Math.round(stepped * 100) / 100;
}

/** Pretty-print a sampling value for display (2 decimals, no trailing zeros). */
export function formatSamplingValue(v: number): string {
  return String(Math.round(v * 100) / 100);
}
