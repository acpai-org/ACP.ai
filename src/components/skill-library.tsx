"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "motion/react";
import {
  Activity,
  AlertTriangle,
  Ban,
  CalendarCheck,
  Check,
  CheckCheck,
  ChevronDown,
  Crown,
  Download,
  FlaskConical,
  History,
  Leaf,
  Pencil,
  Plus,
  Radar,
  Radio,
  Scale,
  Search,
  Shield,
  Sparkles,
  Target,
  Trash2,
  Upload,
  Users,
  Wrench,
  X,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n/types";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// SkillLibrary (brief §7): browse the library (builtin + user), toggle which
// are active for the agent, and author custom skills. A skill composes the
// FIXED toolset (instructions + optional tool allowlist) — it is prompt-level
// configuration, never new wallet-touching code (§12).
// ─────────────────────────────────────────────────────────────────────────────

interface Skill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  toolAllowlist: string[] | null;
  builtin: boolean;
  enabled: boolean;
  icon: string | null;
  createdAt: number;
}

/** The closed toolset surface a user can compose from (labels via trace keys). */
const TOOL_KEYS: Record<string, string> = {
  get_balances: "trace.toolBalances",
  get_transaction_status: "trace.toolTxStatus",
  check_attestation_status: "trace.toolCheckAttestation",
  wait_for_attestation: "trace.toolWaitAttestation",
  attestcoin_network_status: "trace.toolAttestcoinStatus",
  list_contacts: "trace.toolContacts",
  list_chains: "trace.toolChains",
  list_recent_actions: "trace.toolActions",
  get_app_status: "trace.toolAppStatus",
  transfer: "trace.toolTransfer",
  batch_transfer: "trace.toolBatch",
  deploy_contract: "trace.toolDeploy",
  create_conditional_release: "trace.toolEscrow",
  execute_conditional_release: "trace.toolRelease",
  cross_chain_swap: "trace.toolSwap",
  create_recurring_payment: "trace.toolRecurring",
};

function SkillIcon({ icon, builtin }: { icon: string | null; builtin: boolean }) {
  const cls = "h-4 w-4";
  if (icon === "target") return <Target className={cls} aria-hidden />;
  if (icon === "shield") return <Shield className={cls} aria-hidden />;
  if (icon === "leaf") return <Leaf className={cls} aria-hidden />;
  if (icon === "chart") return <Activity className={cls} aria-hidden />;
  if (icon === "radio") return <Radio className={cls} aria-hidden />;
  if (icon === "flask") return <FlaskConical className={cls} aria-hidden />;
  if (icon === "scale") return <Scale className={cls} aria-hidden />;
  if (icon === "history") return <History className={cls} aria-hidden />;
  if (icon === "radar") return <Radar className={cls} aria-hidden />;
  if (icon === "users") return <Users className={cls} aria-hidden />;
  if (icon === "calendar") return <CalendarCheck className={cls} aria-hidden />;
  return builtin ? <Sparkles className={cls} aria-hidden /> : <Wrench className={cls} aria-hidden />;
}

// ── Skill sharing: export/import (brief §7 customization) ────────────────────
// A shared skill is plain JSON: instructions + optional tool focus over the
// FIXED toolset. Importing is subject to the same §12 boundary as authoring:
// unknown tool names are dropped server-side; nothing new can execute.

const SKILL_EXPORT_VERSION = 1;

interface ShareableSkill {
  name: string;
  description: string;
  instructions: string;
  toolAllowlist: string[] | null;
}

