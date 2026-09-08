"use client";

import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "motion/react";
import {
  ArrowRight,
  BadgeCheck,
  Bell,
  Check,
  Clock,
  Plus,
  TrendingDown,
  TrendingUp,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n/types";
import { useFormatters } from "@/lib/use-formatters";
import { CHAIN_REGISTRY, getChainByChainId } from "@/lib/chains/registry";
import { useAskAgent } from "@/lib/use-ask-agent";
import { cn } from "@/lib/utils";
import type {
  AutomationActionConfig,
  AutomationRule,
  AutomationTriggerConfig,
  AutomationTriggerType,
} from "@/lib/automation/types";

// ─────────────────────────────────────────────────────────────────────────────
// AutomationRulesCard (brief §8): "when X happens, do Y" — author rules, arm/
// disarm them, watch the last fire. The engine is the app-open poller
// (src/components/automation-poller.tsx): triggers evaluate while the app is
// visible; transfers route through the agent loop (the wallet signature
// apply); notify actions land in the notifications surface.
// ─────────────────────────────────────────────────────────────────────────────

const TRIGGER_ICONS: Record<AutomationTriggerType, typeof TrendingUp> = {
  balance_above: TrendingUp,
  balance_below: TrendingDown,
  attestation_ready: BadgeCheck,
  schedule: Clock,
};

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const AMOUNT_RE = /^\d+(?:\.\d{1,18})?$/;

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function chainShort(chainId: number): string {
  return getChainByChainId(chainId)?.shortName ?? `#${chainId}`;
}

function triggerSummary(rule: AutomationRule, t: (key: TranslationKey, params?: Record<string, string>) => string): string {
  const cfg = rule.triggerConfig as AutomationTriggerConfig;
  if (rule.triggerType === "balance_above" || rule.triggerType === "balance_below") {
    const c = cfg as { chainId: number; token: string; threshold: number };
    return rule.triggerType === "balance_above"
      ? t("automation.triggerSummaryAbove", {
          token: c.token,
          chain: chainShort(c.chainId),
          threshold: String(c.threshold),
        })
      : t("automation.triggerSummaryBelow", {
          token: c.token,
          chain: chainShort(c.chainId),
          threshold: String(c.threshold),
        });
  }
  if (rule.triggerType === "attestation_ready") {
    const c = cfg as { paymentId: string };
    return t("automation.triggerSummaryAttestation", { id: `${c.paymentId.slice(0, 8)}…` });
  }
  const c = cfg as { everyMinutes: number };
  return t("automation.triggerSummarySchedule", { minutes: String(c.everyMinutes) });
}

function actionSummary(rule: AutomationRule, t: (key: TranslationKey, params?: Record<string, string>) => string): string {
  const a = rule.action as AutomationActionConfig;
  if (a.kind === "transfer") {
    return t("automation.actionSummaryTransfer", {
      amount: a.amount,
      token: a.token,
      recipient: shortAddr(a.recipient),
      chain: chainShort(a.chainId),
    });
  }
  return t("automation.actionSummaryNotify", { message: a.message });
}

export function AutomationRulesCard() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  // R15 (example intents): one tap composes a real create_automation_rule
  // prompt in the chat — the empty state becomes a starting point (the same
  // affordance the payments/recurring empty states already have).
  const askAgent = useAskAgent();
  const [authoring, setAuthoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data } = useQuery<{ rules: AutomationRule[] }>({
    queryKey: ["automation-rules"],
    queryFn: async () => {
      const res = await fetch("/api/automation", { cache: "no-store" });
      if (!res.ok) throw new Error("automation fetch failed");
      return res.json();
    },
    refetchInterval: 15_000,
  });
  const list = data?.rules ?? [];
  const activeCount = list.filter((r) => r.active).length;

  const mutate = useMutation({
    mutationFn: async (input: { method: string; path: string; body?: unknown }) => {
      const res = await fetch(input.path, {
        method: input.method,
        headers: { "content-type": "application/json" },
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `request failed (${res.status})`);
      return json;
    },
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["automation-rules"] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "failed"),
  });

  const toggle = useCallback(
    (rule: AutomationRule) => {
      mutate.mutate({
        method: "PATCH",
        path: `/api/automation/${rule.id}`,
        body: { active: !rule.active },
      });
    },
    [mutate],
  );

  return (
    <Card>
      <div className="mb-2 flex items-center gap-2">
        <Zap className="h-4 w-4 text-muted" aria-hidden />
        <h2 className="text-sm font-semibold text-foreground">{t("automation.title")}</h2>
        <span className="ml-auto flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
          {t("automation.activeCount", { count: String(activeCount) })}
        </span>
      </div>
      <p className="mb-3 text-xs leading-relaxed text-muted">{t("automation.intro")}</p>

      {error ? <p className="mb-2 rounded-lg bg-danger/10 px-3 py-2 text-[11px] text-danger">{error}</p> : null}

      {list.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface-2/40 px-3 py-4 text-center">
          <p className="text-[13px] font-medium text-foreground">{t("automation.empty")}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">{t("automation.emptyDesc")}</p>
          {/* R15 (example intents): both prompts are genuinely answerable via
              the agent's create_automation_rule tool — a balance-below alert
              and a periodic review reminder, the two "when X then Y" shapes
              this card authors by hand. */}
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => askAgent(t("automation.examplePromptBalance"))}
              className="glass-item flex min-h-9 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-muted transition-all duration-200 hover:border-primary/40 hover:bg-primary/10 hover:text-primary cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
              title={t("automation.examplePromptBalance")}
            >
              <TrendingDown className="h-3 w-3" aria-hidden />
              <span className="max-w-[180px] truncate">{t("automation.exampleChipBalance")}</span>
            </button>
            <button
              type="button"
              onClick={() => askAgent(t("automation.examplePromptReminder"))}
              className="glass-item flex min-h-9 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-muted transition-all duration-200 hover:border-primary/40 hover:bg-primary/10 hover:text-primary cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
              title={t("automation.examplePromptReminder")}
            >
              <Clock className="h-3 w-3" aria-hidden />
              <span className="max-w-[180px] truncate">{t("automation.exampleChipReminder")}</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="grid gap-2">
          {list.map((rule) => (
            <RuleRow key={rule.id} rule={rule} onToggle={() => toggle(rule)} onDelete={() => mutate.mutate({ method: "DELETE", path: `/api/automation/${rule.id}` })} t={t} />
          ))}
        </div>
      )}

      <Button
        onClick={() => setAuthoring((v) => !v)}
        size="sm"
        className="mt-4 w-full"
        variant={authoring ? "ghost" : "primary"}
      >
        {authoring ? <X className="h-3.5 w-3.5" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />}
        {authoring ? t("automation.cancel") : t("automation.createNew")}
      </Button>

      <AnimatePresence>
        {authoring ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <RuleForm
              onCancel={() => setAuthoring(false)}
              onSave={(payload) =>
                mutate.mutateAsync({ method: "POST", path: "/api/automation", body: payload })
              }
              onSaved={() => setAuthoring(false)}
              t={t}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </Card>
  );
}

