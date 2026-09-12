"use client";

import { useState, useRef, useEffect, useMemo, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { ChevronDown, Check, Loader2, AlertCircle, Zap, Globe, Search } from "lucide-react";
import { useProviderModels } from "@/lib/ai/use-provider-models";
import type { AiProviderConfig } from "@/lib/ai/provider-store";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface ModelPickerProps {
  config: AiProviderConfig;
  activeSessionId: string | null;
  modelOverride: string | null;
  onOverride: (sessionId: string, model: string | null) => void;
}

export function ModelPicker({ config, activeSessionId, modelOverride, onOverride }: ModelPickerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [customInput, setCustomInput] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [search, setSearch] = useState("");
  const [dropdownPos, setDropdownPos] = useState<{ left: number; bottom: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const { models, loading, error } = useProviderModels(config.baseUrl, config.apiKey);

  const effectiveModel = modelOverride ?? config.model;
  const isOverride = modelOverride !== null && modelOverride !== undefined;

  const filteredModels = useMemo(() => {
    if (!search.trim()) return models;
    const q = search.toLowerCase();
    return models.filter((m) => m.toLowerCase().includes(q));
  }, [models, search]);

  useEffect(() => {
    if (!open) return;
    // S6 fix (deferred bug #2): the dropdown is a fixed-position portal, but
    // its position was computed ONCE on open — a window resize, the mobile
    // keyboard (visualViewport), or ANY inner-container scroll (the chat
    // transcript, the sidebar) left it floating away from its trigger, and on
    // narrow screens it could overflow past the right edge entirely.
    // Recompute on all of those (rAF-throttled) and clamp to the viewport.
    const recompute = () => {
      const rect = btnRef.current?.getBoundingClientRect();
      if (!rect) return;
      const DROPDOWN_W = 320; // w-80
      const left = Math.min(rect.left, Math.max(8, window.innerWidth - DROPDOWN_W - 8));
      setDropdownPos({
        left,
        bottom: Math.max(8, window.innerHeight - rect.top + 8),
      });
    };
    recompute();
    let raf = 0;
    const scheduled = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        recompute();
      });
    };
    window.addEventListener("resize", scheduled);
    window.visualViewport?.addEventListener("resize", scheduled);
    // scroll events don't bubble — capture on window catches every inner scroller.
    window.addEventListener("scroll", scheduled, true);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", scheduled);
      window.visualViewport?.removeEventListener("resize", scheduled);
      window.removeEventListener("scroll", scheduled, true);
    };
  }, [open]);

  function handleClose() {
    setOpen(false);
    setSearch("");
    setShowCustom(false);
    setCustomInput("");
  }

  function handleSelect(model: string | null) {
    if (activeSessionId) {
      onOverride(activeSessionId, model);
    }
    handleClose();
  }

  function handleCustomSubmit() {
    const trimmed = customInput.trim();
    if (!trimmed) return;
    handleSelect(trimmed);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleCustomSubmit();
    }
  }

  const dropdown = open && dropdownPos
    ? createPortal(
        <>
          <div className="fixed inset-0 z-[400]" onMouseDown={handleClose} />
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className="glass-dropdown fixed z-[401] max-h-96 w-80 overflow-hidden rounded-2xl border border-border shadow-2xl"
            style={{ left: dropdownPos.left, bottom: dropdownPos.bottom }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex max-h-96 flex-col">
              <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-2">
                  {t("model.title")}
                </span>
                {loading ? (
                  <Loader2 className="h-3 w-3 animate-spin text-muted" />
                ) : null}
              </div>

              {models.length > 8 ? (
                <div className="border-b border-border/40 px-2 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <Search className="h-3 w-3 text-muted-2 shrink-0" />
                    <input
                      autoFocus
                      type="text"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder={t("modelPicker.filterPlaceholder")}
                      className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-3 focus:outline-none"
                    />
                  </div>
                </div>
              ) : null}

              <div className="flex-1 overflow-y-auto p-1.5" style={{ maxHeight: "300px" }}>
                <button
                  type="button"
                  onClick={() => handleSelect(null)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs transition-colors",
                    !isOverride
                      ? "bg-primary/10 text-primary"
                      : "text-muted hover:bg-surface-2/50",
                  )}
                >
                  <Globe className="h-3.5 w-3.5 shrink-0 opacity-60" />
                  <span className="flex-1 text-left">
                    <span className="font-medium">{t("model.useDefault")}</span>
                    <span className="ml-1.5 text-muted-3">({config.model})</span>
                  </span>
                  {!isOverride ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
                </button>

                {error ? (
                  <div className="mt-1 flex items-start gap-1.5 rounded-lg bg-warning/5 px-2.5 py-2 text-[11px] text-warning">
                    <AlertCircle className="h-3 w-3 shrink-0 mt-0.5" />
                    <span className="flex-1 leading-relaxed">{error}</span>
                  </div>
                ) : null}

                {loading && models.length === 0 ? (
                  <div className="flex items-center gap-2 rounded-lg px-2.5 py-3 text-xs text-muted-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t("model.fetching")}
                  </div>
                ) : null}

                {!loading && models.length === 0 && !error ? (
                  <div className="rounded-lg px-2.5 py-2 text-[11px] text-muted-2">
                    {t("model.noModels")}
                  </div>
                ) : null}

                {filteredModels.map((m) => {
                  const isSelected = isOverride && modelOverride === m;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => handleSelect(m)}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors",
                        isSelected
                          ? "bg-primary/10 text-primary"
                          : "text-muted hover:bg-surface-2/50",
                      )}
                    >
                      <Zap className={cn("h-3.5 w-3.5 shrink-0", isSelected ? "text-primary" : "opacity-40")} />
                      <span className="flex-1 truncate text-left font-mono">{m}</span>
                      {isSelected ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
                    </button>
                  );
                })}

                {search.trim() && filteredModels.length === 0 && models.length > 0 ? (
                  <div className="rounded-lg px-2.5 py-2 text-[11px] text-muted-2">
                    {t("modelPicker.noMatch", { query: search })}
                  </div>
                ) : null}

                {showCustom ? (
                  <div className="mt-1.5 flex items-center gap-1.5 rounded-lg bg-surface-2/30 px-2 py-1.5">
                    <input
                      autoFocus
                      type="text"
                      value={customInput}
                      onChange={(e) => setCustomInput(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder={t("model.customPlaceholder")}
                      className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-3 focus:outline-none font-mono"
                    />
                    <button
                      type="button"
                      onClick={handleCustomSubmit}
                      disabled={!customInput.trim()}
                      className="flex h-6 items-center gap-1 rounded-md bg-primary/15 px-2 text-[11px] font-medium text-primary transition-colors hover:bg-primary/25 disabled:opacity-40"
                    >
                      {t("model.set")}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowCustom(true)}
                    className="mt-1.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[11px] text-muted-2 transition-colors hover:bg-surface-2/50"
                  >
                    {t("model.custom")}
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        </>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
          "glass-item cursor-pointer hover:bg-surface-2/50",
          isOverride ? "text-primary" : "text-muted",
        )}
        title={
          effectiveModel
            ? isOverride
              ? t("model.overrideTitle", { model: modelOverride })
              : t("model.defaultTitle", { model: config.model })
            : t("model.noneTitle")
        }
      >
        {isOverride ? (
          <>
            <Zap className="h-3 w-3 text-primary" />
            {effectiveModel.length > 24 ? `${effectiveModel.slice(0, 22)}…` : effectiveModel}
          </>
        ) : effectiveModel ? (
          <>
            <Globe className="h-3 w-3" />
            {effectiveModel.length > 24 ? `${effectiveModel.slice(0, 22)}…` : effectiveModel}
          </>
        ) : (
          <>
            <Globe className="h-3 w-3" />
            {t("model.none")}
          </>
        )}
        <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
      </button>
      {dropdown}
    </>
  );
}
