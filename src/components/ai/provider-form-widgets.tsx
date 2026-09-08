"use client";

import { useState, useCallback } from "react";
import { Loader2, CheckCircle2, XCircle, Zap } from "lucide-react";
import {
  PROVIDER_PRESETS,
  applyPreset,
  testProviderConnection,
  type TestConnectionResult,
  type ProviderPreset,
} from "@/lib/ai/provider-presets";
import type { AiProviderConfig } from "@/lib/ai/provider-store";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n/types";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Shared C28 widgets: preset quick-fill chips + the connection-test button.
// Used by BOTH the chat composer's provider panel and the settings page card
// so the two surfaces never drift.
// ─────────────────────────────────────────────────────────────────────────────

export function PresetChips({
  config,
  onChange,
}: {
  config: AiProviderConfig;
  onChange: (next: AiProviderConfig) => void;
}) {
  const { t } = useI18n();
  const active = PROVIDER_PRESETS.find((p) => p.baseUrl === config.baseUrl.replace(/\/+$/, ""));

  const apply = useCallback(
    (preset: ProviderPreset) => {
      onChange(applyPreset(config, preset));
    },
    [config, onChange],
  );

  return (
    <div>
      <label className="text-xs text-muted-2">{t("aiprovider.presetsLabel")}</label>
      <div className="mt-1.5 flex flex-wrap gap-2.5" role="group" aria-label={t("aiprovider.presetsLabel")}>
        {PROVIDER_PRESETS.map((p) => {
          const isActive = active?.id === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => apply(p)}
              title={p.host}
              aria-pressed={isActive}
              className={cn(
                "hit-slop cursor-pointer rounded-full border px-3 py-1.5 text-[11px] font-medium transition-colors min-h-9",
                isActive
                  ? "border-primary/40 bg-primary/15 text-primary"
                  : "border-border bg-surface-2/40 text-muted-2 hover:border-primary/25 hover:text-foreground",
              )}
            >
              {t(p.labelKey as TranslationKey)}
            </button>
          );
        })}
      </div>
      {active ? (
        <p className="mt-1 text-[10px] text-muted-3">{t("aiprovider.presetApplied", { host: active.host })}</p>
      ) : null}
    </div>
  );
}

export function TestConnectionButton({ config }: { config: AiProviderConfig }) {
  const { t } = useI18n();
  const [state, setState] = useState<"idle" | "testing">("idle");
  const [result, setResult] = useState<TestConnectionResult | null>(null);

  const run = useCallback(async () => {
    if (!config.baseUrl || !config.apiKey || !config.model.trim()) {
      setResult({ ok: false, code: "missing-fields", error: t("aiprovider.testNoConfig") });
      return;
    }
    setState("testing");
    setResult(null);
    const res = await testProviderConnection(config);
    setResult(res);
    setState("idle");
  }, [config, t]);

  const hasFields = config.baseUrl && config.apiKey && config.model.trim();

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={run}
        disabled={state === "testing"}
        className={cn(
          "flex min-h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium transition-colors",
          state === "testing"
            ? "border-border bg-surface-2/50 text-muted-2"
            : "border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 hover:border-primary/40",
        )}
        aria-live="polite"
      >
        {state === "testing" ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("aiprovider.testing")}
          </>
        ) : (
          <>
            <Zap className="h-3.5 w-3.5" /> {t("aiprovider.test")}
          </>
        )}
      </button>

      {result ? (
        <div
          role="status"
          className={cn(
            "flex items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed",
            result.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger",
          )}
        >
          {result.ok ? (
            <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0" />
          ) : (
            <XCircle className="mt-px h-3.5 w-3.5 shrink-0" />
          )}
          <span className="min-w-0 flex-1 break-words">
            {result.ok ? t("aiprovider.testOk") : (result.error ?? t("aiprovider.testFailed", { msg: "" }))}
          </span>
        </div>
      ) : null}

      {!hasFields ? <p className="text-[10px] text-muted-3">{t("aiprovider.testHint")}</p> : null}
    </div>
  );
}
