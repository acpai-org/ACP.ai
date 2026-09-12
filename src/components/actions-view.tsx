"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "motion/react";
import { rovingKeydown } from "@/lib/roving";
import {
  Check,
  ChevronDown,
  CircleDot,
  Clock,
  Copy,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Loader2,
  ShieldAlert,
  ShieldQuestion,
  X,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { FinderSearch } from "@/components/finder-search";
import { AttestStatePill } from "@/components/attest-state-pill";
import { useTxLifecycle } from "@/lib/agent/tx-lifecycle";
import { getChainByChainId } from "@/lib/chains/registry";
import { cc3ExplorerTxUrl, sourceExplorerTxUrl } from "@/lib/attestcoin/cc3-links";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// ActionsView (C7, Phase 3 §5/§10.3): the agent action log as the product's
// audit-trail surface — live-updating on every action and every lifecycle
// transition (C3's tx-lifecycle overlay), full detail per entry (timestamp,
// tool, chain, status, params, result summary, tx hash + explorer link, proof
// refs), finder search + status filters. Rendered on the Actions tab.
// ─────────────────────────────────────────────────────────────────────────────

interface ActionRow {
  id: string;
  runId: string | null;
  callId: string | null;
  tool: string;
  status: string;
  chainId: number | null;
  riskClass: string;
  confirmationRequired: boolean;
  params: Record<string, unknown> | null;
  result: { ok?: boolean; summary?: string; txHash?: string } | null;
  sourceTxHash: string | null;
  cc3TxHash: string | null;
  attestRoot: string | null;
  createdAt: number;
}

interface ActionsFeed {
  actions: ActionRow[];
  /** N27.1: server-side Attestcoin environment — powers CC3 explorer links. */
  cc3Env?: "testnet" | "mainnet";
}

const STATUS_STYLE: Record<string, string> = {
  succeeded: "text-success bg-success/10",
  failed: "text-danger bg-danger/10",
  declined: "text-muted-2 bg-surface-2",
  interrupted: "text-warning bg-warning/10",
  running: "text-primary bg-primary/10",
  pending: "text-muted-2 bg-surface-2",
  awaiting_confirmation: "text-warning bg-warning/10",
  awaiting_signature: "text-primary bg-primary/10",
  // L6 fix: "signed" is a real persisted action-log status (broadcast but
  // not yet confirmed) — without an entry the raw i18n key rendered in the UI.
  signed: "text-primary bg-primary/10",
  broadcast: "text-primary bg-primary/10",
  confirming: "text-primary bg-primary/10",
  unknown: "text-warning bg-warning/15",
  dispatched: "text-primary/80 bg-primary/5",
};

const LIVE_SPIN: Set<string> = new Set(["awaiting_signature", "broadcast", "confirming", "running", "pending", "signed"]);

// S8 (styling): status-colored left accent for each row — the audit trail
// becomes scannable at a glance (green done / red failed / amber unknown /
// primary in-flight) without reading a single status chip.
const STATUS_ACCENT: Record<string, string> = {
  succeeded: "bg-success/70",
  failed: "bg-danger/60",
  unknown: "bg-warning/70",
  interrupted: "bg-warning/50",
  declined: "bg-muted-2/40",
  running: "bg-primary/70",
  pending: "bg-primary/40",
  awaiting_confirmation: "bg-warning/70",
  awaiting_signature: "bg-primary/70",
  signed: "bg-primary/70",
  broadcast: "bg-primary/70",
  confirming: "bg-primary/70",
  dispatched: "bg-primary/50",
};

/** S9 (feature): compact copy-to-clipboard for tx hashes and reference ids —
 * the same Copy→Check confirmation pattern as the trace's CopyButton,
 * sized for inline chips (28px visual + hit-slop for the touch minimum). */
function CopyRef({ value, label }: { value: string; label?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label ?? t("trace.copy")}
      title={label ?? t("trace.copy")}
      onClick={(e) => {
        e.stopPropagation(); // the row toggles expand on click — don't trigger it
        void navigator.clipboard?.writeText(value).catch(() => {});
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      }}
      className="hit-slop inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-foreground/35 transition-colors hover:bg-foreground/[0.07] hover:text-foreground/75 active:bg-foreground/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
    >
      {copied ? <Check className="h-3 w-3 text-success" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
    </button>
  );
}

type StatusFilter = "all" | "succeeded" | "failed" | "declined" | "inflight";
type ChainFilter = number | "all";

// R23 (round-4 feature): time-window filter — the audit log grows forever, so
// "what happened TODAY" needs a one-tap answer. Windows are chips (same visual
// language as the chain chips) rather than a date picker: an action log is
// recency-shaped, and quick ranges keep the filter bar keyboard/touch friendly.
type RangeFilter = "all" | "24h" | "7d" | "30d";
const RANGE_MS: Record<Exclude<RangeFilter, "all">, number> = {
  "24h": 86_400_000,
  "7d": 604_800_000,
  "30d": 2_592_000_000,
};
const RANGE_FILTERS: { value: RangeFilter; key: string }[] = [
  { value: "all", key: "actions.rangeAll" },
  { value: "24h", key: "actions.range24h" },
  { value: "7d", key: "actions.range7d" },
  { value: "30d", key: "actions.range30d" },
];

// R24 (round-4 feature): inline "check attestation" result per action row —
// the read-only proof lookup (GET /api/attestcoin/proof) answers the single
// most common post-transaction question ("did it get attested?") without a
// round-trip through the payments page. Mirrors use-attestation-for-tx's
// state mapping so the pill language stays consistent app-wide.
type AttestCheck =
  | { phase: "checking" }
  | {
      phase: "done";
      state: "proof" | "pending" | "unknown_tx" | "error" | "unsupported";
      merkleRoot?: string;
      onchainVerified?: boolean;
      checkedAt: number;
    };

const ATTEST_CHECK_TIMEOUT_MS = 12_000;

const STATUS_FILTERS: { value: StatusFilter; key: string }[] = [
  { value: "all", key: "payments.all" },
  { value: "succeeded", key: "actions.status.succeeded" },
  { value: "failed", key: "actions.status.failed" },
  { value: "declined", key: "actions.status.declined" },
  { value: "inflight", key: "actions.filterInflight" },
];

// R28 (round-5): roving-tabindex keyboard navigation for the filter chip rows —
// the shared helper lives in src/lib/roving.ts (R30 extends it to payments).

function statusMatchesFilter(status: string, filter: StatusFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "succeeded":
      return status === "succeeded";
    case "failed":
      return status === "failed" || status === "unknown" || status === "interrupted";
    case "declined":
      return status === "declined";
    case "inflight":
      return LIVE_SPIN.has(status);
  }
}