function exportSkillFile(skill: Skill) {
  const payload = {
    acpSkill: SKILL_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    skill: {
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      toolAllowlist: skill.toolAllowlist,
    } satisfies ShareableSkill,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const slug = skill.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  a.href = url;
  a.download = `acp-skill-${slug || "skill"}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Parse pasted/loaded JSON — accepts the export envelope or a bare skill. */
function parseSharedSkill(text: string):
  | { ok: true; skill: ShareableSkill }
  | { ok: false; kind: "format" | "fields" } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, kind: "format" };
  }
  // Unwrap the envelope if present.
  const candidate =
    parsed && typeof parsed === "object" && "skill" in (parsed as Record<string, unknown>)
      ? (parsed as Record<string, unknown>).skill
      : parsed;
  if (!candidate || typeof candidate !== "object") return { ok: false, kind: "format" };
  const c = candidate as Record<string, unknown>;
  const name = typeof c.name === "string" ? c.name.trim() : "";
  const description = typeof c.description === "string" ? c.description.trim() : "";
  const instructions = typeof c.instructions === "string" ? c.instructions.trim() : "";
  if (!name || !description || !instructions) return { ok: false, kind: "fields" };
  const allow = Array.isArray(c.toolAllowlist)
    ? c.toolAllowlist.filter((n): n is string => typeof n === "string")
    : null;
  return {
    ok: true,
    skill: { name, description, instructions, toolAllowlist: allow && allow.length > 0 ? allow : null },
  };
}

export function SkillLibrary() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [authoring, setAuthoring] = useState(false);
  const [editing, setEditing] = useState<Skill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState("");
  const [importFileName, setImportFileName] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" focuses the search box (same convention as the chat composer — the
  // early-return keeps "/" typing when ANY field, including this one, already
  // holds focus).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      if (
        el instanceof HTMLElement &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const { data } = useQuery<{ skills: Skill[] }>({
    queryKey: ["skills"],
    queryFn: async () => {
      const res = await fetch("/api/skills", { cache: "no-store" });
      if (!res.ok) throw new Error("skills fetch failed");
      return res.json();
    },
    refetchInterval: 60_000,
  });
  // Stable identity so the bulkSet useCallback below doesn't churn deps.
  const list = useMemo(() => data?.skills ?? [], [data]);

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
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "failed"),
  });

  const toggle = useCallback(
    (skill: Skill) => {
      mutate.mutate({ method: "PATCH", path: `/api/skills/${skill.id}`, body: { enabled: !skill.enabled } });
    },
    [mutate],
  );

  // Bulk enable/disable (skills depth): PATCH every skill whose state differs,
  // in parallel, then invalidate the list once. Per-skill failures surface as
  // a single count instead of a raw transport error.
  const [bulkPending, setBulkPending] = useState(false);
  const bulkSet = useCallback(
    (enabled: boolean) => {
      const targets = list.filter((s) => s.enabled !== enabled);
      if (targets.length === 0 || bulkPending) return;
      setBulkPending(true);
      void (async () => {
        const results = await Promise.allSettled(
          targets.map((s) =>
            fetch(`/api/skills/${s.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ enabled }),
            }),
          ),
        );
        const failed = results.filter((r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok)).length;
        setError(failed > 0 ? t("skills.bulkError", { count: String(failed) }) : null);
        void queryClient.invalidateQueries({ queryKey: ["skills"] });
        setBulkPending(false);
      })();
    },
    [list, bulkPending, queryClient, t],
  );

  // Search filter (skills depth): matches name, description, or instructions —
  // instructions matching matters because that's where the actual behavior
  // lives ("lunch", "cheapest", "testnet" …).
  const query = filter.trim().toLowerCase();
  const matches = useCallback(
    (s: Skill) => {
      if (!query) return true;
      return (
        s.name.toLowerCase().includes(query) ||
        s.description.toLowerCase().includes(query) ||
        s.instructions.toLowerCase().includes(query)
      );
    },
    [query],
  );

  const builtin = list.filter((s) => s.builtin).filter(matches);
  const custom = list.filter((s) => !s.builtin).filter(matches);
  const enabledCount = list.filter((s) => s.enabled).length;
  const allEnabled = list.length > 0 && enabledCount === list.length;
  const allDisabled = enabledCount === 0;
  const filtering = query.length > 0;
  const totalVisible = builtin.length + custom.length;

  const importPreview = importText.trim() ? parseSharedSkill(importText) : null;

  // F7 (D.6 audit): mirror the loop's effective-toolset semantics (F1) so the
  // user SEES the consequence of enabling skills the moment it happens — which
  // fixed tools just became unavailable — instead of discovering it when a
  // tool call gets structurally rejected. Union rules, identical to
  // activeSkillToolAllowlist(): no active skills → all; ANY active skill with
  // a null allowlist → all (the null grant is the universe); otherwise the
  // union of the active lists.
  const effectiveTools = useMemo(() => {
    const active = list.filter((s) => s.enabled);
    if (active.length === 0) return null;
    const union = new Set<string>();
    for (const s of active) {
      if (!s.toolAllowlist) return null;
      for (const tool of s.toolAllowlist) union.add(tool);
    }
    return union;
  }, [list]);
  const allToolNames = useMemo(() => Object.keys(TOOL_KEYS), []);
  const droppedTools = useMemo(
    () => (effectiveTools ? allToolNames.filter((tool) => !effectiveTools.has(tool)) : []),
    [effectiveTools, allToolNames],
  );
  const toolsetNarrowed = effectiveTools !== null && droppedTools.length > 0;

  // Duplicate hint (P2-8 queue #5): names aren't unique keys server-side, so
  // re-importing a shared skill creates a second copy. Match by exact name OR
  // exact description (an exported skill re-imported verbatim matches both) —
  // hint is informational, never blocking.
  const duplicateOf = importPreview?.ok
    ? list.find(
        (s) =>
          s.name.trim().toLowerCase() === importPreview.skill.name.trim().toLowerCase() ||
          (importPreview.skill.description.length >= 8 &&
            s.description.trim() === importPreview.skill.description.trim()),
      )
    : undefined;

  const submitImport = () => {
    if (!importPreview || !importPreview.ok) return;
    mutate.mutate(
      {
        method: "POST",
        path: "/api/skills",
        body: importPreview.skill,
      },
      {
        onSuccess: () => {
          setImporting(false);
          setImportText("");
          setImportFileName(null);
        },
      },
    );
  };

  const onImportFile = (file: File | undefined) => {
    if (!file) return;
    setImportFileName(file.name);
    void file.text().then(setImportText).catch(() => undefined);
  };

  return (
    <Card>
      <div className="mb-2 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-muted" aria-hidden />
        <h2 className="text-sm font-semibold text-foreground">{t("skills.title")}</h2>
        <span className="ml-auto flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
          {t("skills.activeCount", { count: String(enabledCount) })}
        </span>
      </div>
      <p className="mb-3 text-xs leading-relaxed text-muted">{t("skills.intro")}</p>

      {error ? <p className="mb-2 rounded-lg bg-danger/10 px-3 py-2 text-[11px] text-danger">{error}</p> : null}

      {list.length >= 2 ? (
        <div className="mb-3 flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-2" aria-hidden />
            <input
              ref={searchRef}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("skills.searchPlaceholder")}
              aria-label={t("skills.searchPlaceholder")}
              title={t("skills.searchKbd")}
              spellCheck={false}
              className="w-full rounded-lg border border-border bg-surface-2/60 py-1.5 pl-8 pr-7 text-[12px] text-foreground placeholder:text-muted-2 transition-colors focus:border-primary/40 focus:outline-none"
            />
            {filtering ? (
              <button
                type="button"
                onClick={() => setFilter("")}
                className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-2 transition-colors hover:bg-surface-3 hover:text-foreground"
                aria-label={t("skills.searchClear")}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            ) : (
              <kbd
                aria-hidden
                title={t("skills.searchKbd")}
                className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border bg-surface-3/80 px-1 font-mono text-[10px] font-medium leading-4 text-muted-2"
              >
                /
              </kbd>
            )}
          </div>
          <Button
            onClick={() => bulkSet(true)}
            disabled={allEnabled || bulkPending}
            size="sm"
            variant="ghost"
            className="hit-slop h-8 shrink-0 px-2 text-[11px]"
            aria-label={t("skills.enableAll")}
          >
            <CheckCheck className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden sm:inline">{t("skills.enableAll")}</span>
          </Button>
          <Button
            onClick={() => bulkSet(false)}
            disabled={allDisabled || bulkPending}
            size="sm"
            variant="ghost"
            className="hit-slop h-8 shrink-0 px-2 text-[11px]"
            aria-label={t("skills.disableAll")}
          >
            <Ban className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden sm:inline">{t("skills.disableAll")}</span>
          </Button>
        </div>
      ) : null}

      {toolsetNarrowed ? (
        <div
          className="mb-3 rounded-xl border border-warning/30 bg-warning/[0.06] p-3"
          role="status"
          aria-live="polite"
          data-testid="toolset-warning"
        >
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-warning">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {t("skills.toolsetNarrowed", {
              count: String(effectiveTools?.size ?? 0),
              total: String(allToolNames.length),
            })}
          </p>
          <p className="mt-1 text-[10px] leading-relaxed text-muted">{t("skills.toolsetDropped")}</p>
          <div className="mt-2 flex flex-wrap gap-1">
            {droppedTools.map((tool) => (
              <span
                key={tool}
                className="rounded-md border border-border bg-surface-2/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-2 line-through decoration-warning/60"
              >
                {t(TOOL_KEYS[tool] as never)}
              </span>
            ))}
          </div>
          <p className="mt-1.5 text-[10px] leading-relaxed text-muted-2">{t("skills.toolsetHint")}</p>
        </div>
      ) : null}

      {filtering && totalVisible === 0 ? (
        <p className="mb-3 rounded-lg border border-dashed border-border px-3 py-3 text-center text-[11px] text-muted-2">
          {t("skills.noMatch")}
        </p>
      ) : null}

      {builtin.length > 0 ? (
        <p className="mb-1.5 mt-1 text-[10px] font-bold uppercase tracking-widest text-muted-2">
          {t("skills.sectionBuiltin")}
        </p>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        {builtin.map((skill) => (
          <SkillCard key={skill.id} skill={skill} onToggle={() => toggle(skill)} onExport={() => exportSkillFile(skill)} t={t} />
        ))}
      </div>

      {custom.length > 0 ? (
        <p className="mb-1.5 mt-4 text-[10px] font-bold uppercase tracking-widest text-muted-2">
          {t("skills.sectionCustom")}
        </p>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        {custom.map((skill) => (
          <SkillCard
            key={skill.id}
            skill={skill}
            onToggle={() => toggle(skill)}
            onExport={() => exportSkillFile(skill)}
            onEdit={() => {
              setEditing(skill);
              setAuthoring(true);
            }}
            onDelete={() => mutate.mutate({ method: "DELETE", path: `/api/skills/${skill.id}` })}
            t={t}
          />
        ))}
      </div>

      <div className="mt-4 flex gap-2">
        <Button
          onClick={() => {
            setEditing(null);
            setAuthoring((v) => !v);
          }}
          size="sm"
          className="flex-1"
          variant={authoring ? "ghost" : "primary"}
        >
          {authoring ? <X className="h-3.5 w-3.5" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />}
          {authoring ? t("skills.cancelAuthor") : t("skills.authorNew")}
        </Button>
        <Button
          onClick={() => {
            setImporting((v) => !v);
            setAuthoring(false);
            setEditing(null);
          }}
          size="sm"
          variant={importing ? "ghost" : "secondary"}
          className="shrink-0"
          aria-expanded={importing}
        >
          {importing ? <X className="h-3.5 w-3.5" aria-hidden /> : <Upload className="h-3.5 w-3.5" aria-hidden />}
          {importing ? t("skills.cancelAuthor") : t("skills.import")}
        </Button>
      </div>

      <AnimatePresence>
        {importing ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-3 rounded-xl border border-primary/25 bg-primary/[0.04] p-3.5">
              <p className="text-xs font-semibold text-foreground">{t("skills.importTitle")}</p>
              <p className="mt-0.5 text-[10px] leading-relaxed text-muted-2">{t("skills.importHint")}</p>

              <div className="mt-2.5 flex flex-col gap-2 sm:flex-row sm:items-center">
                <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-dashed border-border-strong px-3 py-1.5 text-[11px] font-medium text-muted transition-colors hover:border-primary/40 hover:text-foreground">
                  <Download className="h-3 w-3" aria-hidden />
                  {importFileName ?? t("skills.importFile")}
                  <input
                    type="file"
                    accept="application/json,.json"
                    className="sr-only"
                    onChange={(e) => onImportFile(e.target.files?.[0])}
                  />
                </label>
                {importPreview?.ok ? (
                  <p className="min-w-0 flex-1 truncate text-[11px] text-muted">
                    <Check className="mr-1 inline h-3 w-3 text-success" aria-hidden />
                    {importPreview.skill.name} —{" "}
                    {importPreview.skill.toolAllowlist
                      ? t("skills.toolsCount", { count: String(importPreview.skill.toolAllowlist.length) })
                      : t("skills.toolsAll")}
                  </p>
                ) : null}
              </div>

              <textarea
                value={importText}
                onChange={(e) => {
                  setImportText(e.target.value);
                  setImportFileName(null);
                }}
                placeholder={t("skills.importPlaceholder")}
                rows={4}
                spellCheck={false}
                className="acp-scroll mt-2 w-full resize-y rounded-lg border border-border bg-surface-2/60 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground placeholder:text-muted-2 focus:border-primary/40 focus:outline-none"
              />

              {importPreview && !importPreview.ok ? (
                <p className="mt-1.5 text-[11px] text-danger">
                  {importPreview.kind === "format"
                    ? t("skills.importBadJson")
                    : t("skills.importInvalid")}
                </p>
              ) : null}

              {duplicateOf ? (
                <p
                  className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-warning/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-warning"
                  role="status"
                >
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                  {t("skills.importDuplicate", { name: duplicateOf.name })}
                </p>
              ) : null}

              <div className="mt-2.5 flex gap-2">
                <Button
                  onClick={submitImport}
                  size="sm"
                  className="flex-1"
                  disabled={!importPreview?.ok}
                >
                  <Upload className="h-3.5 w-3.5" aria-hidden />
                  {t("skills.importAction")}
                </Button>
                <Button
                  onClick={() => {
                    setImporting(false);
                    setImportText("");
                    setImportFileName(null);
                  }}
                  size="sm"
                  variant="ghost"
                >
                  {t("skills.cancelAuthor")}
                </Button>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {authoring ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <SkillAuthorForm
              initial={editing}
              onCancel={() => {
                setAuthoring(false);
                setEditing(null);
              }}
              onSave={(payload, isEdit) =>
                mutate.mutate({
                  method: isEdit ? "PATCH" : "POST",
                  path: isEdit ? `/api/skills/${editing!.id}` : "/api/skills",
                  body: payload,
                })
              }
              onSaved={() => {
                setAuthoring(false);
                setEditing(null);
              }}
              t={t}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </Card>
  );
}

function SkillCard({
  skill,
  onToggle,
  onExport,
  onEdit,
  onDelete,
  t,
}: {
  skill: Skill;
  onToggle: () => void;
  onExport: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  t: (key: TranslationKey, params?: Record<string, string>) => string;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  return (
    <motion.div
      layout
      className={cn(
        "rounded-xl border p-3 transition-colors",
        skill.enabled ? "border-primary/40 bg-primary/[0.06]" : "border-border bg-surface-2/40 hover:border-border-strong",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
            skill.enabled ? "bg-primary/15 text-primary" : "bg-surface-3 text-muted",
          )}
        >
          <SkillIcon icon={skill.icon} builtin={skill.builtin} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-[13px] font-semibold text-foreground">{skill.name}</p>
            {skill.builtin ? (
              <span className="flex shrink-0 items-center gap-0.5 rounded-md bg-surface-3 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-muted-2">
                <Crown className="h-2.5 w-2.5" aria-hidden />
                {t("skills.builtinBadge")}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{skill.description}</p>
          {/* Tool focus — expandable so the EXACT permitted tools are visible
              before enabling (the per-skill half of F7's preview story). */}
          {skill.toolAllowlist ? (
            <button
              type="button"
              onClick={() => setToolsExpanded((v) => !v)}
              aria-expanded={toolsExpanded}
              className="hit-slop mt-1 inline-flex min-h-9 items-center gap-1 rounded-lg text-[10px] font-medium text-muted-2 transition-colors hover:text-foreground cursor-pointer"
              title={t("skills.toolsExpandHint")}
            >
              <ChevronDown
                className={cn("h-3 w-3 transition-transform", toolsExpanded && "rotate-180")}
                aria-hidden
              />
              {t("skills.toolsCount", { count: String(skill.toolAllowlist.length) })}
            </button>
          ) : (
            <p className="mt-1 text-[10px] text-muted-2">{t("skills.toolsAll")}</p>
          )}
          {toolsExpanded && skill.toolAllowlist ? (
            <div className="mt-1.5 flex flex-wrap gap-1" data-testid="skill-tools-expanded">
              {skill.toolAllowlist.map((tool) => (
                <span
                  key={tool}
                  className="rounded-md border border-border bg-surface-2/60 px-1.5 py-0.5 text-[10px] font-medium text-muted"
                >
                  {t((TOOL_KEYS[tool] ?? "trace.tool") as never)}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <button
            type="button"
            role="switch"
            aria-checked={skill.enabled}
            aria-label={t("skills.toggleLabel", { name: skill.name })}
            onClick={onToggle}
            className={cn(
              "hit-slop relative h-5.5 w-10 shrink-0 rounded-full border transition-colors",
              skill.enabled ? "border-primary/50 bg-primary/30" : "border-border bg-surface-2",
            )}
            style={{ height: 22, width: 40 }}
          >
            <span
              className={cn(
                "absolute top-[3px] rounded-full bg-foreground transition-all",
                skill.enabled ? "left-[20px]" : "left-[3px]",
              )}
              style={{ height: 14, width: 14 }}
            />
          </button>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={onExport}
              className="hit-slop flex h-7 w-7 items-center justify-center rounded-lg text-muted-2 hover:text-foreground hover:bg-surface-3"
              title={t("skills.export")}
              aria-label={t("skills.export")}
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
            </button>
            {onEdit ? (
              <button
                type="button"
                onClick={onEdit}
                className="hit-slop flex h-7 w-7 items-center justify-center rounded-lg text-muted-2 hover:text-foreground hover:bg-surface-3"
                title={t("skills.edit")}
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden />
              </button>
            ) : null}
            {onDelete ? (
              confirmDelete ? (
                <button
                  type="button"
                  onClick={onDelete}
                  className="hit-slop flex h-7 items-center gap-1 rounded-lg border border-danger/40 bg-danger/10 px-1.5 text-[10px] font-bold text-danger"
                  title={t("skills.confirmDelete")}
                >
                  <Check className="h-3.5 w-3.5" aria-hidden />
                  {t("skills.deleteYes")}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  onBlur={() => setConfirmDelete(false)}
                  className="hit-slop flex h-7 w-7 items-center justify-center rounded-lg text-muted-2 hover:text-danger hover:bg-danger/10"
                  title={t("skills.delete")}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              )
            ) : null}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function SkillAuthorForm({
  initial,
  onSave,
  onCancel,
  onSaved,
  t,
}: {
  initial: Skill | null;
  onSave: (payload: Record<string, unknown>, isEdit: boolean) => void;
  onCancel: () => void;
  onSaved: () => void;
  t: (key: TranslationKey, params?: Record<string, string>) => string;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [selected, setSelected] = useState<Set<string>>(new Set(initial?.toolAllowlist ?? []));
  const [formError, setFormError] = useState<string | null>(null);

  const submit = () => {
    if (name.trim().length < 2) return setFormError(t("skills.errorName"));
    if (description.trim().length < 4) return setFormError(t("skills.errorDesc"));
    if (instructions.trim().length < 10) return setFormError(t("skills.errorInstructions"));
    onSave(
      {
        name: name.trim(),
        description: description.trim(),
        instructions: instructions.trim(),
        toolAllowlist: selected.size > 0 ? [...selected] : null,
      },
      Boolean(initial),
    );
    onSaved();
  };

  return (
    <div className="mt-3 rounded-xl border border-primary/25 bg-primary/[0.04] p-3.5">
      <p className="text-xs font-semibold text-foreground">{initial ? t("skills.editTitle") : t("skills.authorTitle")}</p>
      <p className="mt-0.5 text-[10px] leading-relaxed text-muted-2">{t("skills.authorHint")}</p>

      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("skills.fieldName")}
        maxLength={60}
        className="mt-2.5 w-full rounded-lg border border-border bg-surface-2/60 px-3 py-2 text-[13px] text-foreground placeholder:text-muted-2 focus:border-primary/40 focus:outline-none"
      />
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={t("skills.fieldDesc")}
        maxLength={200}
        className="mt-2 w-full rounded-lg border border-border bg-surface-2/60 px-3 py-2 text-[13px] text-foreground placeholder:text-muted-2 focus:border-primary/40 focus:outline-none"
      />
      <textarea
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        placeholder={t("skills.fieldInstructions")}
        maxLength={4000}
        rows={5}
        className="acp-scroll mt-2 w-full resize-y rounded-lg border border-border bg-surface-2/60 px-3 py-2 text-[12px] leading-relaxed text-foreground placeholder:text-muted-2 focus:border-primary/40 focus:outline-none"
      />

      <p className="mt-2.5 text-[10px] font-bold uppercase tracking-widest text-muted-2">
        {t("skills.toolsLabel")} <span className="font-normal normal-case tracking-normal">({t("skills.toolsOptional")})</span>
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {Object.entries(TOOL_KEYS).map(([tool, key]) => {
          const active = selected.has(tool);
          return (
            <button
              key={tool}
              type="button"
              aria-pressed={active}
              onClick={() =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (active) next.delete(tool);
                  else next.add(tool);
                  return next;
                })
              }
              className={cn(
                "rounded-md border px-1.5 py-0.5 text-[10px] font-medium transition-all",
                active
                  ? "border-primary/50 bg-primary/15 text-primary"
                  : "border-border text-muted-2 hover:text-foreground",
              )}
            >
              {t(key as never)}
            </button>
          );
        })}
      </div>

      {formError ? <p className="mt-2 text-[11px] text-danger">{formError}</p> : null}

      <div className="mt-3 flex gap-2">
        <Button onClick={submit} size="sm" className="flex-1">
          <Check className="h-3.5 w-3.5" aria-hidden />
          {initial ? t("skills.saveEdit") : t("skills.createSkill")}
        </Button>
        <Button onClick={onCancel} size="sm" variant="ghost">
          {t("skills.cancelAuthor")}
        </Button>
      </div>
    </div>
  );
}
