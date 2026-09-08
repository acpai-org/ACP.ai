"use client";

import { useState, useCallback, useMemo } from "react";
import { Settings, Globe, Shield, Sliders, Wallet, Check, Brain, Eye, EyeOff, Palette, Zap, MessagesSquare, Type } from "lucide-react";
import Link from "next/link";
import { PageContainer } from "@/components/page-container";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { FontSelector } from "@/components/font-selector";
import { AttestcoinSettingsCard } from "@/components/attestcoin-settings-card";
import { DeployPolicyCard } from "@/components/deploy-policy-card";
import { SkillLibrary } from "@/components/skill-library";
import { ThemeSelector } from "@/components/theme-selector";
import { AutomationRulesCard } from "@/components/automation-rules-card";
import { PresetChips, TestConnectionButton } from "@/components/ai/provider-form-widgets";
import { formatSamplingValue } from "@/lib/ai/provider-presets";
import { useProviderModels } from "@/lib/ai/use-provider-models";
import dynamic from "next/dynamic";
import { useAiProvider, type AiProviderConfig } from "@/lib/ai/provider-store";
import { useI18n } from "@/lib/i18n";

// Client-only: uses the wagmi useChainId hook (needs the browser-only
// Web3Provider). Keeping it dynamic keeps wagmi out of this page's server
// bundle — the whole rest of the settings page still SSRs.
const ActiveNetworkDesc = dynamic(
  () => import("@/components/active-network-desc").then((m) => m.ActiveNetworkDesc),
  { ssr: false, loading: () => <span className="text-xs text-muted-2">…</span> },
);