export function ActionsView({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [chainFilter, setChainFilter] = useState<ChainFilter>("all");
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [exported, setExported] = useState(false);
  const [exportedCsv, setExportedCsv] = useState(false);
  // R24: per-row check-attestation results, keyed by action row id.
  const [attestChecks, setAttestChecks] = useState<Record<string, AttestCheck>>({});
  // R23: range filter with its time anchor captured in the SELECT handler (a
  // user event — the only place Date.now() is allowed) rather than per render:
  // the cutoff stays stable for the session, rows don't flicker in/out of the
  // window as time passes, and the filter memo remains pure.
  const [range, setRange] = useState<{ filter: RangeFilter; anchor: number }>({ filter: "all", anchor: 0 });
  const selectRange = useCallback((r: RangeFilter) => {
    setRange(r === "all" ? { filter: "all", anchor: 0 } : { filter: r, anchor: Date.now() });
  }, []);
  // R28: chip-row focus refs for the roving-tabindex keyboard navigation.
  const statusRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const rangeRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // R24: read-only proof lookup for one action row's tx — same endpoint and
  // timeout budget as use-attestation-for-tx, but user-triggered (no polling:
  // the answer is displayed inline, the button re-runs it on demand).
  const checkAttestation = useCallback(async (rowId: string, chainId: number | null, txHash: string) => {
    const fail = (state: Extract<AttestCheck, { phase: "done" }>["state"]) =>
      setAttestChecks((p) => ({ ...p, [rowId]: { phase: "done", state, checkedAt: Date.now() } }));
    if (chainId == null) {
      fail("unsupported");
      return;
    }
    setAttestChecks((p) => ({ ...p, [rowId]: { phase: "checking" } }));
    try {
      const res = await fetch(`/api/attestcoin/proof?evmChainId=${chainId}&txHash=${txHash}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(ATTEST_CHECK_TIMEOUT_MS),
      });
      if (res.status === 404) {
        const body = (await res.json().catch(() => ({}))) as { state?: string };
        if (body.state === "unsupported") {
          fail("unsupported");
          return;
        }
      }
      if (!res.ok) {
        fail("error");
        return;
      }
      const data = (await res.json()) as {
        state: "proof" | "pending" | "unknown_tx" | "error";
        proof?: { merkleRoot: string };
        onchain?: { verified: boolean };
      };
      setAttestChecks((p) => ({
        ...p,
        [rowId]: {
          phase: "done",
          state: data.state,
          merkleRoot: data.proof?.merkleRoot,
          onchainVerified: data.onchain?.verified,
          checkedAt: Date.now(),
        },
      }));
    } catch {
      fail("error");
    }
  }, []);

  // Live lifecycle overlay (C3): executor-driven transitions re-render rows
  // instantly and nudge the API query to refetch the persisted state.
  const liveEntries = useTxLifecycle((st) => st.entries);
  const liveCount = Object.keys(liveEntries).length;
  useEffect(() => {
    if (liveCount > 0) void queryClient.invalidateQueries({ queryKey: ["agent-action-log"] });
  }, [liveCount, queryClient]);
  const liveByCall = useMemo(() => {
    const m = new Map<string, { status: string; txHash?: string; chainId?: number; error?: string }>();
    for (const e of Object.values(liveEntries)) {
      if (e.status === "requested") m.set(e.callId, { status: "awaiting_signature" });
      else if (e.status === "signed" || e.status === "broadcast")
        m.set(e.callId, { status: "broadcast", txHash: e.txHash, chainId: e.chainId });
      else if (e.status === "confirmed") m.set(e.callId, { status: "succeeded", txHash: e.txHash, chainId: e.chainId });
      else if (e.status === "rejected") m.set(e.callId, { status: "declined" });
      else if (e.status === "timeout") m.set(e.callId, { status: "failed", error: "timeout" });
      else if (e.status === "unknown") m.set(e.callId, { status: "unknown", txHash: e.txHash, chainId: e.chainId });
      else if (e.status === "failed") m.set(e.callId, { status: "failed" });
    }
    return m;
  }, [liveEntries]);

  // L7 fix ("Actions tab not working"): the old query destructured ONLY
  // `data` — a fetch error (500, DB locked, network) rendered the exact same
  // "The agent hasn't taken any actions yet" empty-state as a healthy empty
  // log, and the first paint flashed that text before data landed. Now:
  // loading → skeleton rows; error → honest error line + retry button;
  // empty only on a SUCCESSFUL fetch with zero rows.
  const { data, isError, error, isLoading, refetch } = useQuery<ActionsFeed & { fetchedAt?: number }>({
    queryKey: ["agent-action-log"],
    queryFn: async () => {
      const res = await fetch(`/api/agent/actions?limit=${compact ? 15 : 60}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`action log fetch failed (${res.status})`);
      const json = (await res.json()) as ActionsFeed;
      // R23: anchor time-of-observation at fetch (async context) so the range
      // memo below stays pure for react-compiler — re-anchored every refetch,
      // which is exactly the cadence the chips should follow.
      return { ...json, fetchedAt: Date.now() };
    },
    refetchInterval: compact ? 20_000 : 8_000,
    // Keep polling while the tab is visible; the refetch below is manual.
    retry: 1,
  });

  const actions = useMemo(() => data?.actions ?? [], [data]);
  // N27.1: CC3 explorer deep links (server-side environment truth).
  const cc3Env = data?.cc3Env;

  // R21 (round-3 feature): per-chain filter chips. Chains are derived from
  // the log itself (row chainId ∪ live-overlay chainId) so the chips always
  // reflect reality, never a static registry guess; sorted by activity share.
  const chains = useMemo(() => {
    const counts = new Map<number, number>();
    for (const a of actions) {
      const live = a.callId ? liveByCall.get(a.callId) : undefined;
      const id = live?.chainId ?? a.chainId;
      if (id != null) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0]);
  }, [actions, liveByCall]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const cutoff = range.filter === "all" ? 0 : range.anchor - RANGE_MS[range.filter];
    return actions.filter((a) => {
      const live = a.callId ? liveByCall.get(a.callId) : undefined;
      const rowStatus = live?.status ?? a.status;
      if (!statusMatchesFilter(rowStatus, filter)) return false;
      if (chainFilter !== "all") {
        const rowChain = live?.chainId ?? a.chainId;
        if (rowChain !== chainFilter) return false;
      }
      if (cutoff > 0 && a.createdAt < cutoff) return false;
      if (!q) return true;
      const hay = [
        a.tool,
        rowStatus,
        a.result?.summary ?? "",
        a.result?.txHash ?? "",
        a.sourceTxHash ?? "",
        a.cc3TxHash ?? "",
        a.attestRoot ?? "",
        a.params ? JSON.stringify(a.params) : "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [actions, search, filter, chainFilter, range, liveByCall]);

  // R23: only offer time-window chips when the log actually spans more than
  // the tightest window (a log where everything is <24h old needs no range
  // dimension — same "only when meaningful" rule as the chain chips). The
  // observation time is the fetch anchor (data.fetchedAt), never render time.
  const showRangeChips = useMemo(() => {
    const at = data?.fetchedAt ?? 0;
    return at > 0 && actions.some((a) => at - a.createdAt > RANGE_MS["24h"]);
  }, [actions, data?.fetchedAt]);

  /** Export the full log (up to the API's 200-row max) as a JSON audit file. */
  const exportLog = async () => {
    try {
      const res = await fetch("/api/agent/actions?limit=200", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { actions: ActionRow[] };
      const payload = {
        acpActionLog: 1,
        exportedAt: new Date().toISOString(),
        actions: json.actions,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `acp-action-log-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExported(true);
      setTimeout(() => setExported(false), 1500);
    } catch {
      // no-op — export is best-effort
    }
  };

  /** R21 (round-3 feature): CSV export of the same 200-row audit window —
   * spreadsheet-friendly for compliance review. RFC 4180 escaping: fields
   * containing commas, quotes or newlines are quoted with doubled quotes. */
  const exportCsv = async () => {
    try {
      const res = await fetch("/api/agent/actions?limit=200", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { actions: ActionRow[] };
      const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, "\"\"")}"` : v);
      const header = [
        "time_iso",
        "tool",
        "status",
        "chain",
        "chain_id",
        "risk",
        "confirmation_required",
        "source_tx",
        "cc3_tx",
        "attest_root",
        "run_id",
        "call_id",
        "summary",
      ].join(",");
      const rows = json.actions.map((a) => {
        const chain = a.chainId != null ? getChainByChainId(a.chainId) : undefined;
        return [
          new Date(a.createdAt).toISOString(),
          a.tool,
          a.status,
          chain?.shortName ?? "",
          a.chainId != null ? String(a.chainId) : "",
          a.riskClass ?? "",
          a.confirmationRequired ? "yes" : "no",
          a.sourceTxHash ?? "",
          a.cc3TxHash ?? "",
          a.attestRoot ?? "",
          a.runId ?? "",
          a.callId ?? "",
          a.result?.summary ?? "",
        ]
          .map(cell)
          .join(",");
      });
      // BOM so Excel infers UTF-8 when summaries carry CJK text.
      const blob = new Blob(["\uFEFF" + header + "\n" + rows.join("\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `acp-action-log-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportedCsv(true);
      setTimeout(() => setExportedCsv(false), 1500);
    } catch {
      // no-op — export is best-effort
    }
  };

  const stats = useMemo(() => {
    let succeeded = 0;
    let inflight = 0;
    let failed = 0;
    for (const a of actions) {
      const live = a.callId ? liveByCall.get(a.callId) : undefined;
      const st = live?.status ?? a.status;
      if (st === "succeeded") succeeded++;
      else if (LIVE_SPIN.has(st)) inflight++;
      else if (st === "failed" || st === "unknown" || st === "interrupted" || st === "declined") failed++;
    }
    return { succeeded, inflight, failed, total: actions.length };
  }, [actions, liveByCall]);

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Clock className="h-4 w-4 text-muted" aria-hidden />
        <h2 className="text-sm font-semibold text-foreground">{t("actions.title")}</h2>
        {stats.total > 0 ? (
          <span className="flex items-center gap-2 text-[10px] text-muted-2">
            <span className="rounded-md bg-success/10 px-1.5 py-0.5 font-semibold text-success">{stats.succeeded} {t("actions.status.succeeded")}</span>
            {stats.inflight > 0 ? (
              <span className="flex items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 font-semibold text-primary">
                <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden />
                {stats.inflight} {t("actions.filterInflight")}
              </span>
            ) : null}
            {stats.failed > 0 ? (
              <span className="rounded-md bg-danger/10 px-1.5 py-0.5 font-semibold text-danger">{stats.failed}</span>
            ) : null}
          </span>
        ) : (
          <span className="text-[11px] text-muted">{t("actions.subtitle")}</span>
        )}
        {actions.length > 0 ? (
          <div
            role="group"
            aria-label={t("actions.exportGroup")}
            className="ml-auto flex items-center overflow-hidden rounded-lg border border-foreground/10"
          >
            <button
              type="button"
              onClick={() => void exportLog()}
              className="hit-slop flex h-8 w-8 items-center justify-center text-muted-2 transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
              title={t("actions.export")}
              aria-label={t("actions.export")}
            >
              {exported ? <Check className="h-3.5 w-3.5 text-success" aria-hidden /> : <Download className="h-3.5 w-3.5" aria-hidden />}
            </button>
            <span aria-hidden className="h-4 w-px bg-foreground/10" />
            <button
              type="button"
              onClick={() => void exportCsv()}
              className="hit-slop flex h-8 w-8 items-center justify-center text-muted-2 transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
              title={t("actions.exportCsv")}
              aria-label={t("actions.exportCsv")}
            >
              {exportedCsv ? <Check className="h-3.5 w-3.5 text-success" aria-hidden /> : <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden />}
            </button>
          </div>
        ) : null}
      </div>

      {!compact ? (
        <div className="mb-3 space-y-2.5">
          <FinderSearch
            value={search}
            onChange={setSearch}
            placeholder={t("actions.searchPlaceholder")}
            ariaLabel={t("actions.searchPlaceholder")}
          />
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("actions.statusGroup")}>
            {STATUS_FILTERS.map((f, i) => (
              <button
                key={f.value}
                type="button"
                ref={(el) => {
                  statusRefs.current[i] = el;
                }}
                tabIndex={filter === f.value ? 0 : -1}
                onKeyDown={(e) => rovingKeydown(e, i, STATUS_FILTERS.length, statusRefs)}
                onClick={() => setFilter(f.value)}
                aria-pressed={filter === f.value}
                className={cn(
                  "flex min-h-9 items-center rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60",
                  filter === f.value
                    ? "bg-primary/15 text-primary ring-1 ring-inset ring-primary/30"
                    : "glass-item text-muted hover:text-foreground",
                )}
              >
                {t(f.key as never)}
              </button>
            ))}
          </div>
          {/* R21: per-chain filter chips — only when the log actually spans
           * 2+ chains (a single-chain log needs no chain dimension). Chip
           * colors mirror the rows: amber = testnet, emerald = mainnet. */}
          {chains.length >= 2 ? (
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("actions.allChains")}>
              <button
                type="button"
                onClick={() => setChainFilter("all")}
                aria-pressed={chainFilter === "all"}
                className={cn(
                  "flex min-h-8 items-center rounded-lg px-2.5 py-1 text-[11px] font-medium transition-all duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60",
                  chainFilter === "all"
                    ? "bg-foreground/10 text-foreground ring-1 ring-inset ring-foreground/20"
                    : "glass-item text-muted-2 hover:text-foreground",
                )}
              >
                {t("actions.allChains")}
              </button>
              {chains.map(([id, count]) => {
                const chain = getChainByChainId(id);
                if (!chain) return null;
                const active = chainFilter === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setChainFilter(active ? "all" : id)}
                    aria-pressed={active}
                    title={chain.name}
                    className={cn(
                      "flex min-h-8 items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-all duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60",
                      chain.testnet ? "text-amber-600 dark:text-amber-300" : "text-emerald-600 dark:text-emerald-300",
                      active
                        ? chain.testnet
                          ? "bg-amber-500/15 ring-1 ring-inset ring-amber-500/30"
                          : "bg-emerald-500/15 ring-1 ring-inset ring-emerald-500/30"
                        : "glass-item hover:bg-foreground/[0.06]",
                    )}
                  >
                    {chain.shortName}
                    <span className={cn("text-[9px] font-semibold", active ? "opacity-80" : "opacity-50")}>{count}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
          {/* R23: time-window chips — only when the log actually spans more
           * than 24h (a fresh log needs no range dimension). Same chip
           * language as the status/chain filters. */}
          {showRangeChips ? (
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("actions.rangeGroup")}>
              {RANGE_FILTERS.map((r, i) => {
                const active = range.filter === r.value;
                return (
                  <button
                    key={r.value}
                    type="button"
                    ref={(el) => {
                      rangeRefs.current[i] = el;
                    }}
                    tabIndex={active ? 0 : -1}
                    onKeyDown={(e) => rovingKeydown(e, i, RANGE_FILTERS.length, rangeRefs)}
                    onClick={() => selectRange(r.value)}
                    aria-pressed={active}
                    className={cn(
                      "flex min-h-8 items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-all duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60",
                      active
                        ? "bg-foreground/10 text-foreground ring-1 ring-inset ring-foreground/20"
                        : "glass-item text-muted-2 hover:text-foreground",
                    )}
                  >
                    {r.value !== "all" ? <Clock className="h-2.5 w-2.5 opacity-60" aria-hidden /> : null}
                    {t(r.key as never)}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}

      {(isError) ? (
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <ShieldAlert className="h-4 w-4 text-warning" aria-hidden />
          <p className="text-xs text-muted-2">{t("chat.errorEncountered", { error: error instanceof Error ? error.message : "fetch failed" })}</p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="hit-slop mt-1 flex min-h-9 cursor-pointer items-center rounded-lg bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary ring-1 ring-inset ring-primary/30 transition-colors hover:bg-primary/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            <Loader2 className="mr-1.5 h-3 w-3" aria-hidden />
            {t("actions.retry")}
          </button>
        </div>
      ) : (isLoading && !data) ? (
        // L7: skeleton rows while the first fetch is in flight — no empty-state
        // flash, no layout jump when data lands. S8: staggered pulse delays
        // (organic shimmer instead of lockstep blinking).
        <div className="space-y-1.5" aria-busy="true" aria-label={t("actions.title")}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="relative overflow-hidden rounded-xl border border-foreground/10 bg-foreground/[0.03] px-3 py-2 pl-4">
              <span aria-hidden className="absolute bottom-2 left-1 top-2 w-[3px] rounded-full bg-foreground/10" />
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-foreground/15" style={{ animation: `pulse 1.6s ease-in-out ${(i * 0.18).toFixed(2)}s infinite` }} />
                <div className="h-3 w-20 rounded-md bg-foreground/10" style={{ animation: `pulse 1.6s ease-in-out ${(i * 0.18 + 0.06).toFixed(2)}s infinite` }} />
                <div className="h-3 w-28 rounded-md bg-foreground/10" style={{ animation: `pulse 1.6s ease-in-out ${(i * 0.18 + 0.12).toFixed(2)}s infinite` }} />
                <div className="ml-auto h-2.5 w-10 rounded-md bg-foreground/10" style={{ animation: `pulse 1.6s ease-in-out ${(i * 0.18 + 0.18).toFixed(2)}s infinite` }} />
              </div>
              <div className="mt-2 h-2.5 w-3/4 rounded-md bg-foreground/[0.07]" style={{ animation: `pulse 1.6s ease-in-out ${(i * 0.18 + 0.24).toFixed(2)}s infinite` }} />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        actions.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-2">{t("actions.empty")}</p>
        ) : (
          <div className="flex flex-col items-center gap-2 py-4 text-center">
            <p className="text-xs text-muted-2">{t("actions.noMatches")}</p>
            {/* R21: one-tap recovery from an over-narrow filter combination —
             * resets search, status filter and chain filter together. */}
            <button
              type="button"
              onClick={() => {
                setSearch("");
                setFilter("all");
                setChainFilter("all");
                setRange({ filter: "all", anchor: 0 });
              }}
              className="hit-slop mt-1 flex min-h-9 cursor-pointer items-center gap-1.5 rounded-lg glass-item px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
            >
              <X className="h-3 w-3" aria-hidden />
              {t("actions.clearFilters")}
            </button>
          </div>
        )
      ) : (
        <div>
          {/* R21: filter-narrowing indicator — only surfaces when search or
           * filters actually hide rows, always with the one-tap reset. */}
          {filtered.length < actions.length && !compact ? (
            <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
              <span className="text-[10px] text-muted-2" aria-live="polite">
                {t("actions.showing", { shown: String(filtered.length), total: String(actions.length) })}
              </span>
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  setFilter("all");
                  setChainFilter("all");
                  setRange({ filter: "all", anchor: 0 });
                }}
                className="hit-slop flex min-h-7 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[10px] font-medium text-muted-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
              >
                <X className="h-2.5 w-2.5" aria-hidden />
                {t("actions.clearFilters")}
              </button>
            </div>
          ) : null}
          <div className={cn("acp-scroll space-y-1.5 overflow-y-auto pr-1", compact ? "max-h-80" : "max-h-[60vh]")} aria-live="polite">
          {filtered.map((a, i) => {
            const live = a.callId ? liveByCall.get(a.callId) : undefined;
            const rowStatus = live?.status ?? a.status;
            const rowTxHash = a.result?.txHash ?? live?.txHash;
            const rowChainId = live?.chainId ?? a.chainId;
            const chain = rowChainId ? getChainByChainId(rowChainId) : undefined;
            const explorer = rowTxHash && chain?.explorerUrl ? `${chain.explorerUrl}/tx/${rowTxHash}` : null;
            const isLive = LIVE_SPIN.has(rowStatus);
            const isExpanded = expandedId === a.id;
            const hasDetail = Boolean(a.params || a.cc3TxHash || a.attestRoot || a.sourceTxHash || a.runId);
            return (
              <motion.div
                key={a.id}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: Math.min(i * 0.03, 0.25), duration: 0.2 }}
                className={cn(
                  "relative rounded-xl border border-foreground/10 bg-foreground/[0.03] px-3 py-2 pl-4 transition-colors",
                  isLive && "border-primary/25 bg-primary/[0.04]",
                  rowStatus === "unknown" && "border-warning/30 bg-warning/[0.05]",
                  hasDetail && "cursor-pointer hover:border-foreground/20",
                )}
                onClick={hasDetail ? () => setExpandedId(isExpanded ? null : a.id) : undefined}
                role={hasDetail ? "button" : undefined}
                aria-expanded={hasDetail ? isExpanded : undefined}
              >
                {/* S8: status accent bar — scannable audit trail at a glance. */}
                <span
                  aria-hidden
                  className={cn(
                    "absolute bottom-2 left-1 top-2 w-[3px] rounded-full transition-colors",
                    STATUS_ACCENT[rowStatus] ?? "bg-muted-2/30",
                    isLive && "animate-pulse",
                  )}
                />
                <div className="flex items-center gap-2">
                  {isLive ? (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" aria-hidden />
                  ) : (
                    <span
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        rowStatus === "succeeded" ? "bg-success/70"
                        : rowStatus === "failed" || rowStatus === "unknown" ? "bg-danger/70"
                        : rowStatus === "declined" ? "bg-muted-2/60"
                        : "bg-muted-2/40",
                      )}
                      aria-hidden
                    />
                  )}
                  <span
                    className={cn(
                      "rounded-md px-1.5 py-0.5 text-[10px] font-semibold",
                      STATUS_STYLE[rowStatus] ?? "text-muted-2 bg-surface-2",
                    )}
                  >
                    {t(`actions.status.${rowStatus}` as never)}
                  </span>
                  <span className="text-xs font-medium text-foreground/90">{t(`trace.tool${toolLabel(a.tool)}` as never)}</span>
                  {chain ? (
                    <span className={cn("hidden text-[10px] font-medium sm:inline", chain.testnet ? "text-amber-600 dark:text-amber-300" : "text-emerald-600 dark:text-emerald-300")}>
                      {chain.shortName}
                    </span>
                  ) : null}
                  {a.confirmationRequired ? (
                    <span title={t("actions.confirmationAsked")} className="flex items-center">
                      <ShieldAlert className="h-3 w-3 text-warning/70" aria-hidden />
                    </span>
                  ) : null}
                  <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-2">
                    <time dateTime={new Date(a.createdAt).toISOString()} title={new Date(a.createdAt).toLocaleString()}>
                      {timeShort(a.createdAt)}
                    </time>
                    {hasDetail ? (
                      <ChevronDown
                        className={cn("h-3 w-3 transition-transform", isExpanded && "rotate-180")}
                        aria-hidden
                      />
                    ) : null}
                  </span>
                </div>
                {a.result?.summary ? (
                  <p className={cn("mt-1 wrap-anywhere break-words text-[11px] leading-relaxed text-muted", !isExpanded && "line-clamp-2")}>
                    {a.result.summary}
                  </p>
                ) : null}
                {(rowTxHash || a.cc3TxHash || a.attestRoot) ? (
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
                    {rowTxHash ? (
                      <span className="flex items-center font-mono text-foreground/40">
                        {chain?.shortName ?? ""} {rowTxHash.slice(0, 10)}…{rowTxHash.slice(-4)}
                        <CopyRef value={rowTxHash} label={t("actions.copyTx")} />
                      </span>
                    ) : null}
                    {a.cc3TxHash ? (
                      (() => {
                        const cc3Url = cc3ExplorerTxUrl(cc3Env, a.cc3TxHash);
                        const label = (
                          <>
                            <CircleDot className="h-2.5 w-2.5" aria-hidden />
                            CC {a.cc3TxHash.slice(0, 8)}…{a.cc3TxHash.slice(-4)}
                          </>
                        );
                        return (
                          <span className="flex items-center">
                            {cc3Url ? (
                              <a
                                href={cc3Url}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                title={t("actions.cc3ExplorerTip")}
                                className="inline-flex items-center gap-0.5 font-mono text-primary/70 underline decoration-primary/30 underline-offset-2 hover:text-primary hover:decoration-primary"
                              >
                                {label}
                              </a>
                            ) : (
                              <span className="flex items-center gap-0.5 font-mono text-primary/70">{label}</span>
                            )}
                            <CopyRef value={a.cc3TxHash} label={t("actions.copyTx")} />
                          </span>
                        );
                      })()
                    ) : null}
                    {a.attestRoot ? (
                      <span className="flex items-center font-mono text-foreground/40" title={a.attestRoot}>
                        ⬡ {a.attestRoot.slice(0, 8)}…
                        {/* R27: the attest root was tooltip-only — now one tap
                         * to clipboard, same CopyRef pattern as the tx chips. */}
                        <CopyRef value={a.attestRoot} label={t("actions.detailRoot")} />
                      </span>
                    ) : null}
                    {explorer ? (
                      <a
                        href={explorer}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-0.5 text-primary hover:text-primary-hover"
                      >
                        <ExternalLink className="h-2.5 w-2.5" aria-hidden />
                        {t("trace.explorer")}
                      </a>
                    ) : null}
                    {/* R24: one-tap read-only attestation check for rows carrying
                     * a settled/terminal tx — answers "did it get attested?" in
                     * place. Live rows skip it (the tx isn't final yet). */}
                    {rowTxHash && !isLive ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void checkAttestation(a.id, rowChainId ?? null, rowTxHash);
                        }}
                        className="hit-slop inline-flex min-h-7 cursor-pointer items-center gap-0.5 rounded-md px-1.5 text-[10px] font-medium text-primary/70 transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                        title={t("actions.checkAttestationTip")}
                      >
                        <ShieldQuestion className="h-2.5 w-2.5" aria-hidden />
                        {attestChecks[a.id]?.phase === "checking" ? t("payments.attestVerifying") : t("actions.checkAttestation")}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {/* R24: inline check result — the shared AttestStatePill language
                 * (same as the payments attestation card) plus the concrete
                 * artifacts: merkle root short + on-chain precompile verdict. */}
                {(() => {
                  const check = attestChecks[a.id];
                  if (!check || check.phase === "checking") return null;
                  const pillState =
                    check.state === "proof" ? "proof"
                    : check.state === "pending" ? "pending"
                    : check.state === "unknown_tx" ? "unknown_tx"
                    : "error";
                  return (
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px]" aria-live="polite">
                      <AttestStatePill state={pillState} size="xs" />
                      {check.state === "proof" && check.merkleRoot ? (
                        <span className="flex items-center gap-0.5 font-mono text-foreground/40" title={check.merkleRoot}>
                          ⬡ {check.merkleRoot.slice(0, 8)}…
                          {/* R27: copy the full merkle root straight from the
                           * check result — it was tooltip-only before. */}
                          <CopyRef value={check.merkleRoot} label={t("actions.detailRoot")} />
                          {check.onchainVerified === true ? (
                            <span className="font-sans font-semibold text-success" title={t("actions.onchainVerified")}>
                              ✓ {t("actions.onchainVerified")}
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                      {check.state === "unsupported" ? (
                        <span className="text-muted-2">{t("actions.chainUntracked")}</span>
                      ) : null}
                      <span className="text-muted-2/70">
                        <time dateTime={new Date(check.checkedAt).toISOString()}>{timeShort(check.checkedAt)}</time>
                      </span>
                    </div>
                  );
                })()}
                {/* Expanded detail (C7): params, refs, timestamps — the full story. */}
                <AnimatePresence initial={false}>
                  {isExpanded ? (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.18 }}
                      className="overflow-hidden"
                    >
                      <div className="mt-2 space-y-1.5 rounded-lg border border-foreground/10 bg-foreground/[0.03] p-2.5 text-[10px]">
                        <DetailLine label={t("actions.detailTime")} value={new Date(a.createdAt).toLocaleString()} />
                        {a.runId ? <DetailLine label={t("actions.detailRun")} value={a.runId} mono copyValue={a.runId} /> : null}
                        {a.callId ? <DetailLine label={t("actions.detailCall")} value={a.callId} mono copyValue={a.callId} /> : null}
                        {a.sourceTxHash ? (
                          (() => {
                            const srcUrl = sourceExplorerTxUrl(a.chainId, a.sourceTxHash);
                            if (!srcUrl) return <DetailLine label={t("actions.detailSourceTx")} value={a.sourceTxHash} mono copyValue={a.sourceTxHash} />;
                            return (
                              <p className="flex items-baseline justify-between gap-3">
                                <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wider text-foreground/30">{t("actions.detailSourceTx")}</span>
                                <span className="flex min-w-0 items-center gap-0.5">
                                  <a
                                    href={srcUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex min-w-0 items-center gap-1 truncate font-mono text-primary/80 underline decoration-primary/30 underline-offset-2 hover:text-primary"
                                  >
                                    {a.sourceTxHash}
                                    <ExternalLink className="h-2.5 w-2.5 shrink-0" aria-hidden />
                                  </a>
                                  <CopyRef value={a.sourceTxHash} label={t("actions.copyTx")} />
                                </span>
                              </p>
                            );
                          })()
                        ) : null}
                        {a.cc3TxHash ? <DetailLine label={t("actions.detailCc3Tx")} value={a.cc3TxHash} mono copyValue={a.cc3TxHash} /> : null}
                        {a.attestRoot ? <DetailLine label={t("actions.detailRoot")} value={a.attestRoot} mono copyValue={a.attestRoot} /> : null}
                        {a.riskClass ? <DetailLine label={t("actions.detailRisk")} value={a.riskClass} /> : null}
                        {a.params ? (
                          <div>
                            <p className="mb-0.5 text-[9px] font-semibold uppercase tracking-wider text-foreground/30">{t("actions.detailParams")}</p>
                            <pre className="acp-scroll max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md p-1.5 code-surface font-mono text-[9px] leading-relaxed text-foreground/60">
                              {JSON.stringify(a.params, null, 1)}
                            </pre>
                          </div>
                        ) : null}
                      </div>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </motion.div>
            );
          })}
          </div>
        </div>
      )}
    </Card>
  );
}

function DetailLine({ label, value, mono, copyValue }: { label: string; value: string; mono?: boolean; copyValue?: string }) {
  return (
    <p className="flex items-center justify-between gap-3">
      <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wider text-foreground/30">{label}</span>
      <span className={cn("flex min-w-0 items-center gap-0.5 text-right text-foreground/60", mono && "font-mono")}>
        <span className="truncate">{value}</span>
        {/* CopyRef defaults to the localized trace.copy aria-label. */}
        {copyValue ? <CopyRef value={copyValue} /> : null}
      </span>
    </p>
  );
}

function toolLabel(tool: string): string {
  const map: Record<string, string> = {
    get_balances: "Balances",
    get_transaction_status: "TxStatus",
    check_attestation_status: "CheckAttestation",
    wait_for_attestation: "WaitAttestation",
    attestcoin_network_status: "AttestcoinStatus",
    list_contacts: "Contacts",
    create_contact: "SaveContact",
    list_chains: "Chains",
    list_recent_actions: "Actions",
    get_app_status: "AppStatus",
    transfer: "Transfer",
    batch_transfer: "Batch",
    deploy_contract: "Deploy",
    create_conditional_release: "Escrow",
    execute_conditional_release: "Release",
    cross_chain_swap: "Swap",
    create_recurring_payment: "Recurring",
    list_recurring_payments: "ListRecurring",
    cancel_recurring_payment: "CancelRecurring",
    recurring_payment: "Recurring",
    automation_rule: "Automation",
    create_automation_rule: "NewAutomation",
    update_automation_rule: "EditAutomation",
    delete_automation_rule: "DeleteAutomation",
    list_automation_rules: "ListAutomation",
    decode_source_transaction: "DecodeTx",
    verify_proof_readonly: "VerifyProof",
    estimate_verification_cost: "CostEstimate",
    get_attestation_bounds: "Bounds",
    submit_proof_onchain: "SubmitProof",
    // P24 app-level mutation rows (UI-initiated)
    payment_settle: "PaymentSettle",
    contact_create: "SaveContact",
    contact_update: "EditContact",
    contact_delete: "DeleteContact",
    recurring_create: "NewRecurring",
    recurring_update: "EditRecurring",
    recurring_delete: "DeleteRecurring",
    automation_create: "NewAutomation",
    automation_update: "EditAutomation",
    automation_delete: "DeleteAutomation",
    skill_create: "NewSkill",
    skill_update: "EditSkill",
    skill_delete: "DeleteSkill",
  };
  return map[tool] ?? "";
}

function timeShort(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`;
  return new Date(ts).toLocaleDateString();
}
