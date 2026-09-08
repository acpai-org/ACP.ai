"use client";

import { useState, useCallback, useRef, useEffect, startTransition } from "react";
import { createPortal } from "react-dom";
import { Check, Eye, EyeOff, Cpu } from "lucide-react";

import { useAiProvider, type AiProviderConfig } from "@/lib/ai/provider-store";
import { formatSamplingValue } from "@/lib/ai/provider-presets";
import { PresetChips, TestConnectionButton } from "@/components/ai/provider-form-widgets";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// AiProviderButton: the chat composer's quick provider panel. Custom BYOK
// provider only (C27 — the Built-in mode was removed). Mobile fix (C34):
// the panel is clamped inside the viewport and scrolls instead of clipping
// off-screen at narrow widths.
// ─────────────────────────────────────────────────────────────────────────────

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <label className="text-xs text-muted-2">{label}</label>
        {/* Float-dust fix: always render the 2-decimal snapped value. */}
        <span className="font-mono text-xs text-foreground tabular-nums">{formatSamplingValue(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="mt-1 w-full accent-primary"
      />
    </div>
  );
}

export function AiProviderButton() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [panelPos, setPanelPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const { config, configured, setConfig, resetConfig } = useAiProvider();
  const [local, setLocal] = useState<AiProviderConfig>(config);
  const [lastConfig, setLastConfig] = useState<AiProviderConfig>(config);
  if (config !== lastConfig) {
    setLastConfig(config);
    setLocal(config);
  }

  useEffect(() => { startTransition(() => setMounted(true)); }, []);

  useEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setPanelPos({
      top: rect.top - 8,
      right: window.innerWidth - rect.right,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current && btnRef.current.contains(target)) return;
      if (panelRef.current && panelRef.current.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleSave = useCallback(() => {
    setConfig(local);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, [local, setConfig]);

  const handleReset = useCallback(() => {
    resetConfig();
    setLocal(config);
  }, [resetConfig, config]);

  const isConfigured = mounted && configured;
  const canSave = local.apiKey.length > 0;

  const panel = open
    ? createPortal(
        <div
          ref={panelRef}
          className="fixed z-[200] w-[min(22rem,calc(100vw-1.5rem))] max-h-[calc(100vh-1rem)] overflow-y-auto"
          style={{
            bottom: Math.min(window.innerHeight - panelPos.top, window.innerHeight - 8),
            right: Math.max(panelPos.right, 8),
          }}
        >
          <div className="glass-dropdown rounded-2xl p-4 space-y-3 shadow-2xl border border-border/60">
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <Cpu className="h-4 w-4 text-primary" /> {t("aiprovider.title")}
              </h3>
              {isConfigured ? (
                <span className="flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">
                  <Check className="h-2.5 w-2.5" /> {t("settings.connected")}
                </span>
              ) : (
                <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">
                  {t("settings.notConfigured")}
                </span>
              )}
            </div>

            <div className="space-y-2">
              <PresetChips config={local} onChange={(next) => setLocal(next)} />

              <div>
                <label className="text-xs text-muted-2">{t("settings.apiBaseUrl")}</label>
                <input
                  type="url"
                  value={local.baseUrl}
                  onChange={(e) => setLocal({ ...local, baseUrl: e.target.value })}
                  placeholder="https://api.openai.com/v1"
                  className="mt-1 w-full rounded-xl border border-border bg-surface-2/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-3 focus:border-primary/50 focus:outline-none"
                />
              </div>

              <div>
                <label className="text-xs text-muted-2">{t("settings.apiKey")}</label>
                <div className="relative mt-1">
                  <input
                    type={showKey ? "text" : "password"}
                    value={local.apiKey}
                    onChange={(e) => setLocal({ ...local, apiKey: e.target.value })}
                    placeholder="sk-..."
                    className="w-full rounded-xl border border-border bg-surface-2/50 px-3 py-2 pr-9 text-sm text-foreground placeholder:text-muted-3 focus:border-primary/50 focus:outline-none font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-2 hover:text-foreground"
                    aria-label={showKey ? t("settings.hide") : t("settings.show")}
                  >
                    {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="text-xs text-muted-2">{t("settings.model")}</label>
                <input
                  type="text"
                  value={local.model}
                  onChange={(e) => setLocal({ ...local, model: e.target.value })}
                  placeholder="provider/modelname"
                  className="mt-1 w-full rounded-xl border border-border bg-surface-2/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-3 focus:border-primary/50 focus:outline-none font-mono"
                />
              </div>
            </div>

            <div className="space-y-3 border-t border-border/50 pt-3">
              <Slider
                label={t("settings.temperature")}
                value={local.temperature}
                min={0}
                max={2}
                step={0.1}
                onChange={(v) => setLocal({ ...local, temperature: v })}
              />
              <Slider
                label={t("settings.topP")}
                value={local.topP}
                min={0}
                max={1}
                step={0.05}
                onChange={(v) => setLocal({ ...local, topP: v })}
              />
              <div>
                <label className="text-xs text-muted-2">{t("aiprovider.maxTokensLabel")}</label>
                <input
                  type="number"
                  value={local.maxTokens ?? ""}
                  onChange={(e) =>
                    setLocal({ ...local, maxTokens: e.target.value === "" ? null : parseInt(e.target.value, 10) })
                  }
                  placeholder="auto"
                  className="mt-1 w-full rounded-xl border border-border bg-surface-2/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-3 focus:border-primary/50 focus:outline-none font-mono"
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button variant="primary" size="sm" onClick={handleSave} disabled={!canSave} className="flex-1">
                {saved ? (
                  <>
                    <Check className="h-3.5 w-3.5" /> {t("aiprovider.saved")}
                  </>
                ) : (
                  t("aiprovider.save")
                )}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleReset}>
                {t("aiprovider.reset")}
              </Button>
            </div>

            <TestConnectionButton config={local} />

            <p className="text-[10px] text-muted-3 leading-relaxed">{t("aiprovider.note")}</p>
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-all duration-200",
          isConfigured
            ? "bg-primary/15 text-primary ring-1 ring-primary/30 hover:bg-primary/25 hover:ring-primary/40"
            : "bg-warning/10 text-warning ring-1 ring-warning/30 hover:bg-warning/20 hover:ring-warning/40",
        )}
        title={isConfigured ? t("aiprovider.titleConnected") : t("aiprovider.titleNotConfigured")}
        aria-expanded={open}
      >
        <Cpu className="h-[18px] w-[18px]" />
      </button>
      {panel}
    </>
  );
}