function SettingRow({
  icon,
  label,
  description,
  children,
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  description: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
          {icon}
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-xs text-muted-2">{description}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

export default function SettingsPage() {
  const { t } = useI18n();
  const { config: aiConfig, setConfig: setAiConfig, configured: aiConfigured } = useAiProvider();
  const [showAiKey, setShowAiKey] = useState(false);
  const [aiSaved, setAiSaved] = useState(false);
  const [localAi, setLocalAi] = useState<AiProviderConfig>(aiConfig);
  const [lastAiConfig, setLastAiConfig] = useState<AiProviderConfig>(aiConfig);
  if (aiConfig !== lastAiConfig) {
    setLastAiConfig(aiConfig);
    setLocalAi(aiConfig);
  }
  // C28: live model suggestions for the model combobox (datalist) — fetched
  // from the user's endpoint through the /api/models pass-through.
  const { models: aiModels } = useProviderModels(localAi.baseUrl, localAi.apiKey);
  const modelSuggestions = useMemo(() => aiModels.slice(0, 200), [aiModels]);

  // C28 float fix: parse with clamp + 2-decimal snap (the old
  // `parseFloat(...) || 0` swallowed NaN AND left float dust in display).
  const parseSampling = useCallback((raw: string, min: number, max: number, step: number): number => {
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) return min;
    const clamped = Math.min(max, Math.max(min, v));
    const stepped = Math.round(clamped / step) * step;
    return Math.round(stepped * 100) / 100;
  }, []);

  const handleAiSave = useCallback(() => {
    setAiConfig(localAi);
    setAiSaved(true);
    setTimeout(() => setAiSaved(false), 2000);
  }, [localAi, setAiConfig]);

  const canSaveAi = localAi.apiKey.length > 0;

  return (
    <PageContainer
      title={t("settings.title")}
      description={t("settings.desc")}
      icon={<Settings className="h-5 w-5" />}
    >
      <Card>
        <div className="mb-2 flex items-center gap-2">
          <Palette className="h-4 w-4 text-muted" />
          <h2 className="text-sm font-semibold text-foreground">{t("settings.appearance")}</h2>
        </div>
        <div className="divide-y divide-border">
          <SettingRow
            icon={<Palette className="h-4 w-4" />}
            label={t("settings.theme")}
            description={t("settings.themeDesc")}
          >
            <div className="w-full sm:w-64">
              <ThemeSelector />
            </div>
          </SettingRow>
          <SettingRow
            icon={<Type className="h-4 w-4" />}
            label={t("settings.font")}
            description={t("settings.fontDesc")}
          >
            <div className="w-full sm:w-64">
              <FontSelector />
            </div>
          </SettingRow>
        </div>
      </Card>

      <Card>
        <div className="mb-2 flex items-center gap-2">
          <Brain className="h-4 w-4 text-muted" />
          <h2 className="text-sm font-semibold text-foreground">{t("settings.aiProvider")}</h2>
          {aiConfigured ? (
            <span className="ml-auto rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">
              {t("settings.connected")}
            </span>
          ) : (
            <span className="ml-auto rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">
              {t("settings.notConfigured")}
            </span>
          )}
        </div>

        <div className="divide-y divide-border">
          <div className="py-3">
            <PresetChips config={localAi} onChange={(next) => setLocalAi(next)} />
          </div>

          <SettingRow
            icon={<Globe className="h-4 w-4" />}
            label={t("settings.apiBaseUrl")}
            description={t("settings.apiBaseUrlDesc")}
          >
            <input
              type="url"
              value={localAi.baseUrl}
              onChange={(e) => setLocalAi({ ...localAi, baseUrl: e.target.value })}
              placeholder="https://api.openai.com/v1"
              className="w-44 rounded-lg border border-border bg-surface-2/50 px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-3 focus:border-primary/50 focus:outline-none font-mono"
            />
          </SettingRow>

          <SettingRow
            icon={<Shield className="h-4 w-4" />}
            label={t("settings.apiKey")}
            description={t("settings.apiKeyDesc")}
          >
            <div className="relative">
              <input
                type={showAiKey ? "text" : "password"}
                value={localAi.apiKey}
                onChange={(e) => setLocalAi({ ...localAi, apiKey: e.target.value })}
                placeholder="sk-..."
                className="w-44 rounded-lg border border-border bg-surface-2/50 px-2.5 py-1.5 pr-9 text-xs text-foreground placeholder:text-muted-3 focus:border-primary/50 focus:outline-none font-mono"
              />
              <button
                type="button"
                onClick={() => setShowAiKey(!showAiKey)}
                className="hit-slop absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-2 transition-colors hover:bg-surface-3 hover:text-foreground"
                aria-label={showAiKey ? t("settings.hide") : t("settings.show")}
              >
                {showAiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </SettingRow>

          <SettingRow
            icon={<Sliders className="h-4 w-4" />}
            label={t("settings.model")}
            description={t("settings.modelDesc")}
          >
            <div className="relative">
              <input
                type="text"
                list="ai-model-suggestions"
                value={localAi.model}
                onChange={(e) => setLocalAi({ ...localAi, model: e.target.value })}
                placeholder="provider/modelname"
                className="w-44 rounded-lg border border-border bg-surface-2/50 px-2.5 py-1.5 pr-7 text-xs text-foreground placeholder:text-muted-3 focus:border-primary/50 focus:outline-none font-mono"
              />
              <Zap className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-3" aria-hidden />
              <datalist id="ai-model-suggestions">
                {modelSuggestions.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
          </SettingRow>

          <SettingRow
            icon={<Sliders className="h-4 w-4" />}
            label={t("settings.temperature")}
            description={t("settings.temperatureDesc")}
          >
            <input
              type="number"
              step={0.1}
              min={0}
              max={2}
              value={formatSamplingValue(localAi.temperature)}
              onChange={(e) => setLocalAi({ ...localAi, temperature: parseSampling(e.target.value, 0, 2, 0.1) })}
              className="w-44 rounded-lg border border-border bg-surface-2/50 px-2.5 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none font-mono tabular-nums"
            />
          </SettingRow>

          <SettingRow
            icon={<Sliders className="h-4 w-4" />}
            label={t("settings.topP")}
            description={t("settings.topPDesc")}
          >
            <input
              type="number"
              step={0.05}
              min={0}
              max={1}
              value={formatSamplingValue(localAi.topP)}
              onChange={(e) => setLocalAi({ ...localAi, topP: parseSampling(e.target.value, 0, 1, 0.05) })}
              className="w-44 rounded-lg border border-border bg-surface-2/50 px-2.5 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none font-mono tabular-nums"
            />
          </SettingRow>

          <SettingRow
            icon={<Sliders className="h-4 w-4" />}
            label={t("settings.maxTokens")}
            description={t("settings.maxTokensDesc")}
          >
            <input
              type="number"
              value={localAi.maxTokens ?? ""}
              onChange={(e) =>
                setLocalAi({ ...localAi, maxTokens: e.target.value === "" ? null : parseInt(e.target.value, 10) })
              }
              placeholder="auto"
              className="w-44 rounded-lg border border-border bg-surface-2/50 px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-3 focus:border-primary/50 focus:outline-none font-mono"
            />
          </SettingRow>

          <SettingRow
            icon={<Brain className="h-4 w-4" />}
            label={t("settings.showThinking")}
            description={t("settings.showThinkingDesc")}
          >
            <Toggle
              checked={localAi.showThinking}
              onChange={() => setLocalAi({ ...localAi, showThinking: !localAi.showThinking })}
            />
          </SettingRow>

          <SettingRow
            icon={<MessagesSquare className="h-4 w-4" />}
            label={t("settings.contextLength")}
            description={t("settings.contextLengthDesc")}
          >
            <select
              value={localAi.contextMessages ?? ""}
              onChange={(e) =>
                setLocalAi({ ...localAi, contextMessages: e.target.value === "" ? null : parseInt(e.target.value, 10) })
              }
              className="w-44 rounded-lg border border-border bg-surface-2/50 px-2.5 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none font-mono"
              aria-label={t("settings.contextLength")}
            >
              <option value="">{t("settings.contextFull")}</option>
              {[50, 20, 10].map((n) => (
                <option key={n} value={n}>
                  {t("settings.contextLast", { count: String(n) })}
                </option>
              ))}
            </select>
          </SettingRow>
        </div>

        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={handleAiSave} disabled={!canSaveAi}>
              {aiSaved ? (
                <>
                  <Check className="h-3.5 w-3.5" /> {t("settings.saved")}
                </>
              ) : (
                t("settings.saveAi")
              )}
            </Button>
            <p className="text-[10px] text-muted-3">{t("settings.keyLocalNote")}</p>
          </div>
          <div className="sm:ml-auto sm:w-56">
            <TestConnectionButton config={localAi} />
          </div>
        </div>
      </Card>

      <Card>
        <div className="mb-2 flex items-center gap-2">
          <Wallet className="h-4 w-4 text-muted" />
          <h2 className="text-sm font-semibold text-foreground">{t("settings.network")}</h2>
        </div>
        <div className="divide-y divide-border">
          <SettingRow
            icon={<Globe className="h-4 w-4" />}
            label={t("settings.activeNetwork")}
            description={<ActiveNetworkDesc />}
          >
            <Link href="/wallet">
              <Button variant="secondary" size="sm">{t("settings.manage")}</Button>
            </Link>
          </SettingRow>
        </div>
      </Card>

      <AttestcoinSettingsCard />

      <DeployPolicyCard />
      <SkillLibrary />
      <AutomationRulesCard />
    </PageContainer>
  );
}