const STATUS_TONE: Record<string, string> = {
  failed: "text-danger bg-danger/10",
  deferred: "text-warning bg-warning/10",
  notified: "text-success bg-success/10",
  dispatched: "text-success bg-success/10",
  fired: "text-primary bg-primary/10",
};

const STATUS_KEY: Record<string, TranslationKey> = {
  fired: "automation.statusFired",
  notified: "automation.statusNotified",
  dispatched: "automation.statusDispatched",
  deferred: "automation.statusDeferred",
  failed: "automation.statusFailed",
};

function RuleRow({
  rule,
  onToggle,
  onDelete,
  t,
}: {
  rule: AutomationRule;
  onToggle: () => void;
  onDelete: () => void;
  t: (key: TranslationKey, params?: Record<string, string>) => string;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { timeAgo } = useFormatters();
  const TriggerIcon = TRIGGER_ICONS[rule.triggerType] ?? Clock;
  const statusTone = rule.lastStatus ? (STATUS_TONE[rule.lastStatus] ?? "text-muted-2 bg-surface-2") : null;
  const statusKey = rule.lastStatus ? STATUS_KEY[rule.lastStatus] : undefined;

  return (
    <motion.div
      layout
      className={cn(
        "rounded-xl border p-3 transition-colors",
        rule.active ? "border-primary/40 bg-primary/[0.06]" : "border-border bg-surface-2/40 hover:border-border-strong",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
            rule.active ? "bg-primary/15 text-primary" : "bg-surface-3 text-muted",
          )}
        >
          <TriggerIcon className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-[13px] font-semibold text-foreground">{rule.name}</p>
          </div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{triggerSummary(rule, t)}</p>
          <p className="mt-1 flex items-center gap-1 text-[11px] leading-relaxed text-muted-2">
            <ArrowRight className="h-3 w-3 shrink-0" aria-hidden />
            <span className="truncate">
              {rule.action.kind === "notify" ? <Bell className="mr-0.5 inline h-3 w-3" aria-hidden /> : null}
              {actionSummary(rule, t)}
            </span>
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-muted-2">
              {rule.lastFiredAt
                ? t("automation.lastFiredAt", { time: timeAgo(rule.lastFiredAt) })
                : t("automation.lastFiredNever")}
            </span>
            {statusKey ? (
              <span className={cn("rounded-md px-1.5 py-px text-[9px] font-bold uppercase tracking-wide", statusTone)}>
                {t(statusKey)}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <button
            type="button"
            role="switch"
            aria-checked={rule.active}
            aria-label={t("automation.toggleLabel", { name: rule.name })}
            onClick={onToggle}
            className={cn(
              "relative h-5.5 w-10 shrink-0 rounded-full border transition-colors",
              rule.active ? "border-primary/50 bg-primary/30" : "border-border bg-surface-2",
            )}
            style={{ height: 22, width: 40 }}
          >
            <span
              className={cn(
                "absolute top-[3px] rounded-full bg-foreground transition-all",
                rule.active ? "left-[20px]" : "left-[3px]",
              )}
              style={{ height: 14, width: 14 }}
            />
          </button>
          <div className="flex gap-0.5">
            {confirmDelete ? (
              <button
                type="button"
                onClick={onDelete}
                className="flex h-6 items-center gap-1 rounded-md border border-danger/40 bg-danger/10 px-1.5 text-[10px] font-bold text-danger"
                title={t("automation.confirmDelete")}
              >
                <Check className="h-3 w-3" aria-hidden />
                {t("automation.deleteYes")}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                onBlur={() => setConfirmDelete(false)}
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-2 hover:text-danger hover:bg-danger/10"
                title={t("automation.delete")}
              >
                <Trash2 className="h-3 w-3" aria-hidden />
              </button>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

interface RuleFormState {
  name: string;
  triggerType: AutomationTriggerType;
  triggerChainId: string;
  triggerToken: string;
  triggerThreshold: string;
  triggerPaymentId: string;
  triggerEveryMinutes: string;
  actionKind: "transfer" | "notify";
  actionChainId: string;
  actionToken: string;
  actionRecipient: string;
  actionAmount: string;
  actionMessage: string;
}

const INITIAL_FORM: RuleFormState = {
  name: "",
  triggerType: "schedule",
  triggerChainId: String(CHAIN_REGISTRY[0].chainId),
  triggerToken: "",
  triggerThreshold: "",
  triggerPaymentId: "",
  triggerEveryMinutes: "60",
  actionKind: "notify",
  actionChainId: String(CHAIN_REGISTRY[0].chainId),
  actionToken: "",
  actionRecipient: "",
  actionAmount: "",
  actionMessage: "",
};

const selectCls =
  "w-full rounded-lg border border-border bg-surface-2/60 px-3 py-2 text-[13px] text-foreground focus:border-primary/40 focus:outline-none";
const inputCls = `${selectCls} placeholder:text-muted-2`;

function RuleForm({
  onSave,
  onCancel,
  onSaved,
  t,
}: {
  onSave: (payload: Record<string, unknown>) => Promise<unknown>;
  onCancel: () => void;
  onSaved: () => void;
  t: (key: TranslationKey, params?: Record<string, string>) => string;
}) {
  const [form, setForm] = useState<RuleFormState>(INITIAL_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const set = <K extends keyof RuleFormState>(key: K, value: RuleFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const labelCls = "text-[10px] font-bold uppercase tracking-widest text-muted-2";
  const isBalance = form.triggerType === "balance_above" || form.triggerType === "balance_below";

  const submit = async () => {
    if (form.name.trim().length < 2) return setFormError(t("automation.errorName"));

    let triggerConfig: Record<string, unknown>;
    if (isBalance) {
      const chainId = Number(form.triggerChainId);
      if (!getChainByChainId(chainId)) return setFormError(t("automation.errorChain"));
      const token = form.triggerToken.trim();
      if (!token) return setFormError(t("automation.errorToken"));
      const threshold = Number(form.triggerThreshold);
      if (!Number.isFinite(threshold) || threshold <= 0) return setFormError(t("automation.errorThreshold"));
      triggerConfig = { chainId, token, threshold };
    } else if (form.triggerType === "attestation_ready") {
      const paymentId = form.triggerPaymentId.trim();
      if (!paymentId) return setFormError(t("automation.errorPaymentId"));
      triggerConfig = { paymentId };
    } else {
      const everyMinutes = Number(form.triggerEveryMinutes);
      if (!Number.isInteger(everyMinutes) || everyMinutes < 1 || everyMinutes > 1440)
        return setFormError(t("automation.errorEveryMinutes"));
      triggerConfig = { everyMinutes };
    }

    let actionJson: Record<string, unknown>;
    if (form.actionKind === "transfer") {
      const chainId = Number(form.actionChainId);
      if (!getChainByChainId(chainId)) return setFormError(t("automation.errorChain"));
      const token = form.actionToken.trim();
      if (!token) return setFormError(t("automation.errorToken"));
      const recipient = form.actionRecipient.trim();
      if (!ADDR_RE.test(recipient)) return setFormError(t("automation.errorRecipient"));
      const amount = form.actionAmount.trim();
      if (!AMOUNT_RE.test(amount) || Number(amount) <= 0) return setFormError(t("automation.errorAmount"));
      actionJson = { kind: "transfer", chainId, token, recipient, amount };
    } else {
      const message = form.actionMessage.trim();
      if (message.length < 2 || message.length > 300) return setFormError(t("automation.errorMessage"));
      actionJson = { kind: "notify", message };
    }

    try {
      await onSave({
        name: form.name.trim(),
        triggerType: form.triggerType,
        triggerConfig,
        actionJson,
      });
      onSaved();
    } catch (e) {
      // Server-side validation (e.g. unknown payment id) — inline in the form.
      setFormError(e instanceof Error ? e.message : "failed");
    }
  };

  return (
    <div className="mt-3 rounded-xl border border-primary/25 bg-primary/[0.04] p-3.5">
      <p className="text-xs font-semibold text-foreground">{t("automation.formTitle")}</p>
      <p className="mt-0.5 text-[10px] leading-relaxed text-muted-2">{t("automation.formHint")}</p>

      <input
        value={form.name}
        onChange={(e) => set("name", e.target.value)}
        placeholder={t("automation.fieldName")}
        maxLength={60}
        className={inputCls + " mt-2.5"}
      />

      <p className={labelCls + " mt-3"}>{t("automation.triggerLabel")}</p>
      <select
        value={form.triggerType}
        onChange={(e) => set("triggerType", e.target.value as AutomationTriggerType)}
        className={`${selectCls} mt-1.5`}
        aria-label={t("automation.triggerLabel")}
      >
        <option value="balance_above">{t("automation.triggerBalanceAbove")}</option>
        <option value="balance_below">{t("automation.triggerBalanceBelow")}</option>
        <option value="attestation_ready">{t("automation.triggerAttestation")}</option>
        <option value="schedule">{t("automation.triggerSchedule")}</option>
      </select>

      {isBalance ? (
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <select
            value={form.triggerChainId}
            onChange={(e) => set("triggerChainId", e.target.value)}
            className={selectCls}
            aria-label={t("automation.chainLabel")}
          >
            {CHAIN_REGISTRY.map((c) => (
              <option key={c.chainId} value={String(c.chainId)}>
                {c.shortName}
              </option>
            ))}
          </select>
          <input
            value={form.triggerToken}
            onChange={(e) => set("triggerToken", e.target.value)}
            placeholder={t("automation.tokenPlaceholder")}
            className={inputCls}
            aria-label={t("automation.tokenLabel")}
          />
          <input
            type="number"
            min="0"
            step="any"
            value={form.triggerThreshold}
            onChange={(e) => set("triggerThreshold", e.target.value)}
            placeholder={t("automation.thresholdLabel")}
            className={inputCls}
            aria-label={t("automation.thresholdLabel")}
          />
        </div>
      ) : null}

      {form.triggerType === "attestation_ready" ? (
        <input
          value={form.triggerPaymentId}
          onChange={(e) => set("triggerPaymentId", e.target.value)}
          placeholder={t("automation.paymentIdLabel")}
          maxLength={100}
          className={`${inputCls} mt-2`}
          aria-label={t("automation.paymentIdLabel")}
        />
      ) : null}

      {form.triggerType === "schedule" ? (
        <input
          type="number"
          min="1"
          max="1440"
          value={form.triggerEveryMinutes}
          onChange={(e) => set("triggerEveryMinutes", e.target.value)}
          placeholder={t("automation.everyMinutesLabel")}
          className={`${inputCls} mt-2`}
          aria-label={t("automation.everyMinutesLabel")}
        />
      ) : null}

      <p className={labelCls + " mt-3"}>{t("automation.actionLabel")}</p>
      <select
        value={form.actionKind}
        onChange={(e) => set("actionKind", e.target.value as "transfer" | "notify")}
        className={`${selectCls} mt-1.5`}
        aria-label={t("automation.actionLabel")}
      >
        <option value="transfer">{t("automation.actionTransfer")}</option>
        <option value="notify">{t("automation.actionNotify")}</option>
      </select>

      {form.actionKind === "transfer" ? (
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <select
            value={form.actionChainId}
            onChange={(e) => set("actionChainId", e.target.value)}
            className={selectCls}
            aria-label={t("automation.chainLabel")}
          >
            {CHAIN_REGISTRY.map((c) => (
              <option key={c.chainId} value={String(c.chainId)}>
                {c.shortName}
              </option>
            ))}
          </select>
          <input
            value={form.actionToken}
            onChange={(e) => set("actionToken", e.target.value)}
            placeholder={t("automation.tokenPlaceholder")}
            className={inputCls}
            aria-label={t("automation.tokenLabel")}
          />
          <input
            value={form.actionRecipient}
            onChange={(e) => set("actionRecipient", e.target.value)}
            placeholder={t("automation.recipientLabel")}
            maxLength={42}
            className={inputCls}
            aria-label={t("automation.recipientLabel")}
          />
          <input
            type="number"
            min="0"
            step="any"
            value={form.actionAmount}
            onChange={(e) => set("actionAmount", e.target.value)}
            placeholder={t("automation.amountLabel")}
            className={inputCls}
            aria-label={t("automation.amountLabel")}
          />
        </div>
      ) : (
        <textarea
          value={form.actionMessage}
          onChange={(e) => set("actionMessage", e.target.value)}
          placeholder={t("automation.messagePlaceholder")}
          maxLength={300}
          rows={3}
          className={`${inputCls} mt-2 resize-y text-[12px] leading-relaxed`}
          aria-label={t("automation.messageLabel")}
        />
      )}

      {formError ? <p className="mt-2 text-[11px] text-danger">{formError}</p> : null}

      <div className="mt-3 flex gap-2">
        <Button onClick={submit} size="sm" className="flex-1">
          <Check className="h-3.5 w-3.5" aria-hidden />
          {t("automation.createSubmit")}
        </Button>
        <Button onClick={onCancel} size="sm" variant="ghost">
          {t("automation.cancel")}
        </Button>
      </div>
    </div>
  );
}
